import HermieCore
import HermieGateway
import HermieStore
import SwiftUI
import Testing

@testable import HermieUI

/// The lock gate takes the setup and sign-in sheets down while the app is locked; the flow behind
/// them must survive that, and end only when the person ends it.
@MainActor
@Suite("Setup sessions")
struct SetupSessionsTests {
  func accounts() -> GatewayAccounts {
    let launch = AppLaunch(environment: .inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))

    return GatewayAccounts(launch: launch, services: GatewayServices())
  }

  @Test("setup built again (after an unlock) is the same flow, where it was, with the same browser sheet")
  func setupSurvivesItsView() {
    let accounts = accounts()
    let context = OnboardingContext(mode: .firstGateway, finish: { _ in })
    let before = OnboardingFlow(context: context, accounts: accounts)

    before.session.model.address = "gw.example.test"
    before.session.model.sessionToken = "typed-before-the-lock"

    // The lock took the sheet down; unlocking builds it again.
    let after = OnboardingFlow(context: context, accounts: accounts)

    #expect(after.session.model === before.session.model)
    #expect(after.session.presenter === before.session.presenter)
    #expect(after.session.model.address == "gw.example.test")
    #expect(after.session.model.sessionToken == "typed-before-the-lock")

    // Cancel (or finishing) ends it: the secrets go, and the next setup starts empty.
    SetupSessions.shared.end(after.key)

    #expect(before.session.model.sessionToken.isEmpty)
    #expect(OnboardingFlow(context: context, accounts: accounts).session.model.address.isEmpty)
    SetupSessions.shared.end(after.key)
  }

  @Test("signing in again is kept per gateway")
  func signInPerGateway() {
    let accounts = accounts()
    let one = SignInSheet(context: SignInContext(gatewayId: "g0a", finish: {}), accounts: accounts)
    let again = SignInSheet(context: SignInContext(gatewayId: "g0a", finish: {}), accounts: accounts)
    let other = SignInSheet(context: SignInContext(gatewayId: "g0b", finish: {}), accounts: accounts)

    #expect(one.session.model === again.session.model)
    #expect(one.session.model !== other.session.model)

    SetupSessions.shared.end(one.key)
    SetupSessions.shared.end(other.key)
    #expect(!SetupSessions.shared.contains(one.key))
  }
}
