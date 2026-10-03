import HermieCore
import HermieGateway
import HermieProtocol

/**
 Where one gateway's passkeys stand, as Settings → Gateways → Passkeys says it: one case, chosen from
 what the model read, so the page says exactly one thing about the gateway and a test can pin each.

 The reasons are the gateway's (`GET /api/auth/passkeys` `reason`: `disabled`, `no_base_url`,
 `private_origin`, `no_identity`) and this build's (`rp_not_configured`: no passkey identity in the
 build; `rp_not_accepted`: the gateway does not take it), each in plain words.
 */
enum PasskeysPageState: Equatable {
  /// The first read has not answered.
  case loading
  /// This build has no passkey identity (`rp_not_configured`).
  case notConfigured
  /// The gateway does not serve the passkey routes.
  case notOffered
  /// The gateway does not list the address this app dials (`confirm.passkey.base_urls`).
  case originNotListed
  /// Too many tries; try again after `retryAfter` seconds, when the gateway said.
  case rateLimited(retryAfter: Int?)
  /// The read failed for another reason (no connection, an answer that is not the routes').
  case unreadable
  /// The gateway has the level off for this account; `reason` as it came.
  case unavailable(reason: String)
  /// The gateway does not accept this build's passkey identity.
  case rpNotAccepted
  /// Nothing enrolled yet for this build.
  case notEnrolled
  /// At least one passkey of this account works here.
  case enrolled

  /// Whether a code can be redeemed here: the level is on and this build's identity is taken.
  var canEnrol: Bool {
    self == .notEnrolled || self == .enrolled
  }

  @MainActor
  static func of(_ model: PasskeyModel) -> PasskeysPageState {
    from(
      configuration: model.configuration,
      status: model.status,
      error: model.statusError,
      credentials: model.credentials
    )
  }

  /// The same decision from what the model read, as values.
  static func from(
    configuration: PasskeyConfiguration,
    status: PasskeyStatus?,
    error: PasskeyRouteError?,
    credentials: [PasskeyCredentialInfo]
  ) -> PasskeysPageState {
    guard let rpID = configuration.rpID else {
      return .notConfigured
    }

    if let error {
      switch error.kind {
      case .notOffered: return .notOffered
      case .originNotListed: return .originNotListed
      case .rateLimited: return .rateLimited(retryAfter: error.retryAfter)
      case .refused, .unexpectedAnswer: return .unreadable
      }
    }

    guard let status else {
      return .loading
    }

    guard status.enabled == true else {
      return .unavailable(reason: status.reason ?? "")
    }

    guard status.rp?.ids(for: configuration.kind).contains(rpID) == true else {
      return .rpNotAccepted
    }

    return credentials.contains { $0.rpID == rpID } ? .enrolled : .notEnrolled
  }
}
