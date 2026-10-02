import Foundation
import HermieGateway
import HermieProtocol

/// Why a call to the relay did not do what it was asked. No case carries a token, a handle or a
/// secret, and neither does any description, so an error can be logged or shown as it is.
public enum PushRelayError: Error, Sendable, Equatable {
  /// 404 on `PUT` or `DELETE`: the handle is unknown or the manage secret is wrong. The relay makes
  /// the two indistinguishable on purpose; either way this capability is gone.
  case notFound
  /// 429. `retryAfterSeconds` is the relay's `Retry-After`, when it sent a number.
  case rateLimited(retryAfterSeconds: Int?)
  /// Another 4xx, with the relay's error code (`invalid_request`, `topic_not_allowed`, `unauthorized`,
  /// …), reduced to `[a-z_]` and at most 40 characters, or `unknown`.
  case rejected(status: Int, code: String)
  /// A 5xx, or a status the relay never sends.
  case unavailable(status: Int)
  /// No answer within the window.
  case timeout
  /// The relay could not be reached.
  case network
  /// The TLS handshake or the certificate failed.
  case tls
  /// The relay answered with a redirect, which is never followed: a bearer secret must not be
  /// carried anywhere else.
  case redirectRefused
  /// A 2xx whose body is not what the protocol says.
  case invalidResponse
  /// The configured origin is not one a client may talk to (`PushRelay.validatedOrigin`).
  case invalidOrigin

  /// The relay says this capability can no longer be used: register again for a new one. A 401 is
  /// a bearer the relay could not even read, which is the same answer for a stored secret.
  public var capabilityLost: Bool {
    switch self {
    case .notFound: true
    case .rejected(let status, _): status == 401
    default: false
    }
  }
}

extension PushRelayError: CustomStringConvertible, LocalizedError {
  public var description: String {
    switch self {
    case .notFound: "The relay does not know this registration."
    case .rateLimited(let after): "The relay is rate limiting this device\(after.map { " (retry after \($0) s)" } ?? "")."
    case .rejected(let status, let code): "The relay refused the request (\(status) \(code))."
    case .unavailable(let status): "The relay is unavailable (\(status))."
    case .timeout: "The relay did not answer in time."
    case .network: "The relay could not be reached."
    case .tls: "The secure connection to the relay failed."
    case .redirectRefused: "The relay answered with a redirect, which is not followed."
    case .invalidResponse: "The relay's answer could not be read."
    case .invalidOrigin: "The relay address is not allowed."
    }
  }

  public var errorDescription: String? { description }
}

/// The three calls a device makes to the relay. `HTTPPushRelayClient` is the real one; tests script one.
public protocol PushRelayClient: Sendable {
  /// The origin registrations are made at, as written into a gateway's push row.
  var origin: String { get }

  /// `POST /v1/registrations`: a new capability for this token.
  func register(token: APNsDeviceToken, environment: APNsEnvironment, topic: String) async throws(PushRelayError)
    -> PushCapability

  /// `PUT /v1/registrations/{handle}`: point an existing capability at this token and environment.
  func update(handle: String, manageSecret: String, token: APNsDeviceToken, environment: APNsEnvironment)
    async throws(PushRelayError)

  /// `DELETE /v1/registrations/{handle}`: revoke it.
  func delete(handle: String, manageSecret: String) async throws(PushRelayError)
}

/**
 The relay over HTTPS, through the same `HTTPTransport` the gateway client uses: nothing cached,
 no cookies, a window from an injected clock, and no redirect followed at all (`.refuseAll`), so a
 manage secret in an `Authorization` header can never be carried to another origin.

 The handle goes into a URL path, so it is checked against the relay's alphabet before any call
 that names one; a stored value that fails the check is never sent.
 */
public struct HTTPPushRelayClient: PushRelayClient {
  public let origin: String
  public let transport: HTTPTransport
  public let timeoutMs: Int

  /// The default window for one call. The relay answers in milliseconds; this only bounds a dead network.
  public static let defaultTimeoutMs = 15_000

  /// nil when `origin` is not one a client may talk to (see `PushRelay.validatedOrigin`).
  public init?(
    origin: String = PushRelay.defaultOrigin,
    transport: HTTPTransport = HTTPTransport(),
    timeoutMs: Int = HTTPPushRelayClient.defaultTimeoutMs
  ) {
    guard let origin = PushRelay.validatedOrigin(origin) else {
      return nil
    }

    self.origin = origin
    self.transport = transport
    self.timeoutMs = timeoutMs
  }

  public func register(token: APNsDeviceToken, environment: APNsEnvironment, topic: String)
    async throws(PushRelayError) -> PushCapability
  {
    let body: JSONValue = [
      "v": .number(Double(PushRelay.protocolVersion)),
      "platform": "apns",
      "token": .string(token.hex),
      "environment": .string(environment.rawValue),
      "topic": .string(topic)
    ]

    let response = try await send("POST", path: "/v1/registrations", bearer: nil, body: body)

    guard response.ok else {
      throw Self.error(for: response)
    }

    guard case .object(let object)? = try? JSONValue(parsing: response.text),
      case .string(let handle)? = object["handle"],
      case .string(let sendSecret)? = object["sendSecret"],
      case .string(let manageSecret)? = object["manageSecret"],
      PushRelay.isValidHandle(handle),
      PushRelay.isValidSecret(sendSecret),
      PushRelay.isValidSecret(manageSecret),
      sendSecret != manageSecret
    else {
      throw .invalidResponse
    }

    // The response's own `relay` field is not read: a registration's origin is the one this client
    // was configured with, so an answer can never steer where a gateway will later send.
    return PushCapability(handle: handle, sendSecret: sendSecret, manageSecret: manageSecret)
  }

  public func update(handle: String, manageSecret: String, token: APNsDeviceToken, environment: APNsEnvironment)
    async throws(PushRelayError)
  {
    try Self.checkCapability(handle: handle, manageSecret: manageSecret)

    let body: JSONValue = [
      "v": .number(Double(PushRelay.protocolVersion)),
      "token": .string(token.hex),
      "environment": .string(environment.rawValue)
    ]

    let response = try await send("PUT", path: "/v1/registrations/\(handle)", bearer: manageSecret, body: body)

    guard response.ok else {
      throw Self.error(for: response)
    }
  }

  public func delete(handle: String, manageSecret: String) async throws(PushRelayError) {
    try Self.checkCapability(handle: handle, manageSecret: manageSecret)

    let response = try await send("DELETE", path: "/v1/registrations/\(handle)", bearer: manageSecret, body: nil)

    guard response.ok else {
      throw Self.error(for: response)
    }
  }

  // MARK: Transport

  private func send(_ method: String, path: String, bearer: String?, body: JSONValue?) async throws(PushRelayError)
    -> JSONResponse
  {
    var headers: [String: String] = [:]

    if let bearer {
      headers["authorization"] = "Bearer \(bearer)"
    }

    let request = JSONRequest(
      method: method,
      headers: headers,
      body: body,
      timeoutMs: timeoutMs,
      redirects: .refuseAll
    )

    do {
      return try await transport.requestText(origin + path, request)
    } catch {
      // The transport's message names the URL, which carries the handle: only the kind is kept.
      switch error.kind {
      case .timeout: throw .timeout
      case .tls: throw .tls
      case .redirect: throw .redirectRefused
      default: throw .network
      }
    }
  }

  private static func checkCapability(handle: String, manageSecret: String) throws(PushRelayError) {
    // Never sent when it could not have come from the relay: a bad handle could leave its path
    // segment, and a bad secret would only be refused after it had been sent.
    guard PushRelay.isValidHandle(handle), PushRelay.isValidSecret(manageSecret) else {
      throw .notFound
    }
  }

  static func error(for response: JSONResponse) -> PushRelayError {
    switch response.status {
    case 404:
      return .notFound
    case 429:
      return .rateLimited(retryAfterSeconds: Int(response.retryAfter.trimmingCharacters(in: .whitespaces)))
    case 300...399:
      return .redirectRefused
    case 400...499:
      return .rejected(status: response.status, code: errorCode(response.text))
    default:
      return .unavailable(status: response.status)
    }
  }

  /// The relay's `{ "error": "<code>" }`, kept only when it is a plain code.
  static func errorCode(_ text: String) -> String {
    guard case .object(let object)? = try? JSONValue(parsing: text), case .string(let code)? = object["error"],
      (1...40).contains(code.count), code.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || $0 == "_" })
    else {
      return "unknown"
    }

    return code
  }
}
