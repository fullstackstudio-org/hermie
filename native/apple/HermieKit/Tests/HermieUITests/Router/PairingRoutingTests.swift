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

  // MARK: What is in the middle of being done is not taken over

  @Test(
    "an offer that arrives while setup, a sign-in or the emergency stop is up waits, and is shown when that sheet is gone",
    arguments: [AppSheet.onboarding(.additionalGateway), .signIn(gatewayId: "g0011223344556677"), .emergencyStop]
  )
  func waitsBehindProtectedSheets(sheet: AppSheet) throws {
    let router = AppRouter()
    router.gatewaysChanged(one)
    router.present(sheet)

    router.handle(try link(offered))
    #expect(router.sheet == sheet, "what the person is doing stays up")
    #expect(router.queuedPairing == offer)

    router.dismissSheet()
    #expect(router.sheet == .pairing(offer), "and the offer is there after")
    #expect(router.queuedPairing == nil)
  }

  @Test("an offer that waited says it came from a link opened earlier; one shown at once does not")
  func fromEarlier() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    router.handle(try link(offered))
    #expect(router.pairingFromEarlier == nil)

    router.present(.onboarding(.additionalGateway))
    router.handle(try link(offered))
    router.dismissSheet()
    #expect(router.sheet == .pairing(offer) && router.pairingFromEarlier == offer)

    router.dismissSheet()
    #expect(router.pairingFromEarlier == nil, "it is a note about that sheet only")
  }

  @Test("an offer that waited more than five minutes is forgotten, not shown out of the blue")
  func lapses() throws {
    let router = AppRouter()
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let moment = Locked(clock)

    router.now = { moment.value }
    router.gatewaysChanged(one)
    router.present(.signIn(gatewayId: home.id))
    router.handle(try link(offered))

    clock.addTimeInterval(AppRouter.queuedPairingLifetime + 1)
    moment.value = clock
    router.dismissSheet()
    #expect(router.sheet == nil && router.queuedPairing == nil, "a link from long ago is not what the person looks at")

    // Inside the time it is shown.
    router.present(.signIn(gatewayId: home.id))
    router.handle(try link(offered))
    clock.addTimeInterval(AppRouter.queuedPairingLifetime - 1)
    moment.value = clock
    router.dismissSheet()
    #expect(router.sheet == .pairing(offer))
  }

  @Test("the newest of several waiting offers is the one shown")
  func newestWaits() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)
    router.present(.onboarding(.additionalGateway))

    router.handle(try link(offered))
    router.handle(try link("hermie://add-gateway?url=https%3A%2F%2Fother.example.test"))
    router.dismissSheet(.onboarding(.additionalGateway))
    #expect(router.sheet == .pairing(GatewayPairingOffer(address: "https://other.example.test")))
  }

  @Test("sheets that are not in the middle of something are replaced, as a chat link replaces them")
  func replacesOtherSheets() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)

    for sheet in [AppSheet.settings, .search, .gatewayPicker, .needsYou] {
      router.present(sheet)
      router.handle(try link(offered))
      #expect(router.sheet == .pairing(offer), "\(sheet)")
      router.dismissSheet()
    }

    #expect(router.queuedPairing == nil)
  }

  @Test("an offer that setup took is spent when setup is dismissed or replaced, not only when it finishes")
  func offerIsSpentWithItsSheet() throws {
    let router = AppRouter()
    router.gatewaysChanged(one)
    router.confirmPairing(offer)
    #expect(router.pairingOffer == offer)

    // The system closes the sheet (a swipe, the lock): the shell reports the change.
    router.sheet = nil
    router.sheetChanged()
    #expect(router.pairingOffer == nil)

    router.confirmPairing(offer)
    router.present(.settings)
    #expect(router.pairingOffer == nil, "replaced by another sheet")

    router.confirmPairing(offer)
    router.dismissSheet()
    #expect(router.pairingOffer == nil)
  }

  @Test("the notice for a refused link has words")
  func noticeWords() {
    for problem in [GatewayPairingOffer.Problem.notAnOffer, .notAnAddress, .notSecure(host: "x.example")] {
      #expect(!NoticeStack.text(for: .pairingRefused(problem)).isEmpty)
    }
  }
}

/// A value a closure reads and a test moves.
private final class Locked: @unchecked Sendable {
  var value: Date

  init(_ value: Date) { self.value = value }
}
