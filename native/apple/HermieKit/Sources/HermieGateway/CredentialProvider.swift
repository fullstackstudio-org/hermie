import Foundation

/// How this client proves who it is to a gateway.
///
/// - `nativePKCE`: RFC 8252 sign-in, `Authorization: Bearer` on REST.
/// - `sessionToken`: an ungated gateway's shared secret.
/// - `cookie`: the gateway's own browser session. Only a page served from the
///   gateway's origin can use it, so the native apps never pick it; the case
///   exists because a stored gateway record may name it.
public enum GatewayAuthMode: String, Sendable, Codable, CaseIterable {
  case nativePKCE = "native_pkce"
  case sessionToken = "session_token"
  case cookie
}

/// Everything needed to open one WebSocket, minted immediately before the dial:
/// gated gateways hand out single-use tickets with a 30 s lifetime, so a plan is
/// never reused across dials.
public struct DialPlan: Sendable, Equatable {
  public var url: String
  public var protocols: [String]
  public var headers: [String: String]

  public init(url: String, protocols: [String] = [], headers: [String: String] = [:]) {
    self.url = url
    self.protocols = protocols
    self.headers = headers
  }
}

/// Options for the auth headers of one REST call.
public struct AuthHeaderOptions: Sendable, Equatable {
  /// Skip the cached access token and refresh first.
  public var forceRefresh: Bool
  /// The access token the gateway just refused, so a refresh that already
  /// happened for it is not repeated.
  public var rejectedAccessToken: String?

  public init(forceRefresh: Bool = false, rejectedAccessToken: String? = nil) {
    self.forceRefresh = forceRefresh
    self.rejectedAccessToken = rejectedAccessToken
  }
}

/// What a credential provider answers when its credential was rejected.
public enum RejectionVerdict: String, Sendable, Equatable {
  /// A fresh credential is available; try once more.
  case retry
  /// Nothing left to offer; the person has to sign in again.
  case reauth
}

/// What the HTTP layer and the dial loop need from "however this gateway
/// authenticates us", so neither has to know which flow is in play. One
/// provider per gateway.
///
/// The connection counts consecutive rejections itself and decides when a
/// rejection is a stale ticket and when it is the credential; the provider only
/// answers whether it can produce a fresh credential.
public protocol CredentialProvider: Sendable {
  var mode: GatewayAuthMode { get }

  /// Auth headers for one REST call.
  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String]

  /// Mint everything one WebSocket dial needs. Called immediately before
  /// connecting.
  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan

  /// A credential was rejected (HTTP 401 or WebSocket close 4401).
  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict

  func signOut() async throws
}
