import Foundation
import HermieProtocol

// The call layer: the port of the vendored `JsonRpcRequestChannel`
// (`packages/hermes-shared/src/json-rpc-channel.ts`). Request ids, the pending
// map with per-call timeouts, inbound frame routing, server→client requests,
// the capability announcement and the `gateway.ping` heartbeat.

/// One item on a socket generation's writer: a frame to send, or a barrier to
/// run once every frame before it has been handed to the socket.
enum OutgoingFrame: Sendable {
  case text(String)
  case barrier(@Sendable () -> Void)
}

/// One call waiting for its answer.
struct PendingCall {
  let promise: Promise<RPCReply<JSONValue>>
  var timer: TimerSlot?
  /// Its place among the calls (`GatewayConnection.requestsListedSince`).
  var serial: UInt64 = 0
}

extension GatewayConnection {
  // MARK: Attaching a socket generation

  /// `attach`: bind a new generation. Its heartbeat starts only on `gateway.ready`.
  func attach(_ generation: UInt64, _ outbox: AsyncStream<OutgoingFrame>.Continuation) {
    stopHeartbeat()
    attachedGeneration = generation
    attachedOutbox = outbox
    heartbeat.lastLivenessAt = clock.now
    // A new socket starts without an advertisement at the gateway.
    confirmAdvertised = nil
    requestsAdvertised = []
    requestsListedSince = [:]
  }

  /// `detach`: drop the generation and fail every call in flight with `error`.
  func detach(_ error: GatewayRPCError) {
    stopHeartbeat()
    attachedOutbox?.finish()
    attachedOutbox = nil
    attachedGeneration = nil

    let failed = pending
    pending = [:]

    for call in failed.values {
      call.timer?.timer.cancel()
      call.promise.reject(error)
    }
  }

  /// Queue one frame on the attached generation. A frame that cannot be written
  /// as JSON, or with no generation attached, goes nowhere.
  @discardableResult
  func send(_ frame: JSONValue) -> Bool {
    guard let outbox = attachedOutbox, let data = try? frame.canonicalData() else {
      return false
    }

    outbox.yield(.text(String(decoding: data, as: UTF8.self)))
    return true
  }

  /// A barrier on the attached generation's writer: `reached` runs once every
  /// frame queued before it has been handed to the socket, or at once when no
  /// generation is attached (there is nothing to wait for).
  func queueBarrier(_ reached: @escaping @Sendable () -> Void) {
    guard let outbox = attachedOutbox else {
      reached()
      return
    }

    if case .terminated = outbox.yield(.barrier(reached)) {
      reached()
    }
  }

  // MARK: Calls

  /// `JsonRpcGatewayClient.request` up to its promise: refuse without an open
  /// socket, then register the call and queue its frame.
  func clientCall(_ method: String, params: JSONValue, timeout: Duration) throws(GatewayRPCError)
    -> (id: JSONRPCID, promise: Promise<RPCReply<JSONValue>>)
  {
    guard socket?.channel != nil else {
      throw GatewayRPCError(.notConnected, GatewayRPCError.notConnectedMessage)
    }

    return try channelCall(method, params: params, timeout: timeout)
  }

  /// `JsonRpcRequestChannel.request` up to its promise.
  func channelCall(_ method: String, params: JSONValue, timeout: Duration) throws(GatewayRPCError)
    -> (id: JSONRPCID, promise: Promise<RPCReply<JSONValue>>)
  {
    guard let outbox = attachedOutbox else {
      throw GatewayRPCError(.notConnected, GatewayRPCError.notConnectedMessage)
    }

    let id = requestIDs.next()

    guard let data = try? JSONRPCRequest(id: id, method: method, params: params).jsonValue.canonicalData() else {
      throw GatewayRPCError(.unencodable, "The request could not be written as JSON: \(method)")
    }

    let promise = Promise<RPCReply<JSONValue>>()
    var call = PendingCall(promise: promise, serial: nextCallSerial)
    nextCallSerial += 1

    if timeout > .zero {
      call.timer = schedule(after: timeout) { connection, _ in
        await connection.callTimedOut(id, method: method, timeout: timeout)
      }
    }

    pending[id] = call
    outbox.yield(.text(String(decoding: data, as: UTF8.self)))
    return (id, promise)
  }

  func callTimedOut(_ id: JSONRPCID, method: String, timeout: Duration) {
    guard let call = pending.removeValue(forKey: id) else {
      return
    }

    // The configured window is in the message, so a reader can tell whether
    // the default fired or a per-call override.
    let seconds = Int((timeout.milliseconds / 1000 + 0.5).rounded(.down))
    call.promise.reject(GatewayRPCError(.timeout, "request timed out after \(seconds)s: \(method)"))
  }

  /// The caller's task was cancelled: drop the call at once, no dangling timer.
  func abandonCall(_ id: JSONRPCID) {
    guard let call = pending.removeValue(forKey: id) else {
      return
    }

    call.timer?.timer.cancel()
    call.promise.reject(CancellationError())
  }

  // MARK: Inbound frames

  /// `handleFrame`: route one inbound text frame, `index` its place on the
  /// wire (see `WireOrder.swift`). Text that is not JSON, or JSON that is not
  /// an object, is ignored.
  func handleFrame(_ text: String, index: UInt64) {
    guard let value = try? JSONValue(parsing: text), let frame = InboundFrame(jsonValue: value) else {
      return
    }

    // Any inbound frame counts as liveness (the desktop and web contract).
    heartbeat.lastLivenessAt = clock.now

    switch frame {
    case .serverRequest(let request):
      guard let id = request.id, let method = request.method else {
        return
      }

      deliverRequest(id: id, method: method, params: request.params, replayed: false, index: index)

    case .response(let response):
      guard let id = response.id else {
        return
      }

      if case .string(let text) = id, heartbeat.acknowledge(text) {
        heartbeat.lastLivenessAt = clock.now
        return
      }

      guard let call = pending.removeValue(forKey: id) else {
        return
      }

      heartbeat.lastLivenessAt = clock.now
      call.timer?.timer.cancel()

      switch response.outcome {
      case .failure:
        call.promise.reject(GatewayRPCError.rejected(response.json["error"] ?? .null))
      case .success(let result):
        // `session.resume`, `session.activate` and `session.events.since`
        // answer with the server requests still waiting on the session. They
        // are re-delivered before the caller sees the result, over the socket
        // that owns them.
        deliverOpenRequests(in: result, index: index)
        call.promise.resolve(RPCReply(index: index, result: result, listedRequests: listedRequests(for: call)))
      }

    case .event(let notification):
      let event = notification.event

      if event.type == GatewayEventType.gatewayReady {
        advertiseCapabilities()
      }

      handleEvent(WireEvent(index: index, event: event))

    case .other:
      return
    }
  }

  /// Tell the backend, once per connection generation, that this client answers
  /// server→client requests. Without it a backend treats a WebSocket client as
  /// a build that predates them and fails every clarify and approval at once.
  /// An older backend answers `-32601`; that is ignored.
  ///
  /// With a `confirm` source or `Options.requests` the announcement is the contract's
  /// two calls: the first result decides the second (`ConfirmAdvertisement.secondCall`
  /// and `RequestsAdvertisement.methods`), and the source hears what came back. Every
  /// call replaces the advertisement at the gateway, so on a socket that already
  /// advertised levels or methods the first call repeats them: a request raised
  /// between the two calls still finds this client. When the second call would
  /// advertise nothing, it withdraws them.
  func advertiseCapabilities() {
    guard options.confirm != nil || options.requests?.isEmpty == false else {
      _ = try? channelCall(
        RPC.ClientCapabilities.name,
        params: ["server_requests": true],
        timeout: options.requestTimeout
      )
      return
    }

    let carried = confirmAdvertised
    let params = carried ?? ClientCapabilitiesParams(serverRequests: true)

    guard let generation = attachedGeneration,
      let (_, first) = try? channelCall(RPC.ClientCapabilities.name, params: params.jsonValue, timeout: options.requestTimeout)
    else {
      return
    }

    // The methods the first call repeats stay deliverable until the second call replaces them.
    requestsAdvertised = Set(params.requests ?? [])
    spawn { await self.completeCapabilities(first, generation: generation, carried: carried != nil) }
  }

  /// Run the two-step announcement again on the live socket: what the app can do
  /// changed (a passkey was enrolled or removed). Nothing happens without a
  /// `confirm` source or `Options.requests`, or a ready socket; the next `gateway.ready`
  /// runs it anyway.
  public func refreshCapabilities() {
    guard options.confirm != nil || options.requests?.isEmpty == false, attachedGeneration != nil,
      currentPhase == .ready
    else {
      return
    }

    advertiseCapabilities()
  }

  private func completeCapabilities(
    _ first: Promise<RPCReply<JSONValue>>,
    generation: UInt64,
    carried: Bool
  ) async {
    let source = options.confirm
    let parsed = (try? await first.value().result).flatMap(ClientCapabilitiesResult.init(jsonValue:))
    // Without a source this client shows no `confirm` and has no passkey: `secondCall` decides nothing.
    let policy = source?.policy ?? ConfirmCapabilityPolicy()
    let verdict = ConfirmAdvertisement.verdict(parsed?.confirmPasskey, policy: policy.passkey)
    var decided = parsed.flatMap { ConfirmAdvertisement.secondCall(after: $0, policy: policy) }
    let methods = parsed.map { RequestsAdvertisement.methods(after: $0, device: options.requests) } ?? []

    if !methods.isEmpty {
      var withRequests = decided ?? ClientCapabilitiesParams(serverRequests: true)
      withRequests.requests = methods
      decided = withRequests
    }

    // The first call repeated levels or methods this client may no longer offer: without a second
    // call of its own, the second call takes them back.
    let withdrawal = carried ? ClientCapabilitiesParams(serverRequests: true) : nil

    // Re-check after the suspension: the socket the first call went out on may be gone.
    guard attachedGeneration == generation, parsed != nil, let params = decided ?? withdrawal,
      let (_, second) = try? channelCall(RPC.ClientCapabilities.name, params: params.jsonValue, timeout: options.requestTimeout)
    else {
      if attachedGeneration == generation {
        requestsAdvertised = []
        requestsListedSince = [:]
      }

      source?.record(ConfirmCapabilityReport(first: parsed, verdict: verdict, accepted: []))
      return
    }

    // A request can arrive before the answer: it is deliverable from the moment the call is sent.
    requestsAdvertised = Set(params.requests ?? [])

    let answer = (try? await second.value().result).flatMap(ClientCapabilitiesResult.init(jsonValue:))
    let wanted = Set(params.confirm ?? [])
    let accepted = (answer?.confirm ?? []).filter { wanted.contains($0) }
    let wantedRequests = Set(params.requests ?? [])
    let acceptedRequests = (answer?.requests ?? []).filter { wantedRequests.contains($0) }
    // Advertised but refused: the gateway did not take it after all.
    let outcome = verdict == .advertised && !accepted.contains(.passkey) ? .notOffered : verdict
    let report = ConfirmCapabilityReport(
      first: parsed, verdict: outcome, accepted: accepted, acceptedRequests: acceptedRequests)

    // Re-check after the suspension: only the socket the calls went out on is described.
    guard attachedGeneration == generation else {
      source?.record(report)
      return
    }

    let gained =
      (accepted.contains(.passkey) && confirmAdvertised?.confirm?.contains(.passkey) != true)
      || (!acceptedRequests.isEmpty && Set(confirmAdvertised?.requests ?? []) != Set(acceptedRequests))
    requestsAdvertised = Set(acceptedRequests)
    noteListed(acceptedRequests)
    confirmAdvertised = Self.advertisement(params, accepted: accepted, requests: acceptedRequests)
    source?.record(report)

    if gained {
      refetchOpenRequests()
    }
  }

  /// The gateway's answer accepting `methods` is in: a call made from now on reads complete lists
  /// of their open requests. A method accepted before keeps the serial it had (the first call of a
  /// refresh repeated it, so it was never withdrawn); one no longer accepted has none.
  private func noteListed(_ methods: [String]) {
    var since: [String: UInt64] = [:]

    for method in methods {
      since[method] = requestsListedSince[method] ?? nextCallSerial
    }

    requestsListedSince = since
  }

  /// The interactive methods whose open requests the answer to `call` lists in full: the ones the
  /// socket had accepted before the call went out. A call made earlier (a reconnect's resume that
  /// raced the second `client.capabilities` call) may lack them.
  func listedRequests(for call: PendingCall) -> Set<String> {
    Set(requestsListedSince.compactMap { method, since in call.serial >= since ? method : nil })
  }

  /// What the gateway holds for this socket after a call with `params`: the levels it accepted,
  /// the passkey block only with `passkey` among them, and the interactive methods it accepted;
  /// `nil` for none.
  nonisolated static func advertisement(
    _ params: ClientCapabilitiesParams,
    accepted: [ConfirmLevel],
    requests: [String] = []
  ) -> ClientCapabilitiesParams? {
    guard !accepted.isEmpty || !requests.isEmpty else {
      return nil
    }

    var held = ClientCapabilitiesParams(serverRequests: true)

    if !accepted.isEmpty {
      held.confirm = accepted
      held.confirmPasskey = accepted.contains(.passkey) ? params.confirmPasskey : nil
    }

    if !requests.isEmpty {
      held.requests = requests
    }

    return held
  }

  /// The gateway shows a request gated at `passkey`, or one of the interactive methods, only to a
  /// connection that advertised it, and the reconnect replay asks before the second call has.
  /// Once a socket gains the level or the methods, the open requests of every session this
  /// connection knows are read again: their
  /// answers re-deliver what is still open (`deliverOpenRequests`). Their events are not
  /// dispatched; the socket has delivered those live since it opened, and the replay the rest.
  func refetchOpenRequests() {
    var sessions = attachedSessions

    for session in replay.watermarks.keys where !sessions.contains(session) {
      sessions.append(session)
    }

    for session in sessions {
      let lastSeen = replay.watermarks[session] ?? 0
      let params: JSONValue = ["session_id": .string(session), "last_seen": .number(lastSeen)]
      _ = try? clientCall(RPC.SessionEventsSince.name, params: params, timeout: ReplayState.requestTimeout)
    }
  }

  // MARK: Server→client requests

  private func deliverOpenRequests(in result: JSONValue, index: UInt64) {
    guard let open = result["open_requests"]?.arrayValue else {
      return
    }

    for entry in open {
      guard let id = entry["id"]?.stringValue, let method = entry["method"]?.stringValue else {
        continue
      }

      deliverRequest(
        id: id,
        method: method,
        params: entry["params"]?.objectValue ?? [:],
        replayed: true,
        index: index
      )
    }
  }

  /// Hand an `approval`, a `clarify`, a one-string prompt (`secret`, `sudo`,
  /// `vault.*`), a `confirm` this client announced, or an interactive request
  /// (`input.form`, ...) it advertised and had accepted to the app; answer
  /// everything else, and these when nobody is listening, `-32601` so the
  /// backend never waits out its deadline against a client that cannot answer.
  ///
  /// A method the app cannot show still reaches a listener, already answered
  /// (answering it again sends nothing), so the app can tell the person why
  /// the bot stalled.
  func deliverRequest(id: String, method: String, params: JSONObject, replayed: Bool, index: UInt64) {
    let request = ServerRequest(id: id, method: method, params: params)
    let listening = requestHub.hasSubscribers
    let supported: Bool

    switch request.body {
    case .approval, .clarify, .secret, .sudo, .vaultUnlock, .vaultCode, .vaultSaveLogin:
      supported = true
    case .confirm:
      // Only a connection that announced `confirm` has someone to answer it.
      supported = options.confirm != nil
    case .inputForm, .inputFile, .reviewDraft:
      // Only a socket that advertised the method (and had it accepted) has someone to answer it;
      // a stray one is answered like any method nobody handles.
      supported = requestsAdvertised.contains(method)
    case .unknown:
      supported = false
    }

    guard supported, listening else {
      if let answer = request.fail(code: JSONRPCError.methodNotFound, message: Self.unsupportedMessage(method)) {
        send(answer.jsonValue)
      }

      if listening {
        nextDeliveryToken += 1
        requestHub.publish(
          ServerRequestDelivery(
            request: request, replayed: replayed, index: index, token: nextDeliveryToken, connection: self,
            declined: true)
        )
      }
      return
    }

    nextDeliveryToken += 1
    let token = nextDeliveryToken
    openDeliveries.insert(token)
    requestHub.publish(
      ServerRequestDelivery(request: request, replayed: replayed, index: index, token: token, connection: self)
    )
  }

  /// The `-32601` message for a server request this client cannot show.
  nonisolated static func unsupportedMessage(_ method: String) -> String {
    "not supported by this client: \(method)"
  }

  /// The app's answer to one delivery. The first answer goes out, over the
  /// socket the request arrived on; later ones, and any for a socket that has
  /// gone (`dropSocket` forgets its deliveries), are dropped.
  func answer(_ token: UInt64, with frame: JSONRPCResponse) -> Bool {
    guard openDeliveries.remove(token) != nil else {
      return false
    }

    return send(frame.jsonValue)
  }

  // MARK: Heartbeat

  /// `startHeartbeat`: only when `gateway.ready` advertised it.
  func startHeartbeat() {
    stopHeartbeat()
    heartbeat.lastLivenessAt = clock.now

    guard let generation = attachedGeneration, options.heartbeatInterval > .zero, options.heartbeatDeadline > .zero
    else {
      return
    }

    scheduleHeartbeat(for: generation)
  }

  private func scheduleHeartbeat(for generation: UInt64) {
    heartbeatTimer = schedule(after: options.heartbeatInterval) { connection, id in
      await connection.heartbeatTick(id, generation: generation)
    }
  }

  private func heartbeatTick(_ id: UInt64, generation: UInt64) {
    guard heartbeatTimer?.id == id else {
      return
    }

    // An interval that outlived its generation does nothing.
    guard attachedGeneration == generation else {
      heartbeatTimer = nil
      return
    }

    // An interval: the next tick is due whatever this one finds.
    scheduleHeartbeat(for: generation)

    switch heartbeat.tick(now: clock.now, deadline: options.heartbeatDeadline) {
    case .dead:
      stopHeartbeat()
      invalidate(HeartbeatState.failureMessage)
    case .ping(let pingID):
      send(JSONRPCRequest(id: .string(pingID), method: RPC.GatewayPing.name).jsonValue)
    }
  }

  func stopHeartbeat() {
    heartbeat.stop()
    heartbeatTimer?.timer.cancel()
    heartbeatTimer = nil
  }
}
