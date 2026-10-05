/// What went wrong, as the TypeScript `GatewayErrorKind` names it.
///
/// The raw values are the wire spellings the contract vectors record, so a
/// port and the reference can be compared kind for kind.
public enum GatewayErrorKind: String, Sendable, Equatable, CaseIterable {
  /// Could not reach the gateway at all.
  case network
  /// Certificate or handshake failure; retrying does not help.
  case tls
  /// The gateway did not answer in time.
  case timeout
  /// The gateway refused the credentials.
  case auth
  /// The configuration is wrong (address, header, close code); retrying does not help.
  case config
  /// The gateway answered with a server error.
  case server
  /// The answer was well-formed HTTP from something that is not speaking the protocol.
  case `protocol`
  /// Something answered, and it was not a Hermes gateway.
  case notHermes = "not_hermes"
  /// The gateway is too old for this client.
  case incompatible
  /// The address redirected somewhere else.
  case redirect
}

/// The one error type of the gateway layer, mirroring the TypeScript `GatewayError`.
///
/// The optional fields are the same ones the reference carries beside its
/// message; a field the reference leaves `undefined` is `nil` here.
public struct GatewayError: Error, Sendable, Equatable {
  public var kind: GatewayErrorKind
  public var message: String
  /// HTTP status, when the failure came from a response.
  public var status: Int?
  /// WebSocket close code, when the failure came from a socket.
  public var closeCode: Int?
  /// For `redirect`: the host the address actually led to.
  public var redirectedTo: String?
  /// For `redirect`: the origin it led to, scheme and port included, IPv6 in brackets.
  public var redirectedOrigin: String?
  /// One extra sentence a screen may show beside its own wording for the kind.
  public var hint: String?
  /// For `notHermes`: a web page came back where JSON was expected.
  public var sawLandingPage: Bool?
  /// For a refused request: the gateway's own code for why (`detail.code`, e.g. `unknown_voice`), when it names one.
  public var code: String?

  public init(
    _ kind: GatewayErrorKind,
    _ message: String,
    status: Int? = nil,
    closeCode: Int? = nil,
    redirectedTo: String? = nil,
    redirectedOrigin: String? = nil,
    hint: String? = nil,
    sawLandingPage: Bool? = nil,
    code: String? = nil
  ) {
    self.kind = kind
    self.message = message
    self.status = status
    self.closeCode = closeCode
    self.redirectedTo = redirectedTo
    self.redirectedOrigin = redirectedOrigin
    self.hint = hint
    self.sawLandingPage = sawLandingPage
    self.code = code
  }
}
