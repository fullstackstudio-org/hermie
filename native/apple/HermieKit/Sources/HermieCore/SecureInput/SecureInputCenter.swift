import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// Where the answer to one prompt is.
public enum SecureInputPhase: Sendable, Equatable {
  /// On its way; the sheet's controls are off.
  case sending
  /// It did not go out (the socket that delivered the prompt is gone). The
  /// prompt is still open; sending again uses the copy the gateway re-delivers
  /// after the reconnect.
  case failed
}

/// A short line on a chat about a prompt that ended without the person's answer,
/// or one this app could not show.
public enum SecureInputNotice: Sendable, Equatable {
  /// The gateway stopped waiting (its own deadline passed), so nothing was sent.
  case expired
  /// The bot stopped asking (the turn was interrupted, the session closed, or
  /// the chat let go of the session), so nothing was sent.
  case withdrawn
  /// The gateway stopped waiting while the answer was on its way: it may not
  /// have arrived in time.
  case mayNotHaveArrived
  /// The bot asked for something this app cannot show: `method`, cleaned and
  /// bounded for display.
  case unsupported(method: String)
}

/// One notice on one chat, with a serial so the same notice twice is shown twice.
public struct SecureInputNoticeEntry: Sendable, Equatable, Identifiable {
  public var notice: SecureInputNotice
  /// The request it is about.
  public var requestID: String
  public var serial: Int
  public var id: Int { serial }
}

/// The one-string prompts of one gateway (`secret`, `sudo`, `vault.*`), from
/// the moment they arrive until they are answered, skipped, expired or withdrawn.
///
/// # Why a consumer of its own
///
/// The value a person types for one of these must never reach the transcript
/// engine, the chat cache, drafts or logs. So these requests never go through
/// `TranscriptStore` (which leaves them alone) or the reducer: this center
/// subscribes to the link's server requests itself, holds what was asked (never
/// what is answered), and sends the answer straight back on the request's own
/// reply. It also hears the requests this app cannot show (the connection has
/// already declined them with `-32601`) and leaves a notice on their chat.
///
/// Both streams are read off the main actor: a request's texts are cleaned and
/// bounded there (`SecurePrompt.displayText`), and of the events only
/// `request.cancel` hops to the main actor.
///
/// # Routing
///
/// A prompt belongs to the chat whose runtime session is the request's
/// `session_id` (`TranscriptStore.chatKey(forRuntime:)`). One for a session no
/// chat holds yet waits, bounded in number and in time (`Options`), for a resume
/// to bind it: a reconnect re-delivers open requests before the resume that
/// binds their session returns. One still unclaimed when its time is up is
/// declined with `-32601`; another client may own it. When its session moves
/// to another chat, the prompt moves with it.
///
/// # Ending
///
/// Every delivery is answered at most once. A prompt whose session no chat
/// holds any more (a rebind, `/new`, the bot leaving the roster) is answered
/// `''` with a "withdrawn" notice, and every one still open at `shutdown`
/// (sign-out, switching gateways) is answered `''` before the socket closes.
/// One the gateway stopped waiting for is closed with a notice and never
/// answered: its deadline or its `request.cancel`, whichever comes first. A
/// value typed after that is never sent.
///
/// # An answer that did not arrive
///
/// An answer goes out when its frame is queued on the socket; a socket that
/// dies before the gateway read it loses it. The gateway re-delivers every
/// request it still waits for once a new socket resumes, so a re-delivered copy
/// of a request this center already closed (for any reason but its
/// `request.cancel`) is the proof that the answer never arrived: the prompt
/// opens again and says so.
@MainActor
@Observable
public final class SecureInputCenter {
  public struct Options: Sendable {
    /// How long a prompt for a session no chat holds waits for one to.
    public var parkLimit: Duration = .seconds(15)
    /// How many such prompts wait at once; one more is declined at once.
    public var maxParked = 16
    /// How many notices about requests this app cannot show wait for their
    /// chat at once; one more drops the oldest.
    public var maxParkedNotices = 16
    /// How long `shutdown` waits for its last answers to reach the socket.
    public var flushLimit: Duration = .seconds(1)

    public init() {}
  }

  /// The gateway's name as the person knows it, for the sheet's chrome.
  public let gatewayName: String

  /// Every open prompt, oldest first.
  public private(set) var prompts: [SecurePrompt] = []
  /// Per request id: an answer on its way, or one that did not go out.
  public private(set) var phases: [String: SecureInputPhase] = [:]
  /// The last notice per chat key.
  public private(set) var notices: [String: SecureInputNoticeEntry] = [:]
  /// The last prompt answered, for a VoiceOver announcement.
  public private(set) var lastAnswered: AnsweredEntry?

  @ObservationIgnored let link: any GatewayLink
  @ObservationIgnored let store: TranscriptStore
  @ObservationIgnored let clock: any ConnectionClock
  @ObservationIgnored let options: Options
  /// Which chat holds a runtime session: the store's routes. A seam for the
  /// tests that force a lookup to wait.
  @ObservationIgnored var chatKey: @Sendable (String) async -> String?

  /// The newest delivery of each open prompt: its reply goes out over the
  /// socket that delivered it, and a reconnect re-delivers it on a new one.
  @ObservationIgnored private var handles: [String: InboundRequest] = [:]
  /// When each open or waiting prompt is closed here: the gateway's deadline,
  /// or for a re-delivered copy its arrival plus the method's timeout, which
  /// is never earlier than the gateway's own.
  @ObservationIgnored private var expiries: [String: Duration] = [:]
  @ObservationIgnored private var pending: [String: Pending] = [:]
  @ObservationIgnored private var parked: [String: Parked] = [:]
  @ObservationIgnored private var parkedNotices: [String: Parked] = [:]
  @ObservationIgnored private var parkedNoticeOrder: [String] = []
  @ObservationIgnored private var timers: [String: ScheduledTimer] = [:]
  @ObservationIgnored private var parkTimers: [String: ScheduledTimer] = [:]
  /// Ids that are done and why, oldest first. Bounded.
  @ObservationIgnored private var closed: [String: Closed] = [:]
  @ObservationIgnored private var closedOrder: [String] = []
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var revalidation: Task<Void, Never>?
  @ObservationIgnored private var revalidating = false
  @ObservationIgnored private var revalidateAgain = false
  @ObservationIgnored private var serial = 0
  @ObservationIgnored private var isShutDown = false

  /// A request, read off the main actor: its prompt (texts cleaned and
  /// bounded), or the method this app cannot show.
  struct Arrival: Sendable {
    var inbound: InboundRequest
    var kind: SecurePromptKind?
    var unsupportedMethod: String?
  }

  /// What a prompt waiting for its chat will be.
  private struct Pending {
    var kind: SecurePromptKind
    var deadline: Duration?
    var earlierAnswerLost: Bool
  }

  private struct Parked {
    var inbound: InboundRequest
    var sessionID: String
    /// For a notice: the method, cleaned.
    var method: String
  }

  /// Why an id is done.
  private enum CloseReason {
    /// An answer (a value or `''`) went out from here.
    case answered
    /// Closed here without the gateway saying so: its deadline, its chat let
    /// go of it, or it was declined.
    case closedHere
    /// The gateway withdrew it (`request.cancel`): it never asks again.
    case cancelled
    /// A request this app cannot show; its notice was shown.
    case notice
  }

  private struct Closed {
    var reason: CloseReason
    /// The deadline it had, for a copy that opens it again.
    var deadline: Duration?
  }

  private static let closedLimit = 512
  private static let skipped = ValueResult(value: "")

  public init(
    link: any GatewayLink,
    store: TranscriptStore,
    clock: any ConnectionClock,
    gatewayName: String,
    options: Options = Options()
  ) {
    self.link = link
    self.store = store
    self.clock = clock
    self.gatewayName = gatewayName
    self.options = options
    self.chatKey = { [weak store] session in await store?.chatKey(forRuntime: session) }
  }

  // MARK: - Lifecycle

  /// Subscribe to the link's server requests and events. Call before the
  /// connection starts, as the store does.
  public func attach() {
    guard tasks.isEmpty, !isShutDown else {
      return
    }

    let requests = link.serverRequests
    let events = link.events

    // Off the main actor: the texts are cleaned there, and the stream of
    // events (every token of every reply) never wakes the main actor.
    tasks.append(
      Task.detached { [weak self] in
        for await inbound in requests {
          let arrival = Self.read(inbound)
          await self?.ingest(arrival)
        }
      }
    )
    tasks.append(
      Task.detached { [weak self] in
        for await wire in events where wire.event.type == GatewayEventType.requestCancel {
          let payload = RequestCancelPayload(json: wire.event.payload?.objectValue ?? [:])
          await self?.withdraw(payload.id ?? "", reason: payload.reason ?? "")
        }
      }
    )
  }

  /// Read a request: what it asks, cleaned and bounded.
  nonisolated static func read(_ inbound: InboundRequest) -> Arrival {
    let body = inbound.body

    if case .unknown(let method, _) = body {
      return Arrival(
        inbound: inbound,
        kind: nil,
        unsupportedMethod: SecurePrompt.displayText(method, limit: SecurePrompt.nameLimit)
      )
    }

    return Arrival(inbound: inbound, kind: SecurePromptKind(body), unsupportedMethod: nil)
  }

  /// Answer every open prompt `''` (and decline every one still waiting for its
  /// chat), wait a bounded time for those answers to reach the socket, then
  /// stop. Call before the connection shuts down. Idempotent.
  public func shutdown() async {
    guard !isShutDown else {
      return
    }

    isShutDown = true

    let open = prompts.compactMap { prompt in handles[prompt.id].map { (prompt.id, $0) } }
    let waiting = parked

    for (id, _) in open {
      finish(id, .answered)
    }

    for id in waiting.keys {
      finish(id, .closedHere)
    }

    for id in Array(parkedNotices.keys) {
      dropNotice(id)
    }

    for (_, handle) in open {
      _ = await handle.respond(Self.skipped.json)
    }

    for (_, entry) in waiting {
      _ = await entry.inbound.declineUnowned()
    }

    if !open.isEmpty || !waiting.isEmpty {
      await link.flushWrites(within: options.flushLimit)
    }

    let running = tasks + [revalidation].compactMap { $0 }

    for task in running {
      task.cancel()
    }

    for task in running {
      await task.value
    }

    tasks.removeAll()
    revalidation = nil
  }

  /// How many prompts wait for their chat, for tests.
  var parkedCount: Int { parked.count }

  /// How many notices wait for their chat, for tests.
  var parkedNoticeCount: Int { parkedNotices.count }

  /// How many tasks are still running, for tests.
  var liveTaskCount: Int { tasks.count + (revalidating ? 1 : 0) }

  // MARK: - What the views read

  /// The open prompts of one chat, oldest first.
  public func prompts(for chatKey: String) -> [SecurePrompt] {
    prompts.filter { $0.chatKey == chatKey }
  }

  /// Whether a chat has a prompt waiting: the chat list's needs-input marker.
  public func needsInput(_ chatKey: String) -> Bool {
    prompts.contains { $0.chatKey == chatKey }
  }

  public func isOpen(_ id: String) -> Bool {
    prompts.contains { $0.id == id }
  }

  /// Whole seconds left before the gateway stops waiting, never below zero;
  /// nil when the deadline is not known.
  public func secondsLeft(_ id: String) -> Int? {
    guard let deadline = prompts.first(where: { $0.id == id })?.deadline else {
      return nil
    }

    let left = deadline - clock.now
    let seconds = Double(left.components.seconds) + Double(left.components.attoseconds) / 1e18
    return max(0, Int(seconds.rounded(.up)))
  }

  public func dismissNotice(_ chatKey: String) {
    notices[chatKey] = nil
  }

  // MARK: - Answering

  /// Answer a prompt with what the person typed (and, for a login, the
  /// identifier). Answers whether it went out. Nothing is sent for a prompt
  /// that is no longer open, whose deadline has passed, whose answer is
  /// already on its way, or that `value` cannot answer.
  @discardableResult
  public func send(_ id: String, value: SecretValue, identifier: String = "") async -> Bool {
    guard let prompt = prompts.first(where: { $0.id == id }), phases[id] != .sending else {
      return false
    }

    if let expiry = expiries[id], clock.now >= expiry {
      expire(id)
      return false
    }

    guard let text = prompt.answer(value, identifier: identifier) else {
      return false
    }

    return await deliver(id, ValueResult(value: text))
  }

  /// Skip: answer `''`. Answers whether it went out.
  @discardableResult
  public func skip(_ id: String) async -> Bool {
    guard isOpen(id), phases[id] != .sending else {
      return false
    }

    if let expiry = expiries[id], clock.now >= expiry {
      expire(id)
      return false
    }

    return await deliver(id, Self.skipped)
  }

  private func deliver(_ id: String, _ result: ValueResult) async -> Bool {
    guard let handle = handles[id] else {
      phases[id] = .failed
      return false
    }

    phases[id] = .sending
    let sent = await handle.respond(result.json)

    // Re-check after the suspension: the gateway may have withdrawn it, or its
    // chat let go of it, while the answer was in flight.
    guard isOpen(id) else {
      return sent
    }

    if sent {
      finish(id, .answered)
      serial += 1
      lastAnswered = AnsweredEntry(requestID: id, serial: serial)
      return true
    }

    if let expiry = expiries[id], clock.now >= expiry {
      phases[id] = nil
      expire(id)
    } else {
      phases[id] = .failed
    }

    return false
  }

  // MARK: - Arriving

  func ingest(_ arrival: Arrival) async {
    guard !isShutDown else {
      return
    }

    let inbound = arrival.inbound
    let id = inbound.id

    guard !id.isEmpty else {
      return
    }

    // A copy of a request already done.
    var reopening: Closed?

    if let done = closed[id] {
      // Only the gateway's re-delivery of a request it still waits for opens
      // it again, and never one it withdrew or one that was only a notice.
      guard inbound.replayed, done.reason == .answered || done.reason == .closedHere else {
        return
      }

      closed[id] = nil
      closedOrder.removeAll { $0 == id }
      reopening = done
    }

    let sessionID = inbound.request.sessionID ?? ""

    if let method = arrival.unsupportedMethod {
      // Already declined by the connection: say so on its chat, once.
      if parkedNotices[id] == nil {
        await routeNotice(inbound, sessionID: sessionID, method: method)
      }
      return
    }

    guard let kind = arrival.kind else {
      return
    }

    // A copy of a prompt already here: a reconnect re-delivered it, and its
    // reply now goes out over the new socket.
    if isOpen(id) {
      handles[id] = inbound

      if phases[id] == .failed {
        phases[id] = nil
      }
      return
    }

    if parked[id] != nil {
      parked[id]?.inbound = inbound
      return
    }

    guard !sessionID.isEmpty else {
      close(id, .closedHere)
      _ = await inbound.declineUnowned()
      return
    }

    // The gateway's clock started when it sent the request: for one that
    // arrives live, now. A re-delivered copy keeps the deadline its first copy
    // had; one first seen re-delivered shows no countdown and is closed here
    // at its arrival plus the method's timeout, never before the gateway's.
    let shown: Duration?
    let expiry: Duration

    if !inbound.replayed {
      shown = clock.now + kind.gatewayTimeout
      expiry = shown!
    } else if let known = reopening?.deadline {
      shown = known
      expiry = known
    } else {
      shown = nil
      expiry = clock.now + kind.gatewayTimeout
    }

    expiries[id] = expiry
    timers[id] = clock.schedule(after: max(expiry - clock.now, .zero)) { [weak self] in
      await self?.expire(id)
    }

    pending[id] = Pending(kind: kind, deadline: shown, earlierAnswerLost: reopening?.reason == .answered)
    await route(inbound, sessionID: sessionID)
  }

  /// Open it on its chat, or park it until one holds its session.
  private func route(_ inbound: InboundRequest, sessionID: String) async {
    let id = inbound.id
    let key = await chatKey(sessionID)

    // Re-check after the suspension: it may have been withdrawn, expired, or
    // the center shut down, meanwhile.
    guard !isShutDown, pending[id] != nil else {
      pending[id] = nil
      return
    }

    if let key {
      place(inbound, on: key)
      // The key was read before the suspension: a pass with a fresh one
      // confirms it (a rebind meanwhile found no prompt to move).
      revalidate()
      return
    }

    guard parked.count < options.maxParked else {
      finish(id, .closedHere)
      _ = await inbound.declineUnowned()
      return
    }

    parked[id] = Parked(inbound: inbound, sessionID: sessionID, method: inbound.method)
    parkTimers[id] = clock.schedule(after: options.parkLimit) { [weak self] in
      await self?.parkExpired(id)
    }

    revalidate()
  }

  /// A notice for a request this app cannot show: on its chat, or waiting for
  /// one, apart from the prompts (they never take a prompt's place).
  private func routeNotice(_ inbound: InboundRequest, sessionID: String, method: String) async {
    let id = inbound.id
    close(id, .notice)

    guard !sessionID.isEmpty else {
      return
    }

    let key = await chatKey(sessionID)

    guard !isShutDown else {
      return
    }

    if let key {
      show(.unsupported(method: method), id, on: key)
      return
    }

    if parkedNotices.count >= options.maxParkedNotices, let oldest = parkedNoticeOrder.first {
      dropNotice(oldest)
    }

    parkedNotices[id] = Parked(inbound: inbound, sessionID: sessionID, method: method)
    parkedNoticeOrder.append(id)
    timers[id] = clock.schedule(after: options.parkLimit) { [weak self] in
      await self?.dropNotice(id)
    }

    revalidate()
  }

  private func dropNotice(_ id: String) {
    parkedNotices[id] = nil
    parkedNoticeOrder.removeAll { $0 == id }
    timers.removeValue(forKey: id)?.cancel()
  }

  private func place(_ inbound: InboundRequest, on key: String) {
    let id = inbound.id

    guard let pending = pending.removeValue(forKey: id) else {
      return
    }

    parked[id] = nil
    parkTimers.removeValue(forKey: id)?.cancel()
    handles[id] = inbound
    prompts.append(
      SecurePrompt(
        id: id,
        method: inbound.method,
        kind: pending.kind,
        chatKey: key,
        sessionID: inbound.request.sessionID ?? "",
        deadline: pending.deadline,
        earlierAnswerLost: pending.earlierAnswerLost
      )
    )
  }

  private func parkExpired(_ id: String) async {
    guard let entry = parked[id] else {
      return
    }

    finish(id, .closedHere)
    _ = await entry.inbound.declineUnowned()
  }

  // MARK: - The chats moved on

  /// The store's chats changed (a frame went out): bind the prompts waiting
  /// for their chat, move the ones whose session moved, and let go of the ones
  /// whose session no chat holds. Coalesced: one pass at a time, and one more
  /// if asked meanwhile.
  public func storeChanged() {
    guard !prompts.isEmpty || !parked.isEmpty || !parkedNotices.isEmpty else {
      return
    }

    revalidate()
  }

  private func revalidate() {
    guard !isShutDown else {
      return
    }

    guard !revalidating else {
      revalidateAgain = true
      return
    }

    revalidating = true
    revalidation = Task { [weak self] in
      await self?.revalidatePass()
    }
  }

  private func revalidatePass() async {
    repeat {
      revalidateAgain = false
      // What this pass judges: the prompts and waiting entries here now, and
      // only by the keys it reads for their sessions. Anything that arrives
      // while it reads is left to the next pass (`route` asks for one).
      let judged = Set(prompts.map(\.id))
      let sessions = Set(
        prompts.map(\.sessionID) + parked.values.map(\.sessionID) + parkedNotices.values.map(\.sessionID))
      var keys: [String: String] = [:]

      for session in sessions {
        keys[session] = await chatKey(session)
      }

      // Re-check after the suspensions: work only on what is still here.
      guard !isShutDown else {
        break
      }

      for entry in parked.values where sessions.contains(entry.sessionID) {
        if let key = keys[entry.sessionID] {
          place(entry.inbound, on: key)
        }
      }

      for (id, entry) in parkedNotices where sessions.contains(entry.sessionID) {
        if let key = keys[entry.sessionID] {
          dropNotice(id)
          show(.unsupported(method: entry.method), id, on: key)
        }
      }

      var abandoned: [SecurePrompt] = []

      for (index, prompt) in prompts.enumerated()
      where judged.contains(prompt.id) && sessions.contains(prompt.sessionID) && phases[prompt.id] != .sending {
        if let key = keys[prompt.sessionID] {
          // Its session moved to another chat: the prompt goes with it.
          if key != prompt.chatKey {
            prompts[index].chatKey = key
          }
        } else {
          abandoned.append(prompt)
        }
      }

      for prompt in abandoned {
        let handle = handles[prompt.id]
        finish(prompt.id, .closedHere)
        show(.withdrawn, prompt.id, on: prompt.chatKey)
        // If this does not arrive, the gateway's re-delivery opens it again.
        _ = await handle?.respond(Self.skipped.json)
      }
    } while revalidateAgain && !isShutDown

    revalidating = false
  }

  // MARK: - The gateway stopped waiting

  /// `request.cancel`: the gateway withdrew a request. One with reason
  /// `timeout` reads as expired; any other as withdrawn; one whose answer was
  /// on its way may not have got there in time.
  func withdraw(_ id: String, reason: String) {
    guard !id.isEmpty else {
      return
    }

    if let prompt = prompts.first(where: { $0.id == id }) {
      let notice: SecureInputNotice =
        phases[id] == .sending ? .mayNotHaveArrived : reason == "timeout" ? .expired : .withdrawn
      finish(id, .cancelled)
      show(notice, id, on: prompt.chatKey)
      return
    }

    // Not here yet (the two streams race), waiting for its chat, or not a
    // prompt at all: whatever arrives with this id later is ignored.
    if parked[id] != nil || pending[id] != nil {
      finish(id, .cancelled)
    } else {
      close(id, .cancelled)
    }
  }

  /// The deadline passed: close it, send nothing.
  func expire(_ id: String) {
    guard phases[id] != .sending else {
      return
    }

    if let prompt = prompts.first(where: { $0.id == id }) {
      finish(id, .closedHere)
      show(.expired, id, on: prompt.chatKey)
    } else if parked[id] != nil || pending[id] != nil {
      finish(id, .closedHere)
    }
  }

  // MARK: - Bookkeeping

  /// Take a prompt out of every table, and remember it is done and why.
  private func finish(_ id: String, _ reason: CloseReason) {
    let deadline = prompts.first { $0.id == id }?.deadline ?? pending[id]?.deadline
    prompts.removeAll { $0.id == id }
    phases[id] = nil
    handles[id] = nil
    parked[id] = nil
    pending[id] = nil
    expiries[id] = nil
    timers.removeValue(forKey: id)?.cancel()
    parkTimers.removeValue(forKey: id)?.cancel()
    close(id, reason, deadline: deadline)
  }

  private func close(_ id: String, _ reason: CloseReason, deadline: Duration? = nil) {
    if closed[id] == nil {
      closedOrder.append(id)
    }

    closed[id] = Closed(reason: reason, deadline: deadline)

    if closedOrder.count > Self.closedLimit {
      closed[closedOrder.removeFirst()] = nil
    }
  }

  private func show(_ notice: SecureInputNotice, _ requestID: String, on key: String) {
    serial += 1
    notices[key] = SecureInputNoticeEntry(notice: notice, requestID: requestID, serial: serial)
  }
}
