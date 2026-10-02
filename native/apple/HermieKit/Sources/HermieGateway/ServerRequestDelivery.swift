import HermieProtocol

/// One server→client request the app is asked to answer: an `approval` or a
/// `clarify`. Every other method is answered `-32601` by the connection itself
/// and never reaches the app.
///
/// Answering is idempotent: the first `respond` or `fail` goes out, later ones
/// are dropped, as `JsonRpcRequestChannel.deliverRequest` guards its `send`.
/// The answer travels over whatever socket is current when it is given, which
/// after a reconnect is a newer one than the request arrived on; the backend
/// keys the answer on the request id, so that is what it expects.
public struct ServerRequestDelivery: Sendable {
  /// The request as it arrived: `id`, `method`, `params`, and `body`, its typed reading.
  public let request: ServerRequest
  /// True when it was re-delivered from a reconnect's `open_requests` rather
  /// than arriving live, so a screen that already shows it can skip a
  /// second notification.
  public let replayed: Bool

  let token: UInt64
  let connection: GatewayConnection

  /// The typed reading: `.approval` or `.clarify`.
  public var body: ServerRequestBody { request.body }

  /// Answer with a result object.
  public func respond(_ result: JSONObject) async {
    guard let frame = request.respond(.object(result)) else {
      return
    }

    await connection.answer(token, with: frame)
  }

  /// Answer with a JSON-RPC error; the backend treats the request as unanswered.
  public func fail(code: Int, message: String) async {
    guard let frame = request.fail(code: code, message: message) else {
      return
    }

    await connection.answer(token, with: frame)
  }
}

/// Why a JSON-RPC call failed. The messages are the reference's own, so a log
/// line reads the same on both generations.
public struct GatewayRPCError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// No open socket (`gateway not connected`).
    case notConnected
    /// No answer in the call's window (`request timed out after Ns: method`).
    case timeout
    /// The socket went away with the call in flight; the message says how.
    case closed
    /// The gateway answered with a JSON-RPC error; `code` and `data` carry it.
    case rejected
    /// The params could not be written as JSON (a non-finite number).
    case unencodable
    /// The result does not have the shape the typed method promises.
    case unexpectedResult
  }

  public var kind: Kind
  public var message: String
  /// The JSON-RPC error code, for `rejected`.
  public var code: Int?
  /// The JSON-RPC error data, for `rejected`.
  public var data: JSONValue?

  public init(_ kind: Kind, _ message: String, code: Int? = nil, data: JSONValue? = nil) {
    self.kind = kind
    self.message = message
    self.code = code
    self.data = data
  }

  /// `notConnectedErrorMessage` of the vendored client.
  static let notConnectedMessage = "gateway not connected"
  /// `closedErrorMessage` of the vendored client.
  static let closedMessage = "WebSocket closed"

  /// `jsonRpcErrorFromFrame`: the message when there is a non-empty one, else
  /// `Hermes RPC failed`; the code when it is a number; the data as it came.
  static func rejected(_ raw: JSONValue) -> GatewayRPCError {
    let object = raw.objectValue ?? [:]
    let message = object["message"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Hermes RPC failed"
    let code = object["code"]?.doubleValue.flatMap { Int(exactly: $0) }
    return GatewayRPCError(.rejected, message, code: code, data: object["data"])
  }
}
