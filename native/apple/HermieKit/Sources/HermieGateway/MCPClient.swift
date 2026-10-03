import Foundation
import HermieProtocol

/// Why an MCP route did not give the page what it asked for (`contract/gateway/mcp.md`, sections 2
/// and 3). Never carries a grant's text, an address or a token: only the status, the route's own
/// `error` code and its sentence, for the developer detail.
public struct MCPRouteError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// The gateway has no MCP endpoint, or it is switched off: 404 on the read, 404 without a
    /// `not_found` body or 405 on the revoke.
    case notOffered
    /// 403 `no_identity`: signed in without a person (a session-token or ungated gateway).
    case noIdentity
    /// 401, or the credentials were refused: this device is not signed in to the gateway.
    case signedOut
    /// 404 `not_found` on a revoke: there is no such grant of this person's. One answer for every
    /// id, so it means "it is gone".
    case notFound
    /// 403 `origin_not_listed`: only a cookie caller gets it; the app sends a bearer.
    case originNotListed
    /// The gateway could not be reached, or did not answer in time.
    case unreachable
    /// Any other refusal.
    case refused
    /// A 2xx answer that is not the object the route promises.
    case unexpectedAnswer
  }

  public var kind: Kind
  public var status: Int
  /// The route's `error` (`no_identity`, `not_found`, `origin_not_listed`, …).
  public var error: String
  /// The route's own sentence, for the developer detail.
  public var detail: String

  public init(_ kind: Kind, status: Int, error: String = "", detail: String = "") {
    self.kind = kind
    self.status = status
    self.error = error
    self.detail = detail
  }
}

/// The two MCP routes, as the model needs them. `MCPClient` is the real one; a test hands in its own.
public protocol MCPRouting: Sendable {
  /// `GET /api/auth/mcp`. Throws only `MCPRouteError` (or a cancellation).
  func settings() async throws -> MCPSettings
  /// `POST /api/auth/mcp/grants/{id}/revoke`. Throws only `MCPRouteError` (or a cancellation);
  /// `notFound` is the gateway saying the grant is gone already.
  func revoke(grantID: String) async throws
}

/// The MCP routes behind the gateway's sign-in, through a gateway's `HTTPClient` (its credentials,
/// its front-door headers, its one 401 retry). The identity is the session's, never a parameter; a
/// bearer sends no `Origin`, which the revoke route requires only of a cookie caller.
public struct MCPClient: MCPRouting {
  public let http: HTTPClient

  public init(http: HTTPClient) {
    self.http = http
  }

  public func settings() async throws -> MCPSettings {
    let exchange = try await call("GET", RESTPath.mcp, body: nil)

    guard exchange.ok else {
      throw Self.refusal(exchange, revoking: false)
    }

    guard let value = exchange.body, let settings = MCPSettings(jsonValue: value) else {
      throw MCPRouteError(.unexpectedAnswer, status: exchange.status, detail: "GET \(RESTPath.mcp)")
    }

    // A gateway with MCP off answers 404; a 200 that says otherwise is not an answer to trust.
    if settings.enabled == false {
      throw MCPRouteError(.notOffered, status: exchange.status, detail: "enabled is false")
    }

    return settings
  }

  public func revoke(grantID: String) async throws {
    let path = RESTPath.mcpGrantRevoke(grantID)
    let exchange = try await call("POST", path, body: .object([:]))

    guard exchange.ok else {
      throw Self.refusal(exchange, revoking: true)
    }
  }

  /// The call, with a transport failure as a route error and a cancellation left alone.
  private func call(_ method: String, _ path: String, body: JSONValue?) async throws -> HTTPExchange {
    do {
      return try await http.exchange(method, path, body: body)
    } catch let error as GatewayError {
      throw MCPRouteError(
        error.kind == .auth ? .signedOut : .unreachable,
        status: error.status ?? 0,
        detail: "\(method) \(path)"
      )
    }
  }

  /// A non-2xx answer as an `MCPRouteError`.
  static func refusal(_ exchange: HTTPExchange, revoking: Bool) -> MCPRouteError {
    let body = exchange.body.flatMap(RESTErrorBody.init(jsonValue:))
    let error = body?.json[field: "error"] ?? ""
    let detail = body?.detailText ?? ""

    return MCPRouteError(
      kind(status: exchange.status, error: error, revoking: revoking),
      status: exchange.status,
      error: error,
      detail: detail
    )
  }

  private static func kind(status: Int, error: String, revoking: Bool) -> MCPRouteError.Kind {
    switch status {
    case 401: .signedOut
    case 403 where error == "no_identity": .noIdentity
    case 403 where error == "origin_not_listed": .originNotListed
    // One answer for every grant that is not the caller's active one; any other 404 is the route
    // itself being unknown.
    case 404 where revoking && error == "not_found": .notFound
    case 404, 405: .notOffered
    default: .refused
    }
  }
}
