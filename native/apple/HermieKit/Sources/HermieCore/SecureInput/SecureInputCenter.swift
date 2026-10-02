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
  /// The gateway withdrew it (the turn was interrupted, the session closed).
  case withdrawn
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
/// # Routing
///
/// A prompt belongs to the chat whose runtime session is the request's
/// `session_id` (`TranscriptStore.chatKey(forRuntime:)`). One for a session no
/// chat holds yet waits, bounded in number and in time (`Options`), for a resume
/// to bind it: a reconnect re-delivers open requests before the resume that
/// binds their session returns. One still unclaimed when its time is up is
/// declined with `-32601`; another client may own it.
///
/// # Ending
///
/// Every prompt is answered at most once. One whose chat no longer holds its
/// session (a rebind, `/new`, the bot leaving the roster) and every one still
/// open at `shutdown` (sign-out, switching gateways) is answered `''`, the
/// gateway's "skipped". One the gateway stopped waiting for is closed with a
/// notice and never answered: its deadline (known when the prompt arrived live)
/// or its `request.cancel`, whichever comes first. A value typed after that is
/// never sent.
@MainActor
@Observable
public final class SecureInputCenter {
  public struct Options: Sendable {
    /// How long a prompt for a session no chat holds waits for one to.
    public var parkLimit: Duration = .seconds(15)
    /// How many such prompts wait at once; one more is declined at once.
    public var maxParked = 16

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

  /// The newest delivery of each open prompt: its reply goes out over the
  /// socket that delivered it, and a reconnect re-delivers it on a new one.
  @ObservationIgnored private var handles: [String: InboundRequest] = [:]
  @ObservationIgnored private var parked: [String: Parked] = [:]
  @ObservationIgnored private var timers: [String: ScheduledTimer] = [:]
  /// Ids that are done (answered, expired, withdrawn, declined), oldest first:
  /// a later copy of one is ignored. Bounded.
  @ObservationIgnored private var closed: [String] = []
  @ObservationIgnored private var closedSet: Set<String> = []
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var revalidating = false
  @ObservationIgnored private var revalidateAgain = false
  @ObservationIgnored private var serial = 0
  @ObservationIgnored private var isShutDown = false

  private struct Parked {
    var inbound: InboundRequest
    var sessionID: String
    var arrivedAt: Duration
    /// Only a notice waits for its chat: the request was already declined.
    var noticeOnly: Bool
  }

  private static let closedLimit = 512

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

    tasks.append(
      Task { [weak self] in
        for await inbound in requests {
          await self?.ingest(inbound)
        }
      }
    )
    tasks.append(
      Task { [weak self] in
        for await wire in events where wire.event.type == GatewayEventType.requestCancel {
          let payload = RequestCancelPayload(json: wire.event.payload?.objectValue ?? [:])
          self?.withdraw(payload.id ?? "", reason: payload.reason ?? "")
        }
      }
    )
  }

  /// Answer every open prompt `''` (and decline every one still waiting for its
  /// chat), then stop. Call before the connection shuts down, so the answers
  /// go out. Idempotent.
  public func shutdown() async {
    guard !isShutDown else {
      return
    }

    isShutDown = true

    let open = prompts.compactMap { prompt in handles[prompt.id].map { (prompt.id, $0) } }
    let waiting = parked

    for (id, _) in open {
      finish(id)
    }

    for id in waiting.keys {
      finish(id)
    }

    for (_, handle) in open {
      _ = await handle.respond(Self.skipped)
    }

    for (_, entry) in waiting where !entry.noticeOnly {
      _ = await entry.inbound.declineUnowned()
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
  /// that is no longer open, whose gateway deadline has passed, whose answer is
  /// already on its way, or that `value` cannot answer.
  @discardableResult
  public func send(_ id: String, value: SecretValue, identifier: String = "") async -> Bool {
    guard let prompt = prompts.first(where: { $0.id == id }), phases[id] != .sending else {
      return false
    }

    if let deadline = prompt.deadline, clock.now >= deadline {
      expire(id)
      return false
    }

    guard let text = prompt.answer(value, identifier: identifier) else {
      return false
    }

    return await deliver(id, ["value": .string(text)])
  }

  /// Skip: answer `''`. Answers whether it went out.
  @discardableResult
  public func skip(_ id: String) async -> Bool {
    guard isOpen(id), phases[id] != .sending else {
      return false
    }

    return await deliver(id, Self.skipped)
  }

  private static let skipped: JSONObject = ["value": .string("")]

  private func deliver(_ id: String, _ result: JSONObject) async -> Bool {
    guard let handle = handles[id] else {
      phases[id] = .failed
      return false
    }

    phases[id] = .sending
    let sent = await handle.respond(result)

    // Re-check after the suspension: the gateway may have withdrawn it, or its
    // chat let go of it, while the answer was in flight.
    guard isOpen(id) else {
      return sent
    }

    if sent {
      finish(id)
      serial += 1
      lastAnswered = AnsweredEntry(requestID: id, serial: serial)
      return true
    }

    if let deadline = prompts.first(where: { $0.id == id })?.deadline, clock.now >= deadline {
      expire(id)
    } else {
      phases[id] = .failed
    }

    return false
  }

  // MARK: - Arriving

  func ingest(_ inbound: InboundRequest) async {
    guard !isShutDown else {
      return
    }

    let id = inbound.id

    guard !id.isEmpty, !closedSet.contains(id) else {
      return
    }

    let body = inbound.body

    if case .unknown(let method, _) = body {
      // Already declined by the connection: say so on its chat, once.
      if parked[id] == nil {
        await route(inbound, sessionID: inbound.request.sessionID ?? "", noticeOnly: true, method: method)
      }
      return
    }

    guard let kind = SecurePromptKind(body) else {
      return
    }

    // A copy of a prompt already here: a reconnect re-delivered it, and its
    // reply now goes out over the new socket.
    if isOpen(id) {
      handles[id] = inbound
      return
    }

    if parked[id] != nil {
      parked[id]?.inbound = inbound
      return
    }

    let sessionID = inbound.request.sessionID ?? ""

    guard !sessionID.isEmpty else {
      close(id)
      _ = await inbound.declineUnowned()
      return
    }

    // The gateway's clock started when it sent the request. For one that
    // arrives live that is now; for one re-delivered after a reconnect it is
    // unknown, so no countdown is shown and its `request.cancel` closes it.
    let deadline = inbound.replayed ? nil : clock.now + kind.gatewayTimeout

    if let deadline {
      timers[id] = clock.schedule(after: deadline - clock.now) { [weak self] in
        await self?.expire(id)
      }
    }

    pending[id] = Pending(kind: kind, deadline: deadline)
    await route(inbound, sessionID: sessionID, noticeOnly: false, method: inbound.method)
  }

  /// What a prompt waiting for its chat will be.
  private struct Pending {
    var kind: SecurePromptKind
    var deadline: Duration?
  }

  @ObservationIgnored private var pending: [String: Pending] = [:]

  /// Open it on its chat, or park it until one holds its session.
  private func route(_ inbound: InboundRequest, sessionID: String, noticeOnly: Bool, method: String) async {
    let id = inbound.id
    let key = sessionID.isEmpty ? nil : await store.chatKey(forRuntime: sessionID)

    // Re-check after the suspension: it may have been withdrawn, or the
    // center shut down, meanwhile.
    guard !isShutDown, !closedSet.contains(id) else {
      pending[id] = nil
      return
    }

    if let key {
      place(inbound, on: key, noticeOnly: noticeOnly, method: method)
      return
    }

    if sessionID.isEmpty {
      close(id)
      return
    }

    guard parked.count < options.maxParked else {
      finish(id)

      if !noticeOnly {
        _ = await inbound.declineUnowned()
      }
      return
    }

    parked[id] = Parked(inbound: inbound, sessionID: sessionID, arrivedAt: clock.now, noticeOnly: noticeOnly)
    let parkTimer = clock.schedule(after: options.parkLimit) { [weak self] in
      await self?.parkExpired(id)
    }

    // A prompt keeps its deadline timer; a notice has none, so its park timer
    // takes the slot.
    if noticeOnly {
      timers[id] = parkTimer
    } else {
      parkTimers[id] = parkTimer
    }

    revalidate()
  }

  @ObservationIgnored private var parkTimers: [String: ScheduledTimer] = [:]

  private func place(_ inbound: InboundRequest, on key: String, noticeOnly: Bool, method: String) {
    let id = inbound.id

    if noticeOnly {
      close(id)
      timers.removeValue(forKey: id)?.cancel()
      show(.unsupported(method: SecurePrompt.displayText(method, limit: SecurePrompt.nameLimit)), id, on: key)
      return
    }

    guard let pending = pending.removeValue(forKey: id) else {
      return
    }

    parkTimers.removeValue(forKey: id)?.cancel()
    handles[id] = inbound
    prompts.append(
      SecurePrompt(
        id: id,
        method: inbound.method,
        kind: pending.kind,
        chatKey: key,
        sessionID: inbound.request.sessionID ?? "",
        deadline: pending.deadline
      )
    )
  }

  private func parkExpired(_ id: String) async {
    guard let entry = parked[id] else {
      return
    }

    finish(id)

    if !entry.noticeOnly {
      _ = await entry.inbound.declineUnowned()
    }
  }

  // MARK: - The chats moved on

  /// The store's chats changed (a frame went out): bind the prompts waiting
  /// for their chat, and let go of the ones whose chat no longer holds their
  /// session. Coalesced: one pass at a time, and one more if asked meanwhile.
  public func storeChanged() {
    guard !prompts.isEmpty || !parked.isEmpty else {
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

  @ObservationIgnored private var revalidation: Task<Void, Never>?

  private func revalidatePass() async {
    repeat {
      revalidateAgain = false
      let sessions = Set(prompts.map(\.sessionID) + parked.values.map(\.sessionID))
      var keys: [String: String] = [:]

      for session in sessions {
        keys[session] = await store.chatKey(forRuntime: session)
      }

      // Re-check after the suspensions: work only on what is still here.
      guard !isShutDown else {
        break
      }

      for (id, entry) in parked {
        if let key = keys[entry.sessionID] {
          parked[id] = nil
          place(entry.inbound, on: key, noticeOnly: entry.noticeOnly, method: entry.inbound.method)
        }
      }

      let abandoned = prompts.filter { prompt in
        keys[prompt.sessionID] != prompt.chatKey && phases[prompt.id] != .sending
      }

      for prompt in abandoned {
        let handle = handles[prompt.id]
        finish(prompt.id)
        _ = await handle?.respond(Self.skipped)
      }
    } while revalidateAgain && !isShutDown

    revalidating = false
  }

  // MARK: - The gateway stopped waiting

  /// `request.cancel`: the gateway withdrew a request. One with reason
  /// `timeout` reads as expired; any other as withdrawn.
  func withdraw(_ id: String, reason: String) {
    guard !id.isEmpty else {
      return
    }

    if let prompt = prompts.first(where: { $0.id == id }) {
      finish(id)
      show(reason == "timeout" ? .expired : .withdrawn, id, on: prompt.chatKey)
    } else {
      // Not here yet (the two streams race), parked, or not a prompt at all:
      // whatever arrives with this id later is ignored.
      if parked[id] != nil {
        finish(id)
      }

      pending[id] = nil
      close(id)
    }
  }

  /// The gateway's deadline passed: close it, send nothing.
  func expire(_ id: String) {
    guard phases[id] != .sending else {
      return
    }

    if let prompt = prompts.first(where: { $0.id == id }) {
      finish(id)
      show(.expired, id, on: prompt.chatKey)
    } else if parked[id] != nil || pending[id] != nil {
      finish(id)
    }
  }

  // MARK: - Bookkeeping

  /// Take a prompt out of every table, and remember it is done.
  private func finish(_ id: String) {
    prompts.removeAll { $0.id == id }
    phases[id] = nil
    handles[id] = nil
    parked[id] = nil
    pending[id] = nil
    timers.removeValue(forKey: id)?.cancel()
    parkTimers.removeValue(forKey: id)?.cancel()
    close(id)
  }

  private func close(_ id: String) {
    guard closedSet.insert(id).inserted else {
      return
    }

    closed.append(id)

    if closed.count > Self.closedLimit {
      closedSet.remove(closed.removeFirst())
    }
  }

  private func show(_ notice: SecureInputNotice, _ requestID: String, on key: String) {
    serial += 1
    notices[key] = SecureInputNoticeEntry(notice: notice, requestID: requestID, serial: serial)
  }
}
