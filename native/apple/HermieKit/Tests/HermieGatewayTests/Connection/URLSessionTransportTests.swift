#if canImport(Network)
  import Foundation
  import Network
  import Synchronization
  import Testing

  @testable import HermieGateway

  // `URLSessionTransport` against real sockets on the loopback interface: a
  // small WebSocket server built on Network.framework, and a raw TCP one for
  // the redirect. No other test touches the network.

  @Suite("URLSessionTransport on a loopback socket")
  struct URLSessionTransportTests {
    @Test("opens with the plan's subprotocols and headers, carries text both ways, and reports the close code and reason")
    func opensCarriesAndCloses() async throws {
      let server = try await LoopbackWebSocketServer.start()
      defer { server.stop() }

      var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(server.port)/api/ws")!)
      request.setValue("x", forHTTPHeaderField: "CF-Access-Client-Id")
      let channel = try await URLSessionTransport().connect(
        request,
        subprotocols: ["hermes-gateway-v1", "hermes-gateway-ticket.tk-1"]
      )

      #expect(server.offeredSubprotocols == ["hermes-gateway-v1", "hermes-gateway-ticket.tk-1"])
      #expect(server.headers["cf-access-client-id"] == "x")

      var frames = channel.frames.makeAsyncIterator()
      #expect(try await frames.next() == "hello")

      try await channel.send(text: "echo me")
      #expect(try await frames.next() == "echo me")

      try await channel.send(text: "close-4401")
      await #expect(throws: WebSocketClosed(code: 4401, reason: "unauthorized")) {
        _ = try await frames.next()
      }
    }

    @Test("a refused upgrade is the reference's one connect error")
    func refusedUpgrade() async throws {
      let server = try await LoopbackHTTPServer.start(
        answering: "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      )
      defer { server.stop() }

      let request = URLRequest(url: URL(string: "ws://127.0.0.1:\(server.port)/api/ws")!)
      await #expect(throws: GatewayError(.network, "WebSocket connection failed")) {
        _ = try await URLSessionTransport().connect(request, subprotocols: [])
      }
    }

    @Test("a redirect on the upgrade is refused as a redirect, never followed")
    func redirectIsNotFollowed() async throws {
      let target = try await LoopbackWebSocketServer.start()
      defer { target.stop() }
      let redirecting = try await LoopbackHTTPServer.start(
        answering: "HTTP/1.1 301 Moved Permanently\r\nLocation: ws://127.0.0.1:\(target.port)/api/ws?token=secret\r\n"
          + "Content-Length: 0\r\nConnection: close\r\n\r\n"
      )
      defer { redirecting.stop() }

      let request = URLRequest(url: URL(string: "ws://127.0.0.1:\(redirecting.port)/api/ws?token=t")!)
      let expected = GatewayError(
        .redirect,
        "ws://127.0.0.1:\(redirecting.port) redirected to ws://127.0.0.1:\(target.port), which is a different address. "
          + "Nothing was read from it. Change the gateway address to the one you meant.",
        status: 301,
        redirectedTo: "127.0.0.1",
        redirectedOrigin: "ws://127.0.0.1:\(target.port)"
      )
      await #expect(throws: expected) {
        _ = try await URLSessionTransport().connect(request, subprotocols: [])
      }
      #expect(target.connectionCount == 0)
    }

    @Test("carries a frame larger than URLSession's 1 MiB default")
    func carriesALargeFrame() async throws {
      let server = try await LoopbackWebSocketServer.start()
      defer { server.stop() }

      let request = URLRequest(url: URL(string: "ws://127.0.0.1:\(server.port)/api/ws")!)
      let channel = try await URLSessionTransport().connect(request, subprotocols: [])
      var frames = channel.frames.makeAsyncIterator()
      #expect(try await frames.next() == "hello")

      try await channel.send(text: "big")
      let big = try await frames.next()
      #expect(big?.utf8.count == LoopbackWebSocketServer.bigFrameBytes)
    }

    @Test("the redirect error names what changed and never a query")
    func redirectWording() {
      let advice = "Nothing was read from it. Change the gateway address to the one you meant."
      let other = SocketDelegate.redirectError(
        asked: "wss://gateway.test/api/ws?token=secret", landed: "wss://elsewhere.test/api/ws?token=secret", status: 302)
      #expect(other.message == "gateway.test redirected to elsewhere.test, which is a different host. \(advice)")
      #expect(other.redirectedTo == "elsewhere.test")
      #expect(other.redirectedOrigin == "wss://elsewhere.test")

      let downgrade = SocketDelegate.redirectError(
        asked: "wss://gateway.test/api/ws", landed: "ws://gateway.test/api/ws", status: 301)
      #expect(downgrade.message == "wss://gateway.test redirected to ws://gateway.test, which is not https. \(advice)")

      let nowhere = SocketDelegate.redirectError(
        asked: "ws://gateway.test/api/ws?token=secret", landed: nil, status: 307)
      #expect(nowhere.message == "ws://gateway.test answered with a redirect that was not followed. \(advice)")
      #expect(nowhere.redirectedOrigin == nil)

      for error in [other, downgrade, nowhere] {
        #expect(!error.message.contains("secret"))
      }
    }

    @Test("closing from the client ends the frames")
    func clientClose() async throws {
      let server = try await LoopbackWebSocketServer.start()
      defer { server.stop() }

      let request = URLRequest(url: URL(string: "ws://127.0.0.1:\(server.port)/api/ws")!)
      let channel = try await URLSessionTransport().connect(request, subprotocols: [])
      var frames = channel.frames.makeAsyncIterator()
      #expect(try await frames.next() == "hello")

      await channel.close(code: WebSocketClosed.normalClosure, reason: nil)
      await #expect(throws: WebSocketClosed.self) {
        _ = try await frames.next()
      }
    }
  }

  /// A WebSocket server on 127.0.0.1: greets with "hello", echoes text, and
  /// closes with 4401 "unauthorized" when sent "close-4401".
  final class LoopbackWebSocketServer: Sendable {
    private struct State {
      var subprotocols: [String] = []
      var headers: [String: String] = [:]
      var connections = 0
    }

    private final class Storage: Sendable {
      let state = Mutex(State())
    }

    /// A frame past URLSession's 1 MiB default, as a large `session.resume` is.
    static let bigFrameBytes = 2 * 1024 * 1024 + 1

    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback-websocket")
    private let storage = Storage()

    var offeredSubprotocols: [String] { storage.state.withLock { $0.subprotocols } }
    var headers: [String: String] { storage.state.withLock { $0.headers } }
    var connectionCount: Int { storage.state.withLock { $0.connections } }
    var port: UInt16 { listener.port?.rawValue ?? 0 }

    private init() throws {
      let websocket = NWProtocolWebSocket.Options()
      websocket.maximumMessageSize = 16 * 1024 * 1024

      let storage = self.storage
      websocket.setClientRequestHandler(queue) { subprotocols, headers in
        storage.state.withLock { state in
          // Network.framework splits the list without trimming; the gateway trims.
          state.subprotocols = subprotocols.map { $0.trimmingCharacters(in: .whitespaces) }
          state.headers = Dictionary(
            headers.map { ($0.name.lowercased(), $0.value) },
            uniquingKeysWith: { _, last in last }
          )
        }

        return NWProtocolWebSocket.Response(status: .accept, subprotocol: subprotocols.first, additionalHeaders: nil)
      }

      // Configured before it goes into the stack: the parameters copy it.
      let parameters = NWParameters.tcp
      parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
      parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
      listener = try NWListener(using: parameters)

      let queue = self.queue
      listener.newConnectionHandler = { connection in
        storage.state.withLock { $0.connections += 1 }
        connection.stateUpdateHandler = { update in
          if case .ready = update {
            Self.send(text: "hello", on: connection)
            Self.receive(on: connection)
          }
        }
        connection.start(queue: queue)
      }
    }

    static func start() async throws -> LoopbackWebSocketServer {
      let server = try LoopbackWebSocketServer()
      try await server.listener.ready(on: server.queue)
      return server
    }

    func stop() {
      listener.cancel()
    }

    private static func send(text: String, on connection: NWConnection) {
      let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
      let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
      connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent)
    }

    private static func receive(on connection: NWConnection) {
      connection.receiveMessage { data, context, _, error in
        guard error == nil, let data else {
          connection.cancel()
          return
        }

        let metadata =
          context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
        guard metadata?.opcode == .text else {
          receive(on: connection)
          return
        }

        let text = String(decoding: data, as: UTF8.self)

        if text == "big" {
          send(text: String(repeating: "x", count: bigFrameBytes), on: connection)
          receive(on: connection)
          return
        }

        if text == "close-4401" {
          let close = NWProtocolWebSocket.Metadata(opcode: .close)
          close.closeCode = .privateCode(4401)
          let closeContext = NWConnection.ContentContext(identifier: "close", metadata: [close])
          connection.send(
            content: Data("unauthorized".utf8),
            contentContext: closeContext,
            isComplete: true,
            completion: .contentProcessed { _ in }
          )
          return
        }

        send(text: text, on: connection)
        receive(on: connection)
      }
    }
  }

  /// A plain HTTP server on 127.0.0.1 that answers every request with one
  /// canned response (a 403, a 301), never an upgrade.
  final class LoopbackHTTPServer: Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "loopback-http")

    var port: UInt16 { listener.port?.rawValue ?? 0 }

    private init(answering text: String) throws {
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
      listener = try NWListener(using: parameters)

      let response = Data(text.utf8)
      let queue = self.queue
      listener.newConnectionHandler = { connection in
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, _ in
          connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
        }
      }
    }

    static func start(answering text: String) async throws -> LoopbackHTTPServer {
      let server = try LoopbackHTTPServer(answering: text)
      try await server.listener.ready(on: server.queue)
      return server
    }

    func stop() {
      listener.cancel()
    }
  }

  extension NWListener {
    /// Start listening and wait until the port is bound.
    fileprivate func ready(on queue: DispatchQueue) async throws {
      let resumed = Once()

      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        stateUpdateHandler = { state in
          let outcome: Result<Void, any Error>?

          switch state {
          case .ready: outcome = .success(())
          case .failed(let error): outcome = .failure(error)
          case .cancelled: outcome = .failure(CancellationError())
          default: outcome = nil
          }

          guard let outcome, resumed.first() else {
            return
          }

          continuation.resume(with: outcome)
        }
        start(queue: queue)
      }
    }
  }
  /// True exactly once.
  private final class Once: Sendable {
    private let fired = Mutex(false)

    func first() -> Bool {
      fired.withLock { fired in
        defer { fired = true }
        return !fired
      }
    }
  }
#endif
