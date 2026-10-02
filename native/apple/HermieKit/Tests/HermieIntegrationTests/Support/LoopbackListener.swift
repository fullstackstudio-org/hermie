#if os(macOS)
import Foundation
import Network
import Synchronization

/// A second local listener beside the fake gateway: one canned HTTP/1.1
/// answer per connection on 127.0.0.1, and a log of every request head it got.
/// It plays the "somewhere else" a redirect points at, or the redirect itself.
final class LoopbackListener: Sendable {
  typealias Responder = @Sendable (_ requestHead: String) -> String

  private let listener: NWListener
  private let queue = DispatchQueue(label: "LoopbackListener")
  private let log = RequestLog()

  /// Every request head received (request line and headers), oldest first.
  var requests: [String] { log.heads.withLock { $0 } }

  private final class RequestLog: Sendable {
    let heads = Mutex<[String]>([])
  }

  /// `http://127.0.0.1:<port>`, once started.
  private let started = Mutex<UInt16>(0)
  var port: UInt16 { started.withLock { $0 } }
  var origin: String { "http://127.0.0.1:\(port)" }

  /// - Parameter hangUpOnTLS: close a connection whose first byte opens a TLS
  ///   handshake record, without answering: a plain server that does not speak TLS.
  init(hangUpOnTLS: Bool = false, _ respond: @escaping Responder) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)

    let queue = queue
    let log = log
    let record: @Sendable (String) -> Void = { head in log.heads.withLock { $0.append(head) } }

    listener.newConnectionHandler = { connection in
      connection.start(queue: queue)
      Self.receive(connection, buffer: Data(), hangUpOnTLS: hangUpOnTLS, record: record, respond: respond)
    }
  }

  /// A canned answer: status line, `Content-Length`, `Connection: close`, extra headers, body.
  static func reply(_ status: String, headers: [String] = [], body: String = "") -> String {
    (["HTTP/1.1 \(status)", "Content-Length: \(body.utf8.count)", "Connection: close"] + headers)
      .joined(separator: "\r\n") + "\r\n\r\n" + body
  }

  /// Start listening; returns the port.
  @discardableResult
  func start() async throws -> UInt16 {
    let listener = listener
    let queue = queue
    let claimed = Mutex(false)

    let port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let claim: @Sendable () -> Bool = {
        claimed.withLock { done in
          defer { done = true }
          return !done
        }
      }

      listener.stateUpdateHandler = { update in
        switch update {
        case .ready:
          if claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
        case .failed(let error):
          if claim() { continuation.resume(throwing: error) }
        case .cancelled:
          if claim() { continuation.resume(throwing: CancellationError()) }
        default:
          break
        }
      }

      listener.start(queue: queue)
    }

    started.withLock { $0 = port }
    return port
  }

  func stop() {
    listener.cancel()
  }

  private static func receive(
    _ connection: NWConnection,
    buffer: Data,
    hangUpOnTLS: Bool,
    record: @escaping @Sendable (String) -> Void,
    respond: @escaping Responder
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      var buffer = buffer

      if let data {
        buffer.append(data)
      }

      // 0x16: a TLS handshake record, which a ClientHello always is.
      if hangUpOnTLS, buffer.first == 0x16 {
        connection.cancel()
        return
      }

      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        record(head)
        connection.send(content: Data(respond(head).utf8), completion: .contentProcessed { _ in connection.cancel() })
        return
      }

      if isComplete || error != nil {
        connection.cancel()
        return
      }

      receive(connection, buffer: buffer, hangUpOnTLS: hangUpOnTLS, record: record, respond: respond)
    }
  }
}
#endif
