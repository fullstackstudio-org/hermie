import Foundation
import Network
import Synchronization

/// A one-response-per-connection HTTP/1.1 server on 127.0.0.1, for the few
/// tests where a real socket has to say what `URLSession` actually sends.
final class LoopbackHTTPServer: Sendable {
  typealias Responder = @Sendable (_ requestHead: String) -> String

  /// The request heads seen so far, shared with the connection handlers.
  private final class Log: Sendable {
    let heads = Mutex<[String]>([])
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "LoopbackHTTPServer")
  private let log = Log()

  /// Every request head received (request line and headers).
  var requests: [String] { log.heads.withLock { $0 } }

  init(_ respond: @escaping Responder) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)

    let log = log
    let queue = queue

    listener.newConnectionHandler = { connection in
      connection.start(queue: queue)
      Self.receive(connection, buffer: Data(), log: log, respond: respond)
    }
  }

  /// Start listening and return the port.
  func start() async throws -> UInt16 {
    let listener = listener
    let queue = queue

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let once = Once()

      listener.stateUpdateHandler = { update in
        switch update {
        case .ready:
          if once.claim() {
            continuation.resume(returning: listener.port?.rawValue ?? 0)
          }
        case .failed(let error):
          if once.claim() {
            continuation.resume(throwing: error)
          }
        default:
          break
        }
      }

      listener.start(queue: queue)
    }
  }

  func stop() {
    listener.cancel()
  }

  private final class Once: Sendable {
    private let done = Mutex(false)

    func claim() -> Bool {
      done.withLock { done in
        defer { done = true }
        return !done
      }
    }
  }

  private static func receive(_ connection: NWConnection, buffer: Data, log: Log, respond: @escaping Responder) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      var buffer = buffer

      if let data {
        buffer.append(data)
      }

      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        log.heads.withLock { $0.append(head) }
        connection.send(content: Data(respond(head).utf8), completion: .contentProcessed { _ in connection.cancel() })
        return
      }

      if isComplete || error != nil {
        connection.cancel()
        return
      }

      receive(connection, buffer: buffer, log: log, respond: respond)
    }
  }
}
