import Foundation
import HermieShared
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let work = GatewayIndex.Entry(id: "g8899aabbccddeeff", key: "bbbbbbbbbbbbbbbb")
private let both = GatewayIndex(entries: [home, work], activeId: home.id)

/// A tap on a `security` notification: the gateway it names is selected (and made live) so
/// Settings shows its account page; one this device does not have changes nothing.
@MainActor
@Suite("Router: a gateway's account")
struct AppRouterAccountTests {
  @Test("the live gateway's account opens without a switch and keeps nothing else")
  func liveGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))

    let (shown, effects) = router.showAccount(of: home.id)

    #expect(shown)
    #expect(effects.isEmpty)
    #expect(router.selectedGatewayId == home.id)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
  }

  @Test("another configured gateway is made live, and the chat of the old one closes")
  func otherGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))

    let (shown, effects) = router.showAccount(of: work.id)

    #expect(shown)
    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == nil)
  }

  @Test("a gateway this device does not have, or a list not read yet, changes nothing")
  func unknownGateway() {
    let router = AppRouter()
    #expect(router.showAccount(of: home.id).shown == false)

    router.gatewaysChanged(both)
    #expect(router.showAccount(of: "g-gone").shown == false)
    #expect(router.selectedGatewayId == home.id)
  }
}
