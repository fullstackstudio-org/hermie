import Foundation
import HermieProtocol
import Synchronization

@testable import HermieGateway

/// A scripted Hermes gateway that is also the WebSocket transport: the Swift
/// stand-in for `packages/fake-gateway` as `connection.test.ts` drives it.
///
/// It keeps the same counters the TypeScript tests read (`connections`,
/// `ticketsMinted`, `rejectedUpgrades`, `refreshCalls`, `methodLog`, …) and
/// authorises an upgrade the way the fake gateway's `authorizeUpgrade` does:
/// `rejectNextUpgrades` first, then the session token in the query or exactly
/// one single-use ticket in the subprotocols. A refused upgrade is accepted and
/// then closed with `closeCode` ("unauthorized"), as upstream does.
///
/// Nothing here waits on a clock: a dial completes as soon as the tasks
/// involved get to run, so tests only advance time for the connection's timers.
final class FakeGateway: WebSocketTransport {
  enum Auth: Sendable {
    case none
    case token
    case native
  }

  struct Dial: Sendable {
    var url: String
    var headers: [String: String]
    var subprotocols: [String]
  }

  struct State {
    var auth: Auth
    var token = "demo-session-token"
    var closeCode = 4401
    var replayEpoch = "epoch-1"
    /// The address refuses connections (the fake gateway was closed).
    var down = false
    /// The upgrade never completes until the dial is cancelled.
    var hangConnect = false
    /// The upgrade is answered with a redirect, refused the way `URLSessionTransport` refuses one.
    var redirectUpgrade: GatewayError?
    /// Open, but no `gateway.ready` is ever sent.
    var silent = false
    /// Sent right after `gateway.ready`, in the same breath: the socket closes.
    var closeAfterReady: WebSocketClosed?
    /// `gateway.ready` advertises the heartbeat.
    var advertiseHeartbeat = true
    /// `gateway.ping` is answered.
    var answerPings = true
    /// `client.capabilities` is answered `-32601`, like an older backend.
    var refuseCapabilities = false

    var connections = 0
    var rejectNextUpgrades = 0
    var rejectedUpgrades = 0
    var dials: [Dial] = []

    var tickets: Set<String> = []
    var nextTicket = 0
    var ticketsMinted = 0
    var ticketsConsumed = 0
    var failNextTicketMints = 0
    var ticketMintsFailed = 0

    var refreshToken = "refresh-0"
    var refreshGeneration = 0
    var refreshCalls = 0
    var refreshReuseAttempts = 0

    var methodLog: [String] = []
    var eventsSinceCalls: [(sessionID: String, lastSeen: Double)] = []
    var hangMethods: Set<String> = []
    /// Per method: the 0-based number of the first call that is held (not answered) until
    /// `releaseHeld`. `["client.capabilities": 1]` holds a connection's second call.
    var holdFrom: [String: Int] = [:]
    var held: [(socket: FakeSocket, id: JSONValue, method: String)] = []
    /// Results to answer a method with instead of the built-in ones.
    var scriptedResults: [String: JSONValue] = [:]

    var sockets: [FakeSocket] = []
    var allSockets: [FakeSocket] = []
    var seq: [String: Int] = [:]
    var ring: [String: [JSONValue]] = [:]
    var nextServerRequest = 0
    var serverRequests: [String: CheckedContinuation<JSONValue, any Error>] = [:]
  }

  let state: Mutex<State>

  init(auth: Auth) {
    state = Mutex(State(auth: auth))
  }

  /// Read or change the state in one step.
  func with<T>(_ body: (inout State) -> T) -> T {
    state.withLock { body(&$0) }
  }

  var connections: Int { with { $0.connections } }

  /// How many calls to `method` are held (`State.holdFrom`).
  func heldCount(_ method: String) -> Int { with { $0.held.filter { $0.method == method }.count } }

  /// Answer every held call to `method` with `result`, and stop holding it.
  func releaseHeld(_ method: String, result: JSONValue) {
    let held = with { state in
      state.holdFrom[method] = nil
      let taken = state.held.filter { $0.method == method }
      state.held.removeAll { $0.method == method }
      return taken
    }

    for call in held {
      call.socket.respond(call.id, result: result)
    }
  }
  var methodLog: [String] { with { $0.methodLog } }
  var replayEpoch: String { with { $0.replayEpoch } }
  var token: String { with { $0.token } }
  var lastSocket: FakeSocket? { with { $0.allSockets.last } }

  // MARK: - The transport

  func connect(_ request: URLRequest, subprotocols: [String]) async throws -> any WebSocketChannel {
    let (down, hang, redirect) = with { state in
      state.dials.append(
        Dial(
          url: request.url?.absoluteString ?? "",
          headers: request.allHTTPHeaderFields ?? [:],
          subprotocols: subprotocols
        )
      )
      return (state.down, state.hangConnect, state.redirectUpgrade)
    }

    if down {
      throw URLError(.cannotConnectToHost)
    }

    if let redirect {
      throw redirect
    }

    if hang {
      // A real socket stuck in its handshake: only cancellation ends it. This
      // sleeps on the real clock inside the fake, never in the connection.
      try await Task.sleep(for: .seconds(3600))
    }

    let socket = FakeSocket(gateway: self)
    let rejection = with { state -> Int? in
      state.allSockets.append(socket)
      let rejection = authorizeUpgrade(&state, request: request, subprotocols: subprotocols)

      if rejection == nil {
        state.connections += 1
        state.sockets.append(socket)
      } else {
        state.rejectedUpgrades += 1
      }

      return rejection
    }

    if let rejection {
      socket.serverClose(code: rejection, reason: "unauthorized")
      return socket
    }

    let (silent, epoch, heartbeat, closeAfterReady) = with {
      ($0.silent, $0.replayEpoch, $0.advertiseHeartbeat, $0.closeAfterReady)
    }

    if !silent {
      socket.serverSend([
        "jsonrpc": "2.0",
        "method": "event",
        "params": [
          "type": "gateway.ready",
          "payload": [
            "skin": [:], "change_events": true, "replay_epoch": .string(epoch), "heartbeat": .bool(heartbeat)
          ]
        ]
      ])
    }

    if let closeAfterReady {
      socket.serverClose(code: closeAfterReady.code, reason: closeAfterReady.reason)
    }

    return socket
  }

  private func authorizeUpgrade(_ state: inout State, request: URLRequest, subprotocols: [String]) -> Int? {
    if state.rejectNextUpgrades > 0 {
      state.rejectNextUpgrades -= 1
      return state.closeCode
    }

    switch state.auth {
    case .none:
      return nil

    case .token:
      let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems ?? []
      return query.first { $0.name == "token" }?.value == state.token ? nil : state.closeCode

    case .native:
      let tickets = subprotocols.filter { $0.hasPrefix(GatewayWebSocketProtocol.ticketPrefix) }

      guard tickets.count == 1, subprotocols.contains(GatewayWebSocketProtocol.base) else {
        return state.closeCode
      }

      let ticket = String(tickets[0].dropFirst(GatewayWebSocketProtocol.ticketPrefix.count))

      // Single use: consumed on sight whether or not it was still valid.
      guard state.tickets.remove(ticket) != nil else {
        return state.closeCode
      }

      state.ticketsConsumed += 1
      return nil
    }
  }

  // MARK: - What the credential provider calls over "HTTP"

  /// `POST /api/auth/ws-ticket`.
  func mintTicket() throws(GatewayError) -> String {
    let ticket = with { state -> String? in
      if state.failNextTicketMints > 0 {
        state.failNextTicketMints -= 1
        state.ticketMintsFailed += 1
        return nil
      }

      state.nextTicket += 1
      let ticket = "tk-\(state.nextTicket)"
      state.tickets.insert(ticket)
      state.ticketsMinted += 1
      return ticket
    }

    guard let ticket else {
      throw GatewayError(.server, "The gateway answered HTTP 503 while minting a ticket.", status: 503)
    }

    return ticket
  }

  /// `POST /api/auth/native/refresh`: rotate `presented`, counting a replay of
  /// a token that was already rotated away.
  func refresh(presenting presented: String) -> String {
    with { state in
      state.refreshCalls += 1

      if presented != state.refreshToken {
        state.refreshReuseAttempts += 1
      }

      state.refreshGeneration += 1
      state.refreshToken = "refresh-\(state.refreshGeneration)"
      return state.refreshToken
    }
  }

  // MARK: - Driving the gateway from a test

  /// Push an event to every live socket. A session event gets the session's next seq.
  func emit(_ type: String, sessionID: String? = nil, payload: JSONValue = [:]) {
    let event = with { state -> JSONValue in
      var object: JSONObject = ["type": .string(type), "payload": payload]

      if let sessionID {
        let next = (state.seq[sessionID] ?? 0) + 1
        state.seq[sessionID] = next
        object["session_id"] = .string(sessionID)
        object["seq"] = .number(Double(next))
        state.ring[sessionID, default: []].append(.object(object))
      }

      return .object(object)
    }

    for socket in with({ $0.sockets }) {
      socket.serverSend(["jsonrpc": "2.0", "method": "event", "params": event])
    }
  }

  /// Close every live socket with a close frame.
  func closeSockets(code: Int, reason: String = "") {
    for socket in with({ $0.sockets }) {
      socket.serverClose(code: code, reason: reason)
    }
  }

  /// Kill every live socket without a close frame: the client sees 1006.
  func dropSockets() {
    for socket in with({ $0.sockets }) {
      socket.serverClose(code: WebSocketClosed.abnormalClosure, reason: "")
    }
  }

  /// The gateway process goes away: sockets dropped, the address refuses.
  func shutDown() {
    with { $0.down = true }
    dropSockets()
  }

  func restart() {
    with { $0.down = false }
  }

  /// Ask the client an `approval` question and wait for its answer. Throws with
  /// the error frame's JSON when the client answers with an error.
  func requestApproval(_ params: JSONObject) async throws -> JSONValue {
    try await requestServerSide(method: "approval", params: params)
  }

  func requestServerSide(method: String, params: JSONObject) async throws -> JSONValue {
    let id = with { state in
      state.nextServerRequest += 1
      return "srq-\(state.nextServerRequest)"
    }

    return try await withCheckedThrowingContinuation { continuation in
      let socket = with { state -> FakeSocket? in
        state.serverRequests[id] = continuation
        return state.sockets.first
      }

      guard let socket else {
        _ = with { $0.serverRequests.removeValue(forKey: id) }
        continuation.resume(throwing: FakeGatewayError("no socket to ask on"))
        return
      }

      socket.serverSend([
        "jsonrpc": "2.0", "id": .string(id), "method": .string(method), "params": .object(params)
      ])
    }
  }

  // MARK: - Frames from the client

  func receive(_ text: String, on socket: FakeSocket) {
    guard let frame = try? JSONValue(parsing: text), case .object(let object) = frame else {
      return
    }

    guard let method = object["method"]?.stringValue else {
      // A response to one of our server→client requests.
      let id = object["id"]?.stringValue ?? ""

      guard let waiter = with({ $0.serverRequests.removeValue(forKey: id) }) else {
        return
      }

      if let error = object["error"], error.isTruthy {
        waiter.resume(throwing: FakeGatewayError((try? error.canonicalString()) ?? "error"))
      } else {
        waiter.resume(returning: object["result"] ?? .null)
      }

      return
    }

    let id = object["id"] ?? .null
    let params = object["params"] ?? [:]
    let (hang, scripted) = with { state in
      let number = state.methodLog.filter { $0 == method }.count
      state.methodLog.append(method)

      if let from = state.holdFrom[method], number >= from {
        state.held.append((socket, id, method))
        return (true, nil as JSONValue?)
      }

      return (state.hangMethods.contains(method), state.scriptedResults[method])
    }

    if hang {
      return
    }

    if let scripted {
      socket.respond(id, result: scripted)
      return
    }

    switch method {
    case "gateway.ping":
      if with({ $0.answerPings }) {
        socket.respond(id, result: ["ok": true])
      }

    case "client.capabilities":
      if with({ $0.refuseCapabilities }) {
        socket.respond(id, error: ["code": -32601, "message": "unknown method: client.capabilities"])
      } else {
        socket.respond(id, result: ["ok": true])
      }

    case "profiles.list":
      socket.respond(
        id,
        result: [
          "profiles": [
            ["name": "researcher", "canonical_session": ["id": "stored-researcher"]],
            ["name": "writer", "canonical_session": ["id": "stored-writer"]]
          ]
        ]
      )

    case "session.resume":
      let session = params["session_id"] ?? .null
      socket.respond(id, result: ["session_id": session, "info": ["desktop_contract": 7]])

    case "prompt.submit":
      let session = params["session_id"]?.stringValue ?? ""
      socket.respond(id, result: ["status": "streaming"])
      emit("message.start", sessionID: session)
      emit("message.delta", sessionID: session, payload: ["text": "Hello"])
      emit("message.complete", sessionID: session, payload: ["text": "Hello", "status": "complete"])

    case "session.events.since":
      let session = params["session_id"]?.stringValue ?? ""
      let lastSeen = params["last_seen"]?.doubleValue ?? 0
      let (events, epoch) = with { state in
        state.eventsSinceCalls.append((session, lastSeen))
        let events = (state.ring[session] ?? []).filter { ($0["seq"]?.doubleValue ?? 0) > lastSeen }
        return (events, state.replayEpoch)
      }
      socket.respond(
        id,
        result: [
          "events": .array(events), "latest_seq": .number(Double(with { $0.seq[session] ?? 0 })),
          "truncated": false, "count": .number(Double(events.count)), "epoch": .string(epoch)
        ]
      )

    default:
      socket.respond(id, error: ["code": -32601, "message": .string("unknown method: \(method)")])
    }
  }

  func forget(_ socket: FakeSocket) {
    with { $0.sockets.removeAll { $0 === socket } }
  }
}

struct FakeGatewayError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// One socket of the fake gateway: what the client sends is recorded and
/// answered; what the gateway sends is queued on `frames`.
final class FakeSocket: WebSocketChannel {
  let frames: AsyncThrowingStream<String, any Error>
  private let continuation: AsyncThrowingStream<String, any Error>.Continuation
  private let gateway: FakeGateway
  private let state = Mutex((open: true, sent: [String](), closeCodeOnClientClose: Int?.none))

  /// The code this socket's close reports when the client closes it, as a
  /// server answering the client's close frame with its own code would.
  func reportOnClientClose(code: Int) {
    state.withLock { $0.closeCodeOnClientClose = code }
  }

  init(gateway: FakeGateway) {
    self.gateway = gateway
    (frames, continuation) = AsyncThrowingStream<String, any Error>.makeStream()
  }

  /// Every frame the client sent on this socket, in order.
  var sent: [JSONValue] {
    state.withLock { $0.sent }.compactMap { try? JSONValue(parsing: $0) }
  }

  /// The most recent request the client sent with this method.
  func lastRequest(_ method: String) -> JSONValue? {
    sent.last { $0["method"]?.stringValue == method }
  }

  var isOpen: Bool { state.withLock { $0.open } }

  func send(text: String) async throws {
    let open = state.withLock { state in
      if state.open {
        state.sent.append(text)
      }
      return state.open
    }

    guard open else {
      throw WebSocketClosed(code: WebSocketClosed.abnormalClosure)
    }

    gateway.receive(text, on: self)
  }

  func close(code: Int, reason: String?) async {
    let reported = state.withLock { $0.closeCodeOnClientClose } ?? code
    serverClose(code: reported, reason: reason ?? "")
  }

  /// A frame from the gateway.
  func serverSend(_ frame: JSONValue) {
    guard isOpen, let text = try? frame.canonicalString() else {
      return
    }

    continuation.yield(text)
  }

  /// Raw text from the gateway, JSON or not.
  func serverSendText(_ text: String) {
    guard isOpen else {
      return
    }

    continuation.yield(text)
  }

  func respond(_ id: JSONValue, result: JSONValue) {
    serverSend(["jsonrpc": "2.0", "id": id, "result": result])
  }

  func respond(_ id: JSONValue, error: JSONValue) {
    serverSend(["jsonrpc": "2.0", "id": id, "error": error])
  }

  /// The socket ends, from either side.
  func serverClose(code: Int, reason: String) {
    let wasOpen = state.withLock { state in
      defer { state.open = false }
      return state.open
    }

    guard wasOpen else {
      return
    }

    gateway.forget(self)
    continuation.finish(throwing: WebSocketClosed(code: code, reason: reason))
  }
}
