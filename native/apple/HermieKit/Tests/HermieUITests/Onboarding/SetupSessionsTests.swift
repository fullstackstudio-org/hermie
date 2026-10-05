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

  @Test("an offered gateway always gets a fresh setup: what was typed for another one never reaches it")
  func offerStartsFresh() {
    let accounts = accounts()
    let offer = GatewayPairingOffer(address: "https://gw.example.test", name: "Home")
    let plain = OnboardingContext(mode: .additionalGateway, finish: { _ in })
    let before = OnboardingFlow(context: plain, accounts: accounts)

    // Typed for another gateway: headers, the Access pair and a token, all of which a probe would send.
    before.session.model.address = "https://old.example.test"
    before.session.model.frontDoorKind = .cloudflareAccess
    before.session.model.accessClientID = "old-id"
    before.session.model.accessClientSecret = "old-secret"
    before.session.model.addHeader()
    before.session.model.headers[0].name = "X-Old"
    before.session.model.headers[0].value = "old-value"
    before.session.model.sessionToken = "old-token"

    let offered = OnboardingFlow(
      context: OnboardingContext(mode: .additionalGateway, finish: { _ in }, pairing: offer), accounts: accounts)
    let model = offered.session.model

    #expect(model !== before.session.model, "a new flow, not the old one filled in")
    #expect(before.session.model.sessionToken.isEmpty, "and the old one was ended, its secrets wiped")
    #expect(model.pairedOffer == offer)
    #expect(model.address == "https://gw.example.test" && model.name == "Home")
    #expect(model.headers.isEmpty && model.accessClientID.isEmpty && model.accessClientSecret.isEmpty)
    #expect(model.sessionToken.isEmpty && model.wireHeaders.isEmpty)
    #expect(model.frontDoorKind == .custom)

    // Built again (after an unlock) it is the same flow, still holding the offer, not another fresh one.
    let again = OnboardingFlow(
      context: OnboardingContext(mode: .additionalGateway, finish: { _ in }, pairing: offer), accounts: accounts)

    #expect(again.session.model === model)

    // Another offer is another fresh flow.
    let other = GatewayPairingOffer(address: "https://other.example.test")
    let next = OnboardingFlow(
      context: OnboardingContext(mode: .additionalGateway, finish: { _ in }, pairing: other), accounts: accounts)

    #expect(next.session.model !== model)
    #expect(next.session.model.address == "https://other.example.test")
    SetupSessions.shared.end(next.key)
  }

  @Test("a scan inside a setup opened from a link is not lost when the sheet is built again")
  func scanSurvivesRebuild() {
    let accounts = accounts()
    let x = GatewayPairingOffer(address: "https://x.example.test", name: "X")
    let y = GatewayPairingOffer(address: "https://y.example.test", name: "Y")
    let context = OnboardingContext(mode: .additionalGateway, finish: { _ in }, pairing: x)
    let opened = OnboardingFlow(context: context, accounts: accounts)

    #expect(opened.session.model.pairedOffer == x)

    // The person scans another code inside setup and goes on with it.
    opened.session.model.applyPairing(y)
    #expect(opened.session.model.pairedOffer == y && opened.session.model.address == "https://y.example.test")

    // The sheet is built again (an unlock, a re-render) with the router still holding the offer it was opened from.
    let rebuilt = OnboardingFlow(context: context, accounts: accounts)

    #expect(rebuilt.session.model === opened.session.model, "the Y setup stays")
    #expect(rebuilt.session.model.pairedOffer == y)
    #expect(rebuilt.session.model.address == "https://y.example.test")

    // A different offer from a link is still a fresh setup.
    let z = GatewayPairingOffer(address: "https://z.example.test")
    let fresh = OnboardingFlow(
      context: OnboardingContext(mode: .additionalGateway, finish: { _ in }, pairing: z), accounts: accounts)

    #expect(fresh.session.model !== opened.session.model)
    #expect(fresh.session.model.address == "https://z.example.test")
    SetupSessions.shared.end(fresh.key)
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
