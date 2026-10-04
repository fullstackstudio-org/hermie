import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// Where the answer to one interactive request is.
public enum InteractivePhase: Sendable, Equatable {
  /// On its way; the sheet's controls are off.
  case sending
  /// It did not go out (the socket that delivered the request is gone). The request is still
  /// open; sending again uses the copy the gateway re-delivers after the reconnect.
  case failed
}

/// A short line on a chat about a request that ended without the person's answer, or one this app
/// could not show.
public enum InteractiveNotice: Sendable, Equatable {
  /// The gateway stopped waiting (its own deadline passed), so nothing was sent.
  case expired
  /// The bot stopped asking (the turn was interrupted, the session closed, or the chat let go of
  /// the session), so nothing was sent.
  case withdrawn
  /// The gateway stopped waiting while the answer was on its way: it may not have arrived in time.
  case mayNotHaveArrived
  /// The request ended while the connection was down (withdrawn, timed out, or answered
  /// elsewhere): the reconnect found the gateway no longer waits for it, so nothing was sent.
  case lapsed
  /// This app could not show the request and told the bot so (`4041 cannot_show`): `method`
  /// cleaned and bounded for display, and the machine reason it answered with.
  case cannotShow(method: String, reason: String)
}

/// One notice on one chat, with a serial so the same notice twice is shown twice.
public struct InteractiveNoticeEntry: Sendable, Equatable, Identifiable {
  public var notice: InteractiveNotice
  /// The request it is about.
  public var requestID: String
  public var serial: Int
  public var id: Int { serial }
}

/// What a device can show of the interactive requests: the list the connection announces as
/// `requests` in its second `client.capabilities` call.
public enum InteractiveCapabilities {
  /// The methods this device can show, computed when a session is made (the device does not change
  /// under a running session). `input.form`, `input.file` and `review.draft` always for now; the
  /// device methods (`device.*`) join behind their availability checks (a scanner, a camera).
  public static func deviceMethods() -> [String] {
    ServerRequestBody.Method.interactive
  }
}

/// The interactive requests of one gateway (`input.form`, `input.file`, `review.draft`), from the
/// moment they arrive until they are answered, skipped, expired or withdrawn.
///
/// The native counterpart of the web's interactive model, on the rules of `SecureInputCenter`
/// (read that type's notes first). What differs:
///
/// - A request's params are shown, not a single string asked for: the center holds what was asked
///   (`InteractivePrompt.body`) and nothing the person answers. An answer goes to the request's
///   own reply and no further; the transcript's card hears only that it was answered, with the
///   summary of how it ended (`RequestAnswerSummary`: a status, a count, whether a draft was
///   edited), never a value.
/// - The gateway names its deadline (`expires_at`), so even a re-delivered copy has a countdown.
///   A request whose `expires_at` has passed is not shown and not answered.
/// - A request that cannot be shown is answered with the error `4041 cannot_show {reason}`, never
///   with a made-up skip: an unknown version or field kind here, a refused permission or a failed
///   upload from the sheet (`cannotShow`). A parked request that no chat claims within the park
///   limit, and one whose chat let go of its session, are declined the same way.
/// - `shutdown` answers every open request `4041 shutting_down`.
/// - Only the methods the connection advertised are taken in (`Options.methods`); the connection
///   has already declined the others with `-32601`.
///
/// # Routing, ending, reconnects
///
/// As for `SecureInputCenter`: a request belongs to the chat whose runtime session is its
/// `session_id`; one for a session no chat holds yet waits (at most `parkLimit`, at most
/// `maxParked`) for a resume to bind it and is declined after that; the gateway's
/// `request.cancel`, its deadline and the `open_requests` a reconnect answers with close what the
/// gateway stopped waiting for (with a notice, and nothing sent); a re-delivered copy of a request
/// this center closed without the gateway's `request.cancel` is the proof that the answer never
/// arrived, and the request opens again and says so.
///
/// # The transcript
///
/// The chat's transcript shows that a question was asked and how it ended
/// (`TranscriptStore.interactiveAsked` / `interactiveAnswered` / `interactiveEnded`). Those calls
/// run in order on a chain of their own, so an answer never overtakes its question, and they carry
/// no value.
@MainActor
@Observable
public final class InteractiveRequestCenter {
  public struct Options: Sendable {
    /// How long a request for a session no chat holds waits for one to.
    public var parkLimit: Duration = .seconds(15)
    /// How many such requests wait at once; one more is declined at once.
    public var maxParked = 16
    /// How many notices about requests this app declined wait for their chat at once; one more
    /// drops the oldest.
    public var maxParkedNotices = 16
    /// How long `shutdown` waits for its last answers to reach the socket.
    public var flushLimit: Duration = .seconds(1)
    /// The methods the connection advertised. A request for another method was already declined
    /// by the connection (`-32601`) and is left alone here.
    public var methods: Set<String> = Set(InteractiveCapabilities.deviceMethods())

    public init() {}
  }

  /// The machine reasons this center answers `4041 cannot_show` with, beside
  /// `CannotShowReason`'s.
  public enum Reason {
    /// No chat on this client holds the request's session (another client may own it).
    public static let noChat = "no_chat"
    /// The chat let go of the request's session while the request was open.
    public static let sessionClosed = "session_closed"
  }

  /// The gateway's name as the person knows it, for the sheet's chrome.
  public let gatewayName: String

  /// Every open request, oldest first.
  public private(set) var prompts: [InteractivePrompt] = []
  /// Per request id: an answer on its way, or one that did not go out.
  public private(set) var phases: [String: InteractivePhase] = [:]
  /// The last notice per chat key.
  public private(set) var notices: [String: InteractiveNoticeEntry] = [:]
  /// The last request answered, for a VoiceOver announcement.
  public private(set) var lastAnswered: AnsweredEntry?

  @ObservationIgnored let link: any GatewayLink
  @ObservationIgnored let store: TranscriptStore
  @ObservationIgnored let clock: any ConnectionClock
  @ObservationIgnored let options: Options
  /// Which chat holds a runtime session: the store's routes. A seam for the tests that force a
  /// lookup to wait.
  @ObservationIgnored var chatKey: @Sendable (String) async -> String?

  /// The newest delivery of each open request: its reply goes out over the socket that delivered
  /// it, and a reconnect re-delivers it on a new one.
  @ObservationIgnored private var handles: [String: InboundRequest] = [:]
  /// When each open or waiting request is closed here: `expires_at`, or for one that names none
  /// its arrival plus the longest the gateway waits.
  @ObservationIgnored private var expiries: [String: Duration] = [:]
  /// When each open or waiting request was first taken in here (its newest opening, for one
  /// opened again), on `clock`: `reconcile` keeps one first seen at or after the call whose list
  /// it reads went out.
  @ObservationIgnored private var firstSeen: [String: Duration] = [:]
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
  /// The last of the transcript calls queued so far: each waits for the one before it.
  @ObservationIgnored private var transcriptTail: Task<Void, Never>?

  /// A request, read off the main actor: what it asks, or why this app cannot show it.
  struct Arrival: Sendable {
    var inbound: InboundRequest
    var reading: InteractiveReading
  }

  /// What a request waiting for its chat will be.
  private struct Pending {
    var content: InteractiveContent
    var sessionID: String
    var deadline: Duration?
    var earlierAnswerLost: Bool
  }

  private struct Parked {
    var inbound: InboundRequest
    var sessionID: String
    /// For a notice: what it says.
    var notice: InteractiveNotice?
  }

  /// Why an id is done.
  private enum CloseReason {
    /// An answer (a result or an error) went out from here.
    case answered
    /// Closed here without the gateway saying so: its deadline, its chat let go of it, or it was
    /// declined.
    case closedHere
    /// The gateway withdrew it (`request.cancel`): it never asks again.
    case cancelled
    /// A request this app declined; its notice was shown.
    case notice
  }

  private struct Closed {
    var reason: CloseReason
    /// The deadline it had, for a copy that opens it again.
    var deadline: Duration?
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
    self.chatKey = { [weak store] session in await store?.chatKey(forRuntime: session) }
  }

  // MARK: - Lifecycle

  /// Subscribe to the link's server requests and events. Call before the connection starts, as the
  /// store does.
  public func attach() {
    guard tasks.isEmpty, !isShutDown else {
      return
    }

    let requests = link.serverRequests
    let events = link.events

    // Off the main actor: the texts are cleaned there, and the stream of events (every token of
    // every reply) never wakes the main actor.
    tasks.append(
      Task.detached { [weak self] in
        for await inbound in requests where inbound.body.isInteractive {
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
    Arrival(inbound: inbound, reading: InteractivePrompt.read(inbound.body))
  }

  /// Answer every open request `4041 shutting_down` (and decline every one still waiting for its
  /// chat the same way), wait a bounded time for those answers to reach the socket, then stop.
  /// Call before the connection shuts down. Idempotent.
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
      _ = await handle.cannotShow(reason: CannotShowReason.shuttingDown)
    }

    for (_, entry) in waiting {
      _ = await entry.inbound.cannotShow(reason: CannotShowReason.shuttingDown)
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

  /// How many requests wait for their chat, for tests.
  var parkedCount: Int { parked.count }

  /// How many notices wait for their chat, for tests.
  var parkedNoticeCount: Int { parkedNotices.count }

  /// How many tasks are still running, for tests.
  var liveTaskCount: Int { tasks.count + (revalidating ? 1 : 0) }

  /// Wait until every transcript call queued so far has run, for tests.
  func settleTranscript() async {
    await transcriptTail?.value
  }

  // MARK: - What the views read

  /// The open requests of one chat, oldest first.
  public func prompts(for chatKey: String) -> [InteractivePrompt] {
    prompts.filter { $0.chatKey == chatKey }
  }

  /// Whether a chat has a request waiting: the chat list's needs-input marker.
  public func needsInput(_ chatKey: String) -> Bool {
    prompts.contains { $0.chatKey == chatKey }
  }

  public func isOpen(_ id: String) -> Bool {
    prompts.contains { $0.id == id }
  }

  /// Whole seconds left before the request is hidden, never below zero; nil when the deadline is
  /// not known.
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

  /// Answer a request. Answers whether it went out. Nothing is sent for a request that is no
  /// longer open, whose deadline has passed, whose answer is already on its way, or that `answer`
  /// cannot answer (another method's answer, a Skip it does not offer, a draft it may not change).
  @discardableResult
  public func answer(_ id: String, _ answer: InteractiveAnswer) async -> Bool {
    guard let prompt = prompts.first(where: { $0.id == id }), phases[id] != .sending else {
      return false
    }

    if let expiry = expiries[id], clock.now >= expiry {
      expire(id)
      return false
    }

    guard let reply = prompt.reply(to: answer) else {
      return false
    }

    return await deliver(id, Outgoing.result(reply))
  }

  /// Skip: for a request that offers it. Answers whether it went out.
  @discardableResult
  public func skip(_ id: String) async -> Bool {
    await answer(id, .skip)
  }

  /// The sheet cannot show the request (a refused permission, a failed upload, no camera): answer
  /// the error `4041 cannot_show` with `reason`. Answers whether it went out.
  @discardableResult
  public func cannotShow(_ id: String, reason: String) async -> Bool {
    guard isOpen(id), phases[id] != .sending else {
      return false
    }

    if let expiry = expiries[id], clock.now >= expiry {
      expire(id)
      return false
    }

    return await deliver(id, Outgoing.cannotShow(reason: reason))
  }

  /// What goes out for an answer.
  private enum Outgoing {
    case result(InteractiveReply)
    case cannotShow(reason: String)

    var summary: JSONObject? {
      switch self {
      case .result(let reply): reply.summary
      case .cannotShow: nil
      }
    }
  }

  private func deliver(_ id: String, _ outgoing: Outgoing) async -> Bool {
    guard let handle = handles[id], let prompt = prompts.first(where: { $0.id == id }) else {
      // Only an open request has a phase; a closed id keeps none.
      if isOpen(id) {
        phases[id] = .failed
      }
      return false
    }

    phases[id] = .sending
    let sent: Bool

    switch outgoing {
    case .result(let reply): sent = await handle.respond(reply.result)
    case .cannotShow(let reason): sent = await handle.cannotShow(reason: reason)
    }

    // Re-check after the suspension: the gateway may have withdrawn it, or its chat let go of it,
    // while the answer was in flight.
    guard isOpen(id) else {
      return sent
    }

    if sent {
      finish(id, .answered)
      serial += 1
      lastAnswered = AnsweredEntry(requestID: id, serial: serial)

      if let summary = outgoing.summary {
        transcript { await $0.interactiveAnswered(prompt.chatKey, requestID: id, summary: summary) }
      } else {
        transcript { await $0.interactiveEnded(prompt.chatKey, requestID: id, reason: "cannot_show") }
      }

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

    guard !id.isEmpty, options.methods.contains(inbound.method) else {
      return
    }

    // A copy of a request already done.
    var reopening: Closed?

    if let done = closed[id] {
      // Only the gateway's re-delivery of a request it still waits for opens it again, and never
      // one it withdrew or one that was only a notice.
      guard inbound.replayed, done.reason == .answered || done.reason == .closedHere else {
        return
      }

      closed[id] = nil
      closedOrder.removeAll { $0 == id }
      reopening = done
    }

    let sessionID = inbound.request.sessionID ?? ""

    let content: InteractiveContent

    switch arrival.reading {
    case .other:
      return
    case .cannotShow(let reason):
      // This build cannot show it: tell the bot, and the person once.
      guard !isOpen(id), parked[id] == nil, pending[id] == nil else {
        return
      }

      close(id, .closedHere)
      _ = await inbound.cannotShow(reason: reason)

      if reopening == nil {
        await routeNotice(
          inbound,
          sessionID: sessionID,
          .cannotShow(method: InteractivePrompt.line(inbound.method, limit: SecurePrompt.nameLimit), reason: reason)
        )
      }
      return
    case .content(let read):
      content = read
    }

    // A copy of a request already here: a reconnect re-delivered it, and its reply now goes out
    // over the new socket.
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
      _ = await inbound.cannotShow(reason: Reason.noChat)
      return
    }

    // The gateway names when it stops waiting; a request that names none is shown for the longest
    // it waits, from now (one first seen re-delivered shows no countdown).
    let shown: Duration?
    let expiry: Duration

    if let at = content.expiresAt {
      let left = Double(at) - clock.date.timeIntervalSince1970
      expiry = clock.now + .seconds(left)
      shown = expiry
    } else if !inbound.replayed {
      expiry = clock.now + InteractivePrompt.defaultTimeout
      shown = expiry
    } else if let known = reopening?.deadline {
      shown = known
      expiry = known
    } else {
      shown = nil
      expiry = clock.now + InteractivePrompt.defaultTimeout
    }

    // Past its `expires_at`: not shown, not answered; the gateway withdraws it.
    guard expiry > clock.now else {
      await routeNotice(inbound, sessionID: sessionID, .expired)
      return
    }

    expiries[id] = expiry
    firstSeen[id] = clock.now
    timers[id] = clock.schedule(after: max(expiry - clock.now, .zero)) { [weak self] in
      await self?.expire(id)
    }

    pending[id] = Pending(
      content: content,
      sessionID: sessionID,
      deadline: shown,
      earlierAnswerLost: reopening?.reason == .answered
    )
    await route(inbound, sessionID: sessionID)
  }

  /// Open it on its chat, or park it until one holds its session.
  private func route(_ inbound: InboundRequest, sessionID: String) async {
    let id = inbound.id
    let key = await chatKey(sessionID)

    // Re-check after the suspension: it may have been withdrawn, expired, or the center shut down,
    // meanwhile.
    guard !isShutDown, pending[id] != nil else {
      pending[id] = nil
      return
    }

    if let key {
      place(inbound, on: key)
      // The key was read before the suspension: a pass with a fresh one confirms it (a rebind
      // meanwhile found no request to move).
      revalidate()
      return
    }

    guard parked.count < options.maxParked else {
      finish(id, .closedHere)
      _ = await inbound.cannotShow(reason: Reason.noChat)
      return
    }

    parked[id] = Parked(inbound: inbound, sessionID: sessionID, notice: nil)
    parkTimers[id] = clock.schedule(after: options.parkLimit) { [weak self] in
      await self?.parkExpired(id)
    }

    revalidate()
  }

  /// A notice for a request this app declined or did not show: on its chat, or waiting for one,
  /// apart from the requests (they never take a request's place).
  private func routeNotice(_ inbound: InboundRequest, sessionID: String, _ notice: InteractiveNotice) async {
    let id = inbound.id
    close(id, notice == .expired ? .cancelled : .notice)

    guard !sessionID.isEmpty else {
      return
    }

    let key = await chatKey(sessionID)

    guard !isShutDown else {
      return
    }

    if let key {
      show(notice, id, on: key)
      return
    }

    if parkedNotices.count >= options.maxParkedNotices, let oldest = parkedNoticeOrder.first {
      dropNotice(oldest)
    }

    parkedNotices[id] = Parked(inbound: inbound, sessionID: sessionID, notice: notice)
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
      InteractivePrompt(
        id: id,
        content: pending.content,
        chatKey: key,
        sessionID: inbound.request.sessionID ?? "",
        deadline: pending.deadline,
        earlierAnswerLost: pending.earlierAnswerLost
      )
    )

    // The chat's transcript says that a question was asked.
    let request = inbound.request
    let replayed = inbound.replayed
    transcript { await $0.interactiveAsked(key, request: request, replayed: replayed) }
  }

  private func parkExpired(_ id: String) async {
    guard let entry = parked[id] else {
      return
    }

    finish(id, .closedHere)
    _ = await entry.inbound.cannotShow(reason: Reason.noChat)
  }

  // MARK: - The chats moved on

  /// The store's chats changed (a frame went out): bind the requests waiting for their chat, move
  /// the ones whose session moved, and let go of the ones whose session no chat holds. Coalesced:
  /// one pass at a time, and one more if asked meanwhile.
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
      // What this pass judges: the requests and waiting entries here now, and only by the keys it
      // reads for their sessions. Anything that arrives while it reads is left to the next pass
      // (`route` asks for one).
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
        if let key = keys[entry.sessionID], let notice = entry.notice {
          dropNotice(id)
          show(notice, id, on: key)
        }
      }

      var abandoned: [InteractivePrompt] = []

      for (index, prompt) in prompts.enumerated()
      where judged.contains(prompt.id) && sessions.contains(prompt.sessionID) && phases[prompt.id] != .sending {
        if let key = keys[prompt.sessionID] {
          // Its session moved to another chat: the request goes with it.
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
        transcript { await $0.interactiveEnded(prompt.chatKey, requestID: prompt.id, reason: "withdrawn") }
        // If this does not arrive, the gateway's re-delivery opens it again.
        _ = await handle?.cannotShow(reason: Reason.sessionClosed)
      }
    } while revalidateAgain && !isShutDown

    revalidating = false
  }

  // MARK: - The gateway stopped waiting

  /// `request.cancel`: the gateway withdrew a request. One with reason `timeout` reads as
  /// expired; any other as withdrawn; one whose answer was on its way may not have got there in
  /// time. The transcript's card hears the same event through the store.
  func withdraw(_ id: String, reason: String) {
    guard !id.isEmpty else {
      return
    }

    if let prompt = prompts.first(where: { $0.id == id }) {
      let notice: InteractiveNotice =
        phases[id] == .sending ? .mayNotHaveArrived : reason == "timeout" ? .expired : .withdrawn
      finish(id, .cancelled)
      show(notice, id, on: prompt.chatKey)
      return
    }

    // Not here yet (the two streams race), waiting for its chat, or not one of ours at all:
    // whatever arrives with this id later is ignored.
    if parked[id] != nil || pending[id] != nil {
      finish(id, .cancelled)
    } else {
      close(id, .cancelled)
    }
  }

  /// A reconnect's `open_requests` for one runtime session (a `session.resume`'s or a
  /// `session.events.since`'s): every request the gateway still waits for there. A request of that
  /// session the list does not name ended while the socket was down (withdrawn, timed out,
  /// answered elsewhere): an open one closes with a "lapsed" notice ("may not have arrived" if its
  /// answer is on its way), one waiting for its chat goes quietly, and nothing is sent; an answer
  /// would be dropped. A copy the gateway re-delivers later is ignored.
  ///
  /// One first seen at or after `askedAt` (the shared clock's reading just before the call went
  /// out) is kept: the gateway may have raised it after it took the list.
  func reconcile(session sessionID: String, open ids: [String], askedAt: Duration) {
    guard !isShutDown, !sessionID.isEmpty else {
      return
    }

    let listed = Set(ids)
    let ended = { [firstSeen] (id: String, session: String) -> Bool in
      guard session == sessionID, !listed.contains(id), let seen = firstSeen[id] else {
        return false
      }

      return seen < askedAt
    }

    for prompt in prompts where ended(prompt.id, prompt.sessionID) {
      let notice: InteractiveNotice = phases[prompt.id] == .sending ? .mayNotHaveArrived : .lapsed
      finish(prompt.id, .cancelled)
      show(notice, prompt.id, on: prompt.chatKey)
      transcript { await $0.interactiveEnded(prompt.chatKey, requestID: prompt.id, reason: "lapsed") }
    }

    // One waiting for its chat is in `pending` (and in `parked` once parked).
    let waiting = Set(pending.compactMap { id, entry in ended(id, entry.sessionID) ? id : nil })

    for id in waiting {
      finish(id, .cancelled)
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
      transcript { await $0.interactiveEnded(prompt.chatKey, requestID: id, reason: "timeout") }
    } else if parked[id] != nil || pending[id] != nil {
      finish(id, .closedHere)
    }
  }

  // MARK: - Bookkeeping

  /// Take a request out of every table, and remember it is done and why.
  private func finish(_ id: String, _ reason: CloseReason) {
    let deadline = prompts.first { $0.id == id }?.deadline ?? pending[id]?.deadline
    prompts.removeAll { $0.id == id }
    phases[id] = nil
    handles[id] = nil
    parked[id] = nil
    pending[id] = nil
    expiries[id] = nil
    firstSeen[id] = nil
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

  private func show(_ notice: InteractiveNotice, _ requestID: String, on key: String) {
    serial += 1
    notices[key] = InteractiveNoticeEntry(notice: notice, requestID: requestID, serial: serial)
  }

  /// Tell the chat's transcript, in order with the calls before it.
  private func transcript(_ work: @escaping @Sendable (TranscriptStore) async -> Void) {
    let previous = transcriptTail
    let store = self.store

    transcriptTail = Task {
      await previous?.value
      await work(store)
    }
  }
}
