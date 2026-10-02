import Foundation
import HermieProtocol

// The call layer: the port of the vendored `JsonRpcRequestChannel`
// (`packages/hermes-shared/src/json-rpc-channel.ts`). Request ids, the pending
// map with per-call timeouts, inbound frame routing, server→client requests,
// the capability announcement and the `gateway.ping` heartbeat.

/// One call waiting for its answer.
struct PendingCall {
  let promise: Promise<RPCReply<JSONValue>>
  var timer: TimerSlot?
}

extension GatewayConnection {
  // MARK: Attaching a socket generation

  /// `attach`: bind a new generation. Its heartbeat starts only on `gateway.ready`.
  func attach(_ generation: UInt64, _ outbox: AsyncStream<String>.Continuation) {
    stopHeartbeat()
    attachedGeneration = generation
    attachedOutbox = outbox
    heartbeat.lastLivenessAt = clock.now
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

    outbox.yield(String(decoding: data, as: UTF8.self))
    return true
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
    var call = PendingCall(promise: promise)

    if timeout > .zero {
      call.timer = schedule(after: timeout) { connection, _ in
        await connection.callTimedOut(id, method: method, timeout: timeout)
      }
    }

    pending[id] = call
    outbox.yield(String(decoding: data, as: UTF8.self))
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
        call.promise.resolve(RPCReply(index: index, result: result))
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
  private func advertiseCapabilities() {
    _ = try? channelCall(
      RPC.ClientCapabilities.name,
      params: ["server_requests": true],
      timeout: options.requestTimeout
    )
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

  /// Hand an `approval` or `clarify` to the app; answer everything else, and
  /// these two when nobody is listening, `-32601` so the backend never waits
  /// out its deadline against a client that cannot answer.
  func deliverRequest(id: String, method: String, params: JSONObject, replayed: Bool, index: UInt64) {
    let request = ServerRequest(id: id, method: method, params: params)
    let answerable: Bool

    switch request.body {
    case .approval, .clarify:
      answerable = requestHub.hasSubscribers
    case .unknown:
      answerable = false
    }

    guard answerable else {
      let message = "no handler for server request: \(method)"

      if let answer = request.fail(code: JSONRPCError.methodNotFound, message: message) {
        send(answer.jsonValue)
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

  /// The app's answer to one delivery. The first answer goes out; later ones
  /// are dropped. It travels over the socket that is current now.
  func answer(_ token: UInt64, with frame: JSONRPCResponse) {
    guard openDeliveries.remove(token) != nil else {
      return
    }

    send(frame.jsonValue)
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
