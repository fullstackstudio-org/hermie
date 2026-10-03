import Foundation
import HermieProtocol

/// Why a passkey route refused, read off its answer. Never carries a code, an assertion or a token.
public struct PasskeyRouteError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// The gateway does not serve the routes: the level is off or unknown there (GET 404, POST 405).
    case notOffered
    /// Any other refusal; `error` and `reason` say which.
    case refused
    /// A 2xx answer that is not the object the route promises.
    case unexpectedAnswer
  }

  public var kind: Kind
  public var status: Int
  /// The route's `error` (`code_invalid`, `assertion_invalid`, `stepup_invalid`, …).
  public var error: String
  /// The contract's refusal reason, when the route gave one (`challenge_mismatch`, …).
  public var reason: String
  /// The route's own sentence, for the developer detail.
  public var detail: String

  public init(_ kind: Kind, status: Int, error: String = "", reason: String = "", detail: String = "") {
    self.kind = kind
    self.status = status
    self.error = error
    self.reason = reason
    self.detail = detail
  }
}

/// The six passkey routes, through a gateway's `HTTPClient` (its credentials, its front-door
/// headers, its one 401 retry). A bearer sends no `Origin`, which these routes require only of a
/// cookie caller.
public struct PasskeyClient: Sendable {
  public let http: HTTPClient

  public init(http: HTTPClient) {
    self.http = http
  }

  /// `GET /api/auth/passkeys`.
  public func status() async throws -> PasskeyStatus {
    try await call("GET", RESTPath.passkeys, body: nil)
  }

  /// `POST /api/auth/passkeys/register/begin`.
  public func registerBegin(_ params: PasskeyRegisterBeginParams) async throws -> PasskeyRegisterBeginResult {
    try await call("POST", RESTPath.passkeyRegisterBegin, body: params.jsonValue)
  }

  /// `POST /api/auth/passkeys/register/finish`.
  public func registerFinish(_ params: PasskeyRegisterFinishParams) async throws -> PasskeyRegisterFinishResult {
    try await call("POST", RESTPath.passkeyRegisterFinish, body: params.jsonValue)
  }

  /// `POST /api/auth/passkeys/stepup/begin`.
  public func stepupBegin(_ params: PasskeyStepupBeginParams) async throws -> PasskeyStepupBeginResult {
    try await call("POST", RESTPath.passkeyStepupBegin, body: params.jsonValue)
  }

  /// `POST /api/auth/passkeys/invites`.
  public func invite(_ params: PasskeyInviteParams) async throws -> PasskeyInviteResult {
    try await call("POST", RESTPath.passkeyInvites, body: params.jsonValue)
  }

  /// `POST /api/auth/passkeys/revoke`.
  public func revoke(_ params: PasskeyRevokeParams) async throws -> PasskeyOKResult {
    try await call("POST", RESTPath.passkeyRevoke, body: params.jsonValue)
  }

  private func call<T: JSONObjectBacked>(_ method: String, _ path: String, body: JSONValue?) async throws -> T {
    let exchange = try await http.exchange(method, path, body: body)

    guard exchange.ok else {
      throw Self.refusal(exchange)
    }

    guard let value = exchange.body, let answer = T(jsonValue: value) else {
      throw PasskeyRouteError(.unexpectedAnswer, status: exchange.status, detail: "\(method) \(path)")
    }

    return answer
  }

  /// A non-2xx answer as a `PasskeyRouteError`.
  static func refusal(_ exchange: HTTPExchange) -> PasskeyRouteError {
    let body = exchange.body.flatMap(PasskeyRouteErrorBody.init(jsonValue:))
    let kind: PasskeyRouteError.Kind = exchange.status == 404 || exchange.status == 405 ? .notOffered : .refused

    return PasskeyRouteError(
      kind,
      status: exchange.status,
      error: body?.error ?? "",
      reason: body?.reason ?? "",
      detail: body?.detail ?? ""
    )
  }
}
