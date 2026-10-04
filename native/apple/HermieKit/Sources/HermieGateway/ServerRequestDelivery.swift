import HermieProtocol

/// One server→client request the app is asked to answer: an `approval`, a
/// `clarify`, or a one-string prompt (`secret`, `sudo`, `vault.*`). Every other
/// method is answered `-32601` by the connection itself; it still reaches the
/// app, already answered (`respond` and `fail` send nothing), so the app can
/// say that it could not show it.
///
/// Answering is idempotent: the first `respond` or `fail` goes out, later ones
/// are dropped, as `JsonRpcRequestChannel.deliverRequest` guards its `send`.
///
/// A delivery belongs to the socket it arrived on. When that socket goes, so
/// does the delivery: answering it returns `false` and sends nothing. The
/// gateway re-delivers every request still waiting, with the same `id` and
/// `replayed: true`, in the `open_requests` of the resume or replay that
/// follows the reconnect, and that delivery is the one to answer. (The
/// TypeScript client sends a late answer over the new socket instead, which the
/// gateway accepts while the request is still open; here the app answers the
/// re-delivered copy, and is told when an answer did not go out.)
///
/// It holds the connection weakly, so a card left on screen keeps nothing alive.
public struct ServerRequestDelivery: Sendable {
  /// The request as it arrived: `id`, `method`, `params`, and `body`, its typed reading.
  public let request: ServerRequest
  /// True when it was re-delivered from a reconnect's `open_requests` rather
  /// than arriving live, so a screen that already shows it can skip a
  /// second notification.
  public let replayed: Bool
  /// The wire index of the frame that brought it: its own, or for a request
  /// re-delivered from `open_requests`, the result's (`WireOrder.swift`).
  public let index: UInt64
  /// True when the connection already answered it `-32601` (a method this client cannot show, or
  /// an interactive one this socket did not have accepted): it is passed on only so the app can
  /// say why the bot stalled, and must not be shown as a question.
  public let declined: Bool

  let token: UInt64
  weak let connection: GatewayConnection?

  init(
    request: ServerRequest,
    replayed: Bool,
    index: UInt64,
    token: UInt64,
    connection: GatewayConnection?,
    declined: Bool = false
  ) {
    self.request = request
    self.replayed = replayed
    self.index = index
    self.declined = declined
    self.token = token
    self.connection = connection
  }

  /// The typed reading.
  public var body: ServerRequestBody { request.body }

  /// Answer with a result object. Returns whether the answer went out: `false`
  /// when this delivery was already answered or its socket is gone.
  @discardableResult
  public func respond(_ result: JSONObject) async -> Bool {
    guard let frame = request.respond(.object(result)), let connection else {
      return false
    }

    return await connection.answer(token, with: frame)
  }

  /// Answer with a JSON-RPC error; the backend treats the request as unanswered.
  /// Returns whether the answer went out, as `respond` does.
  @discardableResult
  public func fail(code: Int, message: String, data: JSONValue? = nil) async -> Bool {
    guard let frame = request.fail(code: code, message: message, data: data), let connection else {
      return false
    }

    return await connection.answer(token, with: frame)
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
