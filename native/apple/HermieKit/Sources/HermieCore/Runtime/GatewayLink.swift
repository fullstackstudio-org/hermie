import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// What one gateway's runtime needs from a connection, and nothing more.
///
/// The TypeScript controller is written against `ChatGateway` (`gateway/link.ts`)
/// for the same reason this protocol exists: a test hands in a scripted link and
/// drives a whole hydration without a socket. Production wires the real
/// `GatewayConnection` and `HTTPClient` behind `ConnectionLink`
/// (`GatewaySession.swift`), and nothing in the feature code reaches past it.
///
/// The ordering contract is the connection's (`WireOrder.swift`): every event,
/// server request and RPC result carries the wire index of the frame it came
/// from, and an RPC result with index N reflects every frame with index < N.
/// `events` and `serverRequests` must be subscribed before `start()`; each
/// access is a new subscription.
public protocol GatewayLink: Sendable {
  /// Every gateway event, live and replayed, in dispatch order.
  var events: AsyncStream<WireEvent> { get }

  /// The `approval` and `clarify` requests the app is asked to answer.
  ///
  /// A sequence rather than a stream so production can map the connection's
  /// deliveries in place (`AsyncMapSequence`), with no task in between: the
  /// store's consumer must be resumed straight from the connection's yield.
  var serverRequests: any AsyncSequence<InboundRequest, Never> & Sendable { get }

  /// Every status transition, starting with the current one.
  var statuses: AsyncStream<ConnectionStatus> { get }

  /// One JSON-RPC call by method name, with the wire index of its answer.
  func requestReply(_ method: String, params: JSONValue) async throws -> RPCReply<JSONValue>

  /// The REST transcript (`GET /api/sessions/<id>/messages`), oldest row first
  /// whichever end was counted from, or `nil` when this gateway has no REST
  /// transcript (`ChatGateway.fetchMessages`).
  func fetchMessages(_ resolvedSessionID: String, _ window: MessageWindow) async -> [TranscriptRow]?

  /// The highest event `seq` the connection has dispatched, per session
  /// (`GatewayConnection.seqWatermarks`). The store waits until it has taken in
  /// that far before it places a result among the frames it follows.
  func seqWatermarks() async -> [String: Double]

  /// `claimTurn` (`turn-claim.ts`): tell the plugin which runtime session the
  /// next `prompt.submit` names. `POST /api/plugins/hermie/context/turn`; the
  /// whole claim, auth headers included, takes at most
  /// `ChatRuntimeLimits.turnClaimTimeoutMs`. Never throws, and a refusal (a 401
  /// included) is never handed to the credential provider: the turn goes out
  /// unclaimed rather than late, and never at the cost of a sign-in.
  func claimTurn(_ runtimeSessionID: String) async

  func start() async
  func stop() async
  func pause() async
  func resume() async
  func retryNow() async
  func setOnline(_ online: Bool) async
  /// Stop for good and end every stream.
  func shutdown() async
}

/// `RestMessagesOptions`: which slice of the REST transcript to read.
public struct MessageWindow: Sendable, Equatable {
  public enum Order: String, Sendable {
    case latest
    case oldest
  }

  public var limit: Int
  public var order: Order
  /// Rows to skip, counted from the end `order` names.
  public var offset: Int

  public init(limit: Int, order: Order = .latest, offset: Int = 0) {
    self.limit = limit
    self.order = order
    self.offset = offset
  }

  /// The query string, without `offset` when it is zero (as the reference writes it).
  var query: String {
    "limit=\(limit)&order=\(order.rawValue)" + (offset > 0 ? "&offset=\(offset)" : "")
  }
}

/// One server→client request as the runtime sees it: the request, whether it
/// was re-delivered from a reconnect's `open_requests`, the wire index that
/// places it, and the way to answer it.
///
/// Production wraps a `ServerRequestDelivery`; a test builds one with closures.
/// `respond` answers `false` when the socket that delivered it is gone: that
/// answer did not go out, and the request will be re-delivered after the
/// reconnect.
public struct InboundRequest: Sendable {
  public let request: ServerRequest
  public let replayed: Bool
  public let index: UInt64
  private let respondHandler: @Sendable (JSONObject) async -> Bool
  private let failHandler: @Sendable (Int, String) async -> Bool

  public init(
    request: ServerRequest,
    replayed: Bool,
    index: UInt64,
    respond: @escaping @Sendable (JSONObject) async -> Bool,
    fail: @escaping @Sendable (Int, String) async -> Bool
  ) {
    self.request = request
    self.replayed = replayed
    self.index = index
    self.respondHandler = respond
    self.failHandler = fail
  }

  public init(_ delivery: ServerRequestDelivery) {
    self.init(
      request: delivery.request,
      replayed: delivery.replayed,
      index: delivery.index,
      respond: { result in await delivery.respond(result) },
      fail: { code, message in await delivery.fail(code: code, message: message) }
    )
  }

  public var id: String { request.id ?? "" }
  public var method: String { request.method ?? "" }
  public var params: JSONObject { request.json["params"]?.objectValue ?? [:] }

  /// Answer with a result object; `false` when it did not go out.
  public func respond(_ result: JSONObject) async -> Bool {
    await respondHandler(result)
  }

  /// Decline: the gateway reads `-32601` as "this client cannot answer".
  public func decline() async -> Bool {
    await failHandler(JSONRPCError.methodNotFound, "no handler for server request: \(method)")
  }
}

extension GatewayLink {
  /// A typed call: the method's own params and result types.
  func call<M: RPCMethod>(_ method: M.Type, _ params: M.Params) async throws -> RPCReply<M.Result> {
    let reply = try await requestReply(M.name, params: params.jsonValue)

    guard let result = M.Result(jsonValue: reply.result) else {
      throw GatewayRPCError(.unexpectedResult, "The gateway answered \(M.name) with a result of another shape.")
    }

    return RPCReply(index: reply.index, result: result)
  }
}
