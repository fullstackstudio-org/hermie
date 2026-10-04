import Foundation
import HermieProtocol

/// Why a passkey route refused, read off its answer. Never carries a code, an assertion or a token.
public struct PasskeyRouteError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// The gateway does not serve the routes: the level is off or unknown there (GET 404, POST 405).
    case notOffered
    /// 429 `rate_limited`: too many tries; `retryAfter` says when the next may go, when it was given.
    case rateLimited
    /// 403 `origin_not_listed`: the gateway does not list the address this app dialed among its
    /// passkey base URLs (or, signed in with a cookie, the `Origin` the call carried). Something the
    /// operator changes (`confirm.passkey.base_urls`), not the person.
    case originNotListed
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
  /// `rateLimited`: the seconds of the answer's `Retry-After`, when it gave a number of them.
  public var retryAfter: Int?
  /// `reauth_invalid` with `reason: failed`: why the sign-in did not count (contract §7.2).
  public var failure: String

  public init(
    _ kind: Kind,
    status: Int,
    error: String = "",
    reason: String = "",
    detail: String = "",
    retryAfter: Int? = nil,
    failure: String = ""
  ) {
    self.kind = kind
    self.status = status
    self.error = error
    self.reason = reason
    self.detail = detail
    self.retryAfter = retryAfter
    self.failure = failure
  }
}

/// The seven passkey routes, through a gateway's `HTTPClient` (its credentials, its front-door
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

  /// `POST /api/auth/passkeys/reauth/begin` with `{}`: open a fresh-authentication grant.
  public func reauthBegin() async throws -> PasskeyReauthBeginResult {
    try await call("POST", RESTPath.passkeyReauthBegin, body: .object([:]))
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
    let error = body?.error ?? ""
    let kind = kind(status: exchange.status, error: error)

    return PasskeyRouteError(
      kind,
      status: exchange.status,
      error: error,
      reason: body?.reason ?? "",
      detail: body?.detail ?? "",
      retryAfter: kind == .rateLimited ? seconds(exchange.retryAfter) : nil,
      failure: body?.failure ?? ""
    )
  }

  private static func kind(status: Int, error: String) -> PasskeyRouteError.Kind {
    switch status {
    case 404, 405: .notOffered
    case 429: .rateLimited
    case 403 where error == "origin_not_listed": .originNotListed
    default: .refused
    }
  }

  /// `Retry-After` as delay-seconds; the HTTP-date form, and anything else, is `nil`.
  private static func seconds(_ header: String) -> Int? {
    let trimmed = header.trimmingCharacters(in: .whitespaces)

    guard !trimmed.isEmpty, trimmed.allSatisfy(\.isASCII), trimmed.allSatisfy(\.isNumber) else {
      return nil
    }

    return Int(trimmed)
  }
}
