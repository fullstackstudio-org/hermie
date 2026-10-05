import HermieCore
import SwiftUI

/**
 The setup and sign-in flows in progress, kept outside the views that show them.

 Every window's content sits behind the lock gate, which does not build it while the app is locked,
 and a sheet presented from that content goes with it. A sign-in makes the app resign active by its
 nature (the browser's consent prompt, a trip to a password manager or an authenticator), so with
 the lock set to "immediately" the wizard is taken down in the middle of every attempt. The flow
 itself (the model, the browser session, the loopback listener) lives here instead, so the lock
 only hides it: after unlocking, the sheet comes back where it was, and an attempt that finished
 while it was hidden shows its result.

 A flow ends only when the person ends it (Cancel) or finishes it; never because its view went away.
 */
@MainActor
final class SetupSessions {
  static let shared = SetupSessions()

  /// One flow: its model and its browser sheet.
  final class Session {
    let model: OnboardingModel
    let presenter: WebAuthenticationPresenter

    init(model: OnboardingModel, presenter: WebAuthenticationPresenter) {
      self.model = model
      self.presenter = presenter
    }
  }

  private var sessions: [String: Session] = [:]

  /// The flow for `key`, made by `make` when there is none.
  func session(_ key: String, make: () -> OnboardingModel) -> Session {
    if let existing = sessions[key] {
      return existing
    }

    let session = Session(model: make(), presenter: WebAuthenticationPresenter())

    sessions[key] = session
    return session
  }

  /**
   The flow for `key`, for a gateway somebody offered (a QR code, a link): always one that began with
   THAT offer. A flow that is already there was started by the person typing, and holds what they
   typed for another gateway (headers, the Access pair, a session token, a sign-in half done), none of
   which may go to the host the offer names, so it is ended and a fresh one takes the offer. A flow that
   already took this very offer is kept: the sheet is built again after every unlock.
   */
  func session(_ key: String, offered offer: GatewayPairingOffer, make: () -> OnboardingModel) -> Session {
    if let existing = sessions[key], existing.model.pairedOffer != offer {
      end(key)
    }

    return session(key) {
      let model = make()

      model.applyPairing(offer)
      return model
    }
  }

  /// The flow ended: stop what it runs and forget the secrets it held.
  func end(_ key: String) {
    guard let session = sessions.removeValue(forKey: key) else {
      return
    }

    session.presenter.close()
    session.model.close()
  }

  /// Whether a flow is kept for `key`.
  func contains(_ key: String) -> Bool {
    sessions[key] != nil
  }

  /// The key of a new gateway's setup, per set of accounts (one app has one).
  static func onboardingKey(_ accounts: GatewayAccounts) -> String {
    "onboarding-\(ObjectIdentifier(accounts).hashValue)"
  }

  /// The key of signing in again to one gateway.
  static func signInKey(_ accounts: GatewayAccounts, gatewayId: String) -> String {
    "signin-\(ObjectIdentifier(accounts).hashValue)-\(gatewayId)"
  }
}
