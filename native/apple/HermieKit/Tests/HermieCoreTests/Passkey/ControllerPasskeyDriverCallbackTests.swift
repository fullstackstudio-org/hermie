import AuthenticationServices
import Foundation
import Testing

@testable import HermieCore

/// The system's objects, for a closure on another queue (they are not `Sendable`).
private final class Unchecked<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}

/// `ASAuthorizationController` calls its delegate through the Objective-C entry points. If the
/// driver's methods were the main actor's, a call from another queue would trap in Swift 6's
/// isolation check, the way `ASWebAuthenticationSession`'s handler took the Mac app down.
@MainActor
@Suite("ControllerPasskeyDriver callbacks")
struct ControllerPasskeyDriverCallbackTests {
  @Test("the delegate can be called from a background queue")
  func delegateOffMain() async {
    let driver = ControllerPasskeyDriver(anchor: { nil })
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: "confirm.example")
    let request = provider.createCredentialAssertionRequest(challenge: Data(repeating: 7, count: 32))
    let controller = Unchecked(ASAuthorizationController(authorizationRequests: [request]))
    let delegate = Unchecked(driver as AnyObject)
    let error = Unchecked(NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.canceled.rawValue))

    let returned = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.global().async {
        let selector = NSSelectorFromString("authorizationController:didCompleteWithError:")

        _ = delegate.value.perform(selector, with: controller.value, with: error.value)
        done.resume(returning: true)
      }
    }

    #expect(returned)
  }
}
