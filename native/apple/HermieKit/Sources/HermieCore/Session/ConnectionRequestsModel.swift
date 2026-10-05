import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// An authorisation link from a connection operation, checked before anything
/// may open it: `https` only, a host, and no user or password before the host
/// (`https://trusted.example@elsewhere.example` reads as one host and goes to
/// the other).
public struct AuthorisationLink: Sendable, Equatable {
  public let url: URL
  /// What to show beside the button, so the person sees where it goes.
  public let host: String

  /// `nil` for anything that is not a plain `https` link.
  public init?(_ raw: String?) {
    guard let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
      url.scheme?.lowercased() == "https", let host = url.host(percentEncoded: false), !host.isEmpty,
      url.user(percentEncoded: true) == nil, url.password(percentEncoded: true) == nil
    else {
      return nil
    }

    self.url = url
    self.host = host
  }
}

/// One row of a connection card: a connector to authorise, an MCP server to
/// install, a catalog entry to enable.
public struct ConnectionTarget: Sendable, Equatable, Identifiable {
  public var name: String
  /// `connector`, `mcp`, `plugin` or `skill`, as the gateway sent it.
  public var kind: String
  /// `authorize`, `connect`, `enable`, `install` or `reconnect`, as the gateway sent it.
  public var action: String
  public var state: ConnectionTargetState
  public var detail: String
  /// What to do when there is no link (or beside it), as the gateway wrote it. Plain text.
  public var instructions: String?
  /// The link to open, when the gateway sent one that passes `AuthorisationLink`.
  public var link: AuthorisationLink?
  /// The gateway sent a link that did not pass: say so rather than hide the row's way forward.
  public var linkRefused: Bool
  /// The person opened the link from this device. Local only: the gateway's
  /// watcher notices the authorisation itself and sends the update.
  public var opened: Bool

  public var id: String { name }
}

/// The connection operation a chat's agent is waiting on (`connection.request`,
/// or a resume's `pending_connection`). The agent waits until every row is
/// resolved, the person continues, or the deadline passes.
public struct ConnectionRequest: Sendable, Equatable, Identifiable {
  public var chat: String
  /// The runtime session that owns it; the answer names it.
  public var runtimeSessionID: String
  public var opID: String
  /// The tool call that opened it; the card belongs on that row.
  public var toolCallID: String
  /// The operation's own write counter; an older frame moves nothing.
  public var seq: Int
  /// The gateway's deadline.
  public var deadline: Date
  public var targets: [ConnectionTarget]

  public var id: String { opID }

  /// Seconds left at `now`, never below zero.
  public func remaining(at now: Date) -> TimeInterval {
    max(0, deadline.timeIntervalSince(now))
  }
}

/// The connection cards, per chat: what the agent is waiting on, restored on
/// resume, moved by `connection.update`, withdrawn when the operation settles
/// or its deadline passes. Opening a link is the view's job; this model only
/// says which links may be opened, and answers the operation.
@MainActor
@Observable
public final class ConnectionRequestsModel {
  /// The open request per chat key.
  public private(set) var requests: [String: ConnectionRequest] = [:]
  /// The last answer that did not go out, for a banner.
  public private(set) var lastError: String?
  /// Where what the person decided on a card is logged: a link opened, "Not now", Cancel. Keeps nothing by
  /// default.
  @ObservationIgnored public var decisions = DecisionRecorder.discarding()

  @ObservationIgnored private let clock: any ConnectionClock
  @ObservationIgnored private let call: @Sendable (String, JSONValue) async throws -> RPCReply<JSONValue>
  @ObservationIgnored private var timers: [String: ScheduledTimer] = [:]

  /// - Parameter call: how an answer goes out (the session's link).
  init(
    clock: any ConnectionClock,
    call: @escaping @Sendable (String, JSONValue) async throws -> RPCReply<JSONValue>
  ) {
    self.clock = clock
    self.call = call
  }

  public func request(for chat: String) -> ConnectionRequest? {
    requests[chat]
  }

  // MARK: - Actions

  /// The person opened a row's link. The first time, it is logged as the person authorising that connector (the
  /// link itself is not kept; whether the provider then accepted is the gateway's to say).
  public func markOpened(chat: String, target: String) async {
    guard var request = requests[chat], let index = request.targets.firstIndex(where: { $0.name == target }) else {
      return
    }

    let first = !request.targets[index].opened

    request.targets[index].opened = true
    requests[chat] = request

    if first {
      await decisions.connector(
        outcome: .authorised, bot: chat, session: request.runtimeSessionID, name: request.targets[index].name)
    }
  }

  /// "Not now" on one row. Answers whether the answer went out; the card moves
  /// when the gateway's `connection.update` comes back.
  @discardableResult
  public func skip(chat: String, target: String) async -> Bool {
    guard let request = requests[chat], request.targets.contains(where: { $0.name == target }) else {
      return false
    }

    var answer = ConnectionAnswer()
    answer.targets = [ConnectionAnswerTarget(name: target, status: "skipped")]
    let sent = await respond(request, answer)

    if sent {
      await decisions.connector(outcome: .declined, bot: chat, session: request.runtimeSessionID, name: target)
    }

    return sent
  }

  /// Cancel: end the operation now with whatever is unresolved (`settled_by:
  /// continue`), so the agent stops waiting for the deadline.
  @discardableResult
  public func cancel(chat: String) async -> Bool {
    guard let request = requests[chat] else {
      return false
    }

    var answer = ConnectionAnswer()
    answer.settledBy = .continue
    let sent = await respond(request, answer)

    if sent {
      await decisions.connector(outcome: .skipped, bot: chat, session: request.runtimeSessionID, name: nil)
    }

    return sent
  }

  private func respond(_ request: ConnectionRequest, _ answer: ConnectionAnswer) async -> Bool {
    var params = ConnectionRespondParams()
    params.profile = request.chat
    params.owner = ConnectorOwner(sessionID: request.runtimeSessionID)
    params.opID = request.opID
    params.result = answer

    do {
      _ = try await call(RPC.ConnectionRespond.name, params.jsonValue)
      lastError = nil
      return true
    } catch {
      lastError = ChatResolver.describe(error)
      return false
    }
  }

  // MARK: - From the gateway

  func requested(chat: String, runtimeSessionID: String, _ payload: ConnectionRequestPayload) {
    guard let request = Self.request(chat: chat, runtimeSessionID: runtimeSessionID, payload) else {
      return
    }

    if let current = requests[chat], current.opID == request.opID, current.seq >= request.seq {
      return
    }

    put(request)
  }

  /// A resume's `pending_connection`. Absent: the chat waits on nothing any more.
  func restored(chat: String, runtimeSessionID: String, _ payload: ConnectionRequestPayload?) {
    guard let payload else {
      withdraw(chat)
      return
    }

    requested(chat: chat, runtimeSessionID: runtimeSessionID, payload)
  }

  func updated(chat: String, _ update: ConnectionUpdatePayload) {
    // An account-wide operation is the settings screen's, not a chat's.
    guard update.owner?.type != "account", var request = requests[chat], update.opID == request.opID else {
      return
    }

    if update.settled == true {
      withdraw(chat)
      return
    }

    guard let seq = update.seq, seq > request.seq else {
      return
    }

    request.seq = seq

    if let deadline = update.deadlineAt, deadline > 0 {
      request.deadline = Date(timeIntervalSince1970: deadline)
    }

    for live in update.targets ?? [] {
      guard let name = live.name, let index = request.targets.firstIndex(where: { $0.name == name }) else {
        continue
      }

      request.targets[index] = Self.merge(request.targets[index], live)
    }

    put(request)
  }

  func forget(chat: String) {
    withdraw(chat)
  }

  /// Every card goes (the session ended).
  func removeAll() {
    for chat in Array(requests.keys) {
      withdraw(chat)
    }
  }

  private func put(_ request: ConnectionRequest) {
    let chat = request.chat
    requests[chat] = request
    timers.removeValue(forKey: chat)?.cancel()

    let left = request.deadline.timeIntervalSince(clock.date)
    let opID = request.opID

    guard left > 0 else {
      withdraw(chat)
      return
    }

    timers[chat] = clock.schedule(after: .milliseconds(Int((left * 1000).rounded(.up)))) { [weak self] in
      await self?.deadlinePassed(chat: chat, opID: opID)
    }
  }

  private func deadlinePassed(chat: String, opID: String) {
    guard let request = requests[chat], request.opID == opID else {
      return
    }

    // The gateway settles it at the deadline; a socket that is down cannot say
    // so, and a card for an agent that stopped waiting must not stay up.
    if request.deadline.timeIntervalSince(clock.date) <= 0 {
      withdraw(chat)
    } else {
      put(request)
    }
  }

  private func withdraw(_ chat: String) {
    timers.removeValue(forKey: chat)?.cancel()
    requests[chat] = nil
  }

  // MARK: - Reading the wire

  /// `normalizeConnectionRequest`: nothing without an op id, a tool call, a
  /// deadline and at least one named row.
  static func request(chat: String, runtimeSessionID: String, _ payload: ConnectionRequestPayload)
    -> ConnectionRequest?
  {
    let targets = (payload.targets ?? []).compactMap(target)

    guard let opID = payload.opID, !opID.isEmpty, let toolCallID = payload.toolCallID, !toolCallID.isEmpty,
      let deadline = payload.deadlineAt, deadline > 0, !targets.isEmpty, !runtimeSessionID.isEmpty
    else {
      return nil
    }

    return ConnectionRequest(
      chat: chat,
      runtimeSessionID: runtimeSessionID,
      opID: opID,
      toolCallID: toolCallID,
      seq: payload.seq ?? 0,
      deadline: Date(timeIntervalSince1970: deadline),
      targets: targets
    )
  }

  static func target(_ wire: ConnectionOperationTarget) -> ConnectionTarget? {
    guard let name = wire.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
      return nil
    }

    let link = AuthorisationLink(wire.connectURL)

    return ConnectionTarget(
      name: name,
      kind: wire.kind ?? "mcp",
      action: wire.action ?? "install",
      state: wire.state ?? .pending,
      detail: wire.detail ?? "",
      instructions: wire.instructions,
      link: link,
      linkRefused: link == nil && !(wire.connectURL ?? "").isEmpty,
      opened: false
    )
  }

  /// `mergeLiveTarget`: what the frame carries replaces what was held; what it
  /// leaves out stays.
  static func merge(_ target: ConnectionTarget, _ live: ConnectionOperationTarget) -> ConnectionTarget {
    var next = target

    if let state = live.state {
      next.state = state
    }

    if let detail = live.detail {
      next.detail = detail
    }

    if live.json["instructions"] != nil {
      next.instructions = live.instructions
    }

    if let raw = live.connectURL {
      let link = AuthorisationLink(raw)
      next.link = link
      next.linkRefused = link == nil && !raw.isEmpty
    }

    return next
  }
}
