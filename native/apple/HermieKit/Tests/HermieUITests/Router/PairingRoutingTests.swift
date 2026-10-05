import Foundation
import HermieCore
import HermieShared
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let one = GatewayIndex(entries: [home], activeId: home.id)
private let none = GatewayIndex(entries: [], activeId: nil)

private let offered = "hermie://add-gateway?url=https%3A%2F%2Fgw.example.test&name=Home%20lab&auth=native_pkce"
private let offer = GatewayPairingOffer(address: "https://gw.example.test", name: "Home lab", authHint: .nativePKCE)

/// What an add-gateway link does to the router (NX-14): it shows what it names and asks, and adds nothing.
@MainActor
@Suite("Router: pairing links")
struct PairingRoutingTests {
  private func link(_ text: String) throws -> DeepLink { try #require(DeepLink(text)) }

  @Test("a link to add a gateway opens the confirmation with what it names, and nothing else")
  func opensTheOffer() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    let effects = router.handle(try link(offered))

    #expect(effects.isEmpty, "nothing is switched, activated or added")
    #expect(router.sheet == .pairing(offer))
    #expect(router.pairingOffer == nil, "not taken until the person says so")
    #expect(router.notice == nil)
    #expect(router.selectedChat == nil && router.selectedGatewayId == home.id)
  }

  @Test("it works with no gateway at all, which is when it is most useful")
  func firstGateway() throws {
    let router = AppRouter()
    router.gatewaysChanged(none)

    router.handle(try link(offered))
    #expect(router.sheet == .pairing(offer))

    router.confirmPairing(offer)
    #expect(router.sheet == .onboarding(.firstGateway))
    #expect(router.pairingOffer == offer)
  }

  @Test("an offer that arrives before the gateway list is read waits for it")
  func waits() throws {
    let router = AppRouter()

    router.handle(try link(offered))
    #expect(router.sheet == nil)
    #expect(router.pendingLinks.count == 1)

    router.gatewaysChanged(one)
    #expect(router.sheet == .pairing(offer))
    #expect(router.pendingLinks.isEmpty)
  }

  @Test("taking the offer opens setup for another gateway, and ending setup spends the offer")
  func confirm() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)
    router.handle(try link(offered))

    router.confirmPairing(offer)
    #expect(router.sheet == .onboarding(.additionalGateway))
    #expect(router.pairingOffer == offer)

    router.clearPairing()
    #expect(router.pairingOffer == nil)
  }

  @Test("an address that may not come from a link is refused in a notice, and no sheet opens")
  func refusals() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    router.handle(try link("hermie://add-gateway?url=http%3A%2F%2Fgw.example.test"))
    #expect(router.sheet == nil)
    #expect(router.notice == .pairingRefused(.notSecure(host: "gw.example.test")))
  }

  @Test("a link that is not a well-formed offer is not even parsed, and so changes nothing")
  func hostile() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    for text in [
      "hermie://add-gateway?url=https%3A%2F%2Fuser%3Apass%40gw.example.test",
      "hermie://add-gateway?url=javascript%3Aalert(1)", "hermie://add-gateway", "hermie://add-gateway?name=x"
    ] {
      #expect(router.handle(url: try #require(URL(string: text))).isEmpty)
    }

    #expect(router.sheet == nil && router.notice == nil && router.pairingOffer == nil)
  }

  @Test("parameters other than the three never reach the offer")
  func extras() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    router.handle(
      url: try #require(URL(string: offered + "&token=secret&password=hunter2&header=Authorization%3A%20Bearer%20x")))

    #expect(router.sheet == .pairing(offer))
  }

  @Test("a later offer replaces an earlier one that was not answered")
  func replaced() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    router.handle(try link(offered))
    router.handle(try link("hermie://add-gateway?url=https%3A%2F%2Fother.example.test"))
    #expect(router.sheet == .pairing(GatewayPairingOffer(address: "https://other.example.test")))
  }

  @Test("the notice for a refused link has words")
  func noticeWords() {
    for problem in [GatewayPairingOffer.Problem.notAnOffer, .notAnAddress, .notSecure(host: "x.example")] {
      #expect(!NoticeStack.text(for: .pairingRefused(problem)).isEmpty)
    }
  }
}
