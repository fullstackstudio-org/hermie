import Foundation
import HermieProtocol

// The socket layer: the port of the vendored `JsonRpcGatewayClient`
// (`packages/hermes-shared/src/json-rpc-gateway.ts`). One socket generation at
// a time, the `idle → connecting → open → closed | error` state the dial loop
// listens to, event dispatch, and the reconnect replay.

/// `ConnectionState` of the vendored client.
enum ClientState: Equatable {
  case idle
  case connecting
  case open
  case closed
  case error
}

/// One socket, from the moment it is dialled until it is dropped.
struct SocketGeneration {
  let id: UInt64
  /// Set once the upgrade completed; `nil` while handshaking or after a failed one.
  var channel: (any WebSocketChannel)?
  /// The frames waiting to be written, in order.
  var outbox: AsyncStream<String>.Continuation?
  /// The task running `transport.connect`, cancelled if the socket is dropped first.
  var connectTask: UInt64?
}

/// The open handshake of one generation, settled once.
struct Handshake {
  let generation: UInt64
  let promise: Promise<Void>
  var timer: TimerSlot?
}

extension GatewayConnection {
  /// `connectErrorMessage` of the vendored client.
  static let connectErrorMessage = "WebSocket connection failed"

  /// `client.connect(url)`: dial one socket and return once it is open.
  func connectSocket(_ plan: DialPlan) async throws {
    // Refuse anything but a ws:// or wss:// URL. The reference quotes the URL
    // it got; a session-token URL carries the token, so this does not.
    guard WebSocketDial.isWebSocketURL(plan.url), let request = WebSocketDial.request(for: plan) else {
      throw GatewayError(.network, "gateway connect() requires a ws:// or wss:// URL string")
    }

    if socket?.channel != nil || clientState == .connecting {
      return
    }

    setClientState(.connecting)

    nextGeneration += 1
    let generation = nextGeneration
    socket = SocketGeneration(id: generation)
    stopHeartbeat()

    let promise = Promise<Void>()
    var handshake = Handshake(generation: generation, promise: promise)

    if options.connectTimeout > .zero {
      handshake.timer = schedule(after: options.connectTimeout) { connection, _ in
        await connection.handshakeTimedOut(generation)
      }
    }

    self.handshake = handshake

    let transport = self.transport
    let subprotocols = plan.protocols
    socket?.connectTask = spawn {
      do {
        let channel = try await transport.connect(request, subprotocols: subprotocols)
        await self.socketOpened(generation, channel)
      } catch {
        await self.socketFailedToOpen(generation, error)
      }
    }

    try await promise.value()
  }

  /// The upgrade completed.
  func socketOpened(_ generation: UInt64, _ channel: any WebSocketChannel) {
    // Re-check after the suspension: the handshake may have timed out, or the
    // generation may have been dropped, while the transport was connecting.
    // The reference closed that socket before it opened; one that opens anyway
    // is closed here.
    guard let handshake, handshake.generation == generation, socket?.id == generation else {
      spawn { await channel.close(code: WebSocketClosed.normalClosure, reason: nil) }
      return
    }

    self.handshake = nil
    handshake.timer?.timer.cancel()

    let (frames, outbox) = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
    socket?.channel = channel
    socket?.outbox = outbox
    startWriting(frames, to: channel)
    startReading(channel, generation)

    attach(generation, outbox)
    setClientState(.open)
    handshake.promise.resolve(())
    // Lossless resume: drain the events emitted while the socket was down. The
    // requests go out now, before any frame of the new socket is read.
    fetchReplay()
  }

  /// The transport could not open the socket.
  func socketFailedToOpen(_ generation: UInt64, _ error: any Error) {
    // Re-check after the suspension: only the generation still handshaking may fail.
    guard let handshake, handshake.generation == generation, socket?.id == generation else {
      return
    }

    self.handshake = nil
    handshake.timer?.timer.cancel()
    // The failed generation stays as `socket`, as the reference keeps its
    // errored socket, until a teardown drops it.
    setClientState(.error)
    handshake.promise.reject(
      (error as? GatewayError) ?? GatewayError(.network, Self.connectErrorMessage)
    )
  }

  func handshakeTimedOut(_ generation: UInt64) {
    guard let handshake, handshake.generation == generation else {
      return
    }

    self.handshake = nil

    // Drop the half-open socket so the next connect starts clean instead of
    // short-circuiting on a zombie `connecting` state.
    if let current = socket, current.id == generation {
      if let task = current.connectTask {
        tasks[task]?.cancel()
      }

      socket = nil
      setClientState(.error)
    }

    handshake.promise.reject(GatewayError(.network, Self.connectErrorMessage))
  }

  /// `invalidate(message)`: forget the current generation, fail its calls with
  /// `message`, and close it. The owner decides whether to redial.
  func invalidate(_ message: String) {
    guard let dropped = socket else {
      return
    }

    // Drop the generation before closing, so the close the socket reports later
    // hits the generation guard instead of running the closed path twice.
    dropSocket(GatewayRPCError(.closed, message))

    if let channel = dropped.channel {
      spawn { await channel.close(code: WebSocketClosed.normalClosure, reason: nil) }
      return
    }

    // Still handshaking: closing a connecting socket fails its connect.
    if let task = dropped.connectTask {
      tasks[task]?.cancel()
    }

    if let handshake, handshake.generation == dropped.id {
      self.handshake = nil
      handshake.timer?.timer.cancel()
      handshake.promise.reject(GatewayError(.network, Self.connectErrorMessage))
    }
  }

  /// `dropSocket`: forget the current generation, fail its calls, go `closed`.
  func dropSocket(_ error: GatewayRPCError) {
    // A replay belongs to the socket that started it; the next open may start
    // its own straight away.
    replay.abandon()
    // Its unanswered server requests go with it; the gateway re-delivers those
    // still waiting once a new socket resumes.
    openDeliveries.removeAll()
    socket = nil
    detach(error)
    setClientState(.closed)
  }

  func setClientState(_ state: ClientState) {
    if clientState == state {
      return
    }

    clientState = state

    if state == .closed || state == .error {
      onTransportClosed()
    }
  }

  // MARK: Reading and writing

  /// Feed every inbound frame to the actor in order, then report the close.
  private func startReading(_ channel: any WebSocketChannel, _ generation: UInt64) {
    spawn {
      var closed = WebSocketClosed(code: WebSocketClosed.noStatus)

      do {
        for try await text in channel.frames {
          await self.receive(text, on: generation)
        }
      } catch let error as WebSocketClosed {
        closed = error
      } catch {
        closed = WebSocketClosed(code: WebSocketClosed.abnormalClosure)
      }

      await self.channelClosed(generation, closed)
    }
  }

  /// Write queued frames in the order they were queued.
  ///
  /// A failed write is not acted on: a socket that cannot be written to is
  /// closing, and the reader reports that with the close code the dial loop
  /// needs (a 4401 read as a write failure would be misfiled). The reference's
  /// sockets drop a send on a closing socket silently too.
  private func startWriting(_ frames: AsyncStream<String>, to channel: any WebSocketChannel) {
    spawn {
      for await text in frames {
        try? await channel.send(text: text)
      }
    }
  }

  private func receive(_ text: String, on generation: UInt64) {
    // Re-check after the suspension: the reader hopped here from its stream,
    // and the generation it reads for may have been dropped meanwhile.
    guard socket?.id == generation else {
      return
    }

    wireIndex += 1
    handleFrame(text, index: wireIndex)
  }

  /// The `close` event of the current socket: its code is the verdict the
  /// dial loop reads. A socket already dropped (closed by this side, replaced)
  /// may report its close late; its code says nothing about the next dial.
  private func channelClosed(_ generation: UInt64, _ closed: WebSocketClosed) {
    // Re-check after the suspension: a generation that was already dropped
    // has nothing left to tear down, and no verdict to give.
    guard socket?.id == generation else {
      return
    }

    lastCloseCode = closed.code

    dropSocket(GatewayRPCError(.closed, GatewayRPCError.closedMessage))
  }

  // MARK: Events and replay

  /// `handleEvent`: a decoded `event` notification.
  func handleEvent(_ wire: WireEvent) {
    let event = wire.event

    if event.type == GatewayEventType.gatewayReady {
      if event.payload?["heartbeat"] == .bool(true) {
        startHeartbeat()
      }

      if let epoch = event.payload?["replay_epoch"]?.stringValue, !epoch.isEmpty {
        replay.adopt(epoch: epoch)
      }
    }

    // A replay is in flight for this session: park the frame; the replay's end
    // dispatches it after the gap, gated on seq.
    if replay.park(wire) {
      return
    }

    replay.record(event)
    dispatch(wire)
  }

  /// The connection's own `gateway.ready` handler runs first, as it was
  /// registered first; then every subscriber.
  func dispatch(_ wire: WireEvent) {
    if wire.event.type == GatewayEventType.gatewayReady {
      onGatewayReady(wire.event)
    }

    eventHub.publish(wire)
  }

  /// `dispatchIfNewer`.
  func dispatchIfNewer(_ wire: WireEvent) {
    if replay.admit(wire.event) {
      dispatch(wire)
    }
  }

  /// `fetchReplay`: ask for every event newer than the watermarks, one call per
  /// session. Best effort; a failure is retried by the next reconnect.
  func fetchReplay() {
    guard options.replay, let (generation, entries) = replay.begin() else {
      return
    }

    var calls: [Result<Promise<RPCReply<JSONValue>>, GatewayRPCError>] = []

    for (session, lastSeen) in entries {
      let params: JSONValue = ["session_id": .string(session), "last_seen": .number(lastSeen)]

      do {
        let call = try clientCall(RPC.SessionEventsSince.name, params: params, timeout: ReplayState.requestTimeout)
        calls.append(.success(call.promise))
      } catch {
        calls.append(.failure(error))
      }
    }

    let started = calls
    spawn { await self.completeReplay(generation, started) }
  }

  private func completeReplay(
    _ generation: Int,
    _ calls: [Result<Promise<RPCReply<JSONValue>>, GatewayRPCError>]
  ) async {
    var results: [RPCReply<JSONValue>?] = []

    for call in calls {
      switch call {
      case .success(let promise):
        results.append(try? await promise.value())
      case .failure:
        results.append(nil)
      }
    }

    // Re-check after the suspension: the socket that owned this replay was
    // dropped while its requests were settling. Its results and cleanup must
    // not consume the replacement socket's replay window.
    guard replay.generation == generation else {
      return
    }

    for reply in results {
      guard let reply, let events = reply.result["events"]?.arrayValue else {
        continue
      }

      let result = reply.result

      let epoch = result["epoch"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }

      if let epoch, let current = replay.epoch, epoch != current {
        // The backend restarted: its seq numbering reset, so the watermarks and
        // this replay window are meaningless. Start fresh under the new epoch.
        replay.adopt(epoch: epoch)
        continue
      }

      if let epoch, replay.epoch == nil {
        replay.epoch = epoch
      }

      for element in events {
        // Bare event objects only: an element without a `type` (the full
        // envelope an older server sent) is not dispatched.
        guard case .object(let object) = element, object["type"]?.isTruthy == true else {
          continue
        }

        // A replayed event carries the index of the answer that brought it.
        dispatchIfNewer(WireEvent(index: reply.index, event: GatewayEvent(json: object)))
      }
    }

    for parked in replay.releaseHold() {
      dispatchIfNewer(parked)
    }

    replay.inFlight = false
  }
}
