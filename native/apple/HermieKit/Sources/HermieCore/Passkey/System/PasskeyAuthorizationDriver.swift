import AuthenticationServices
import Foundation

/// What one run of the system passkey sheet came to, in the app's own types.
enum PasskeyAuthorizationOutcome: Sendable, Equatable {
  case registration(PasskeyRegistration)
  case assertion(PasskeyAssertionResponse)
  /// The platform's error, by domain and code only.
  case error(domain: String, code: Int)
  /// The driver could not run or read the ceremony (no window, an unexpected credential); the text
  /// is fixed and holds nothing from the ceremony.
  case refused(String)
}

/**
 One run of the system passkey sheet, behind a seam so `SystemPasskeyAuthenticator`'s rules are
 tested without the system. The app's is `ControllerPasskeyDriver`; a driver is used for one
 ceremony and dropped.
 */
@MainActor
protocol PasskeyAuthorizationDriver: AnyObject {
  /// Show the sheet for `request` and call `completion` exactly once.
  func perform(_ request: ASAuthorizationRequest, completion: @escaping @MainActor (PasskeyAuthorizationOutcome) -> Void)

  /// Dismiss the sheet. The completion may still follow; the authenticator has moved on by then.
  func cancel()
}

/// `ASAuthorizationController`, shown over the window `anchor` names.
@MainActor
final class ControllerPasskeyDriver: NSObject, PasskeyAuthorizationDriver {
  private let anchor: SystemPasskeyAuthenticator.Anchor
  private var controller: ASAuthorizationController?
  private var completion: (@MainActor (PasskeyAuthorizationOutcome) -> Void)?
  /// Holds the window for the controller, which keeps its provider weakly.
  private var presentation: Presentation?

  init(anchor: @escaping SystemPasskeyAuthenticator.Anchor) {
    self.anchor = anchor
  }

  func perform(_ request: ASAuthorizationRequest, completion: @escaping @MainActor (PasskeyAuthorizationOutcome) -> Void) {
    guard let window = anchor() else {
      completion(.refused("There is no window to show the passkey sheet in."))
      return
    }

    let controller = ASAuthorizationController(authorizationRequests: [request])

    let presentation = Presentation(window: window)

    self.presentation = presentation
    self.completion = completion
    self.controller = controller
    controller.delegate = self
    controller.presentationContextProvider = presentation
    controller.performRequests()
  }

  func cancel() {
    controller?.cancel()
  }

  private func complete(_ outcome: PasskeyAuthorizationOutcome) {
    let completion = self.completion

    self.completion = nil
    controller = nil
    presentation = nil
    completion?(outcome)
  }

  /// The credential the sheet returned, copied into the app's types.
  nonisolated static func outcome(_ credential: any ASAuthorizationCredential) -> PasskeyAuthorizationOutcome {
    if let registration = credential as? any ASAuthorizationPublicKeyCredentialRegistration {
      guard let attestation = registration.rawAttestationObject else {
        return .refused("The new passkey came without an attestation object.")
      }

      let platform = registration as? ASAuthorizationPlatformPublicKeyCredentialRegistration

      return .registration(
        PasskeyRegistration(
          credentialID: [UInt8](registration.credentialID),
          clientDataJSON: [UInt8](registration.rawClientDataJSON),
          attestationObject: [UInt8](attestation),
          transports: platform.map { transports($0.attachment) } ?? []
        )
      )
    }

    if let assertion = credential as? any ASAuthorizationPublicKeyCredentialAssertion {
      return .assertion(
        PasskeyAssertionResponse(
          credentialID: [UInt8](assertion.credentialID),
          authenticatorData: [UInt8](assertion.rawAuthenticatorData),
          clientDataJSON: [UInt8](assertion.rawClientDataJSON),
          signature: [UInt8](assertion.signature),
          userHandle: assertion.userID.isEmpty ? nil : [UInt8](assertion.userID)
        )
      )
    }

    return .refused("The passkey sheet returned an unexpected kind of credential.")
  }

  /// The WebAuthn transports of a new passkey, from where it was made.
  nonisolated static func transports(_ attachment: ASAuthorizationPublicKeyCredentialAttachment) -> [String] {
    attachment == .platform ? ["internal"] : ["hybrid"]
  }
}

/// `nonisolated`, like everything the system calls back into: the protocol says the main actor, but
/// a main-actor method called from another queue traps in Swift 6's isolation check, which is how
/// `ASWebAuthenticationSession`'s handler took the Mac app down (TestFlight 0.2.1). The credential is
/// copied into `Sendable` values where it arrives; only that crosses to the main actor.
extension ControllerPasskeyDriver: ASAuthorizationControllerDelegate {
  nonisolated func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    let outcome = Self.outcome(authorization.credential)

    MainActorHop.run { self.complete(outcome) }
  }

  nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
    let error = error as NSError
    let outcome = PasskeyAuthorizationOutcome.error(domain: error.domain, code: error.code)

    MainActorHop.run { self.complete(outcome) }
  }
}

/// The window one ceremony is shown over, found before the controller runs.
/// The window is found on the main thread before the ceremony; the system may ask for it from any.
@MainActor
private final class Presentation: NSObject, ASAuthorizationControllerPresentationContextProviding {
  /// Set once, before the controller runs, and only handed back to the system.
  let window: ASPresentationAnchor

  init(window: ASPresentationAnchor) {
    self.window = window
  }

  nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    window
  }
}
