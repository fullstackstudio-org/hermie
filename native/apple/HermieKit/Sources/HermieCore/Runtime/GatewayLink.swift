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

  /// The server requests the app is asked to answer (`approval`, `clarify`,
  /// the one-string prompts, `confirm` where a passkey model listens), and the
  /// ones it cannot show, already declined.
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

  /// `POST /api/files/upload-stream`: one local file to one absolute path on the gateway, answering
  /// the path it landed on. `onProgress` gets 0 to 1. Throws `GatewayError`; cancelling the task
  /// cancels the upload. A link without a REST side refuses (the default).
  func uploadFile(
    from file: URL,
    name: String,
    mimeType: String,
    to path: String,
    onProgress: (@Sendable (Double) -> Void)?
  ) async throws -> String

  /// Every session a reconnect replay could not make whole
  /// (`GatewayConnection.replayGaps`). Subscribed before `start()`, like `events`.
  /// A link without a replay of its own has none (the default).
  var replayGaps: AsyncStream<ReplayGap> { get }

  /// Who the gateway thinks this client is, read through the link's own
  /// credentials (`IdentityProbe`). Never throws: a failure is an answer.
  func probeIdentity() async -> IdentityProbe

  /// Wait until every frame queued so far has been handed to the socket, or
  /// `limit` has passed: the last answers before a shutdown.
  func flushWrites(within limit: Duration) async

  /// Run the `client.capabilities` announcement again on the live socket, because what
  /// the app can perform for `confirm` changed (`GatewayConnection.refreshCapabilities`).
  func refreshCapabilities() async

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
  private let failWithDataHandler: (@Sendable (Int, String, JSONValue) async -> Bool)?

  /// - Parameter failWithData: an error answer that carries `data`; without one, `fail(code:message:data:)`
  ///   sends the code and the message only.
  public init(
    request: ServerRequest,
    replayed: Bool,
    index: UInt64,
    respond: @escaping @Sendable (JSONObject) async -> Bool,
    fail: @escaping @Sendable (Int, String) async -> Bool,
    failWithData: (@Sendable (Int, String, JSONValue) async -> Bool)? = nil
  ) {
    self.request = request
    self.replayed = replayed
    self.index = index
    self.respondHandler = respond
    self.failHandler = fail
    self.failWithDataHandler = failWithData
  }

  public init(_ delivery: ServerRequestDelivery) {
    self.init(
      request: delivery.request,
      replayed: delivery.replayed,
      index: delivery.index,
      respond: { result in await delivery.respond(result) },
      fail: { code, message in await delivery.fail(code: code, message: message) },
      failWithData: { code, message, data in await delivery.fail(code: code, message: message, data: data) }
    )
  }

  /// Answer with a JSON-RPC error carrying `data` (`confirm`'s 4040 `{reason}`); `false` when it did not go out.
  public func fail(code: Int, message: String, data: JSONValue) async -> Bool {
    guard let failWithDataHandler else {
      return await failHandler(code, message)
    }

    return await failWithDataHandler(code, message, data)
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
    await failHandler(JSONRPCError.methodNotFound, "not supported by this client: \(method)")
  }

  /// Decline a request for a session no chat on this client holds (another
  /// client may own it), with the same `-32601`.
  public func declineUnowned() async -> Bool {
    await failHandler(JSONRPCError.methodNotFound, "no chat on this client holds the session for: \(method)")
  }

  /// The typed reading.
  public var body: ServerRequestBody { request.body }
}

/// What asking a gateway "who am I" came back with.
///
/// What each auth mode gets from the gateway (`hermes_cli/dashboard_auth/routes.py`,
/// `tui_gateway/server.py::_transport_auth_user`):
///
/// - `sessionToken` (an ungated gateway, also behind a header front door): the
///   shared token names no login. `/api/auth/me` answers 401 for it (no verified
///   session), and the socket's turns are stamped by nobody. Not asked: there is
///   nobody to ask about, and a 401 would read as a rejected token.
/// - `nativePKCE`: the bearer is a verified session; `/api/auth/me` answers it.
/// - `cookie`: only a page served by the gateway holds that session; the native
///   credential provider refuses every call, so the read fails.
public enum IdentityProbe: Sendable, Equatable {
  /// The link authenticates with an ungated gateway's shared token: no user.
  case sessionToken
  /// `/api/auth/me` answered.
  case answered(AuthIdentity)
  /// The read failed (refused, unreachable, not a gateway); the reason, for the developer detail.
  case failed(String)
}

extension IdentityProbe {
  /// The one way this app asks a gateway who it is: a session token is not asked
  /// about, anything else reads `/api/auth/me` through `client` (its credentials
  /// and front-door headers included). Turning the answer into an identity is
  /// `GatewayIdentityState.after(_:)`.
  public static func read(_ client: HTTPClient) async -> IdentityProbe {
    guard client.credentials.mode != .sessionToken else {
      return .sessionToken
    }

    do {
      return .answered(try await client.authMe())
    } catch {
      return .failed(ChatResolver.describe(error))
    }
  }
}

extension GatewayLink {
  public var replayGaps: AsyncStream<ReplayGap> {
    AsyncStream { $0.finish() }
  }

  /// A link that cannot read who it is answers that it could not.
  public func probeIdentity() async -> IdentityProbe {
    .failed("This connection cannot ask the gateway who you are.")
  }

  /// A link with no writer of its own has nothing to wait for.
  public func flushWrites(within limit: Duration) async {}

  /// A link with no REST side cannot take a file.
  public func uploadFile(
    from file: URL,
    name: String,
    mimeType: String,
    to path: String,
    onProgress: (@Sendable (Double) -> Void)?
  ) async throws -> String {
    throw GatewayError(.config, "This connection cannot upload files.")
  }

  /// A link without a capability announcement of its own has nothing to repeat.
  public func refreshCapabilities() async {}
}

extension ConnectionLink {
  /// The connection's writer (`GatewayConnection.flushWrites`). Here rather
  /// than beside the rest of `ConnectionLink` in `GatewaySession.swift`.
  public func flushWrites(within limit: Duration) async {
    await connection.flushWrites(within: limit)
  }

  public func refreshCapabilities() async {
    await connection.refreshCapabilities()
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
