import Foundation
import HermieShared
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let work = GatewayIndex.Entry(id: "g8899aabbccddeeff", key: "bbbbbbbbbbbbbbbb")
private let both = GatewayIndex(entries: [home, work], activeId: home.id)

private func link(_ text: String) -> DeepLink {
  DeepLink(text)!
}

@MainActor
@Suite("Router: deep links")
struct AppRouterLinkTests {
  @Test("a chat link with no key opens the chat on the live gateway")
  func noKey() {
    let router = AppRouter()

    router.gatewaysChanged(both)

    let effects = router.handle(link("hermie://chat/alice"))

    #expect(effects.isEmpty)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
    #expect(router.section == .chats)
    #expect(router.notice == nil)
  }

  @Test("a chat link for the live gateway's key opens without a switch")
  func liveKey() {
    let router = AppRouter()

    router.gatewaysChanged(both)

    #expect(router.handle(link("hermie://chat/alice?gateway=\(home.key)")).isEmpty)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
  }

  @Test("a chat link for another configured gateway selects it and asks for the switch")
  func otherKey() {
    let router = AppRouter()

    router.gatewaysChanged(both)

    let effects = router.handle(link("hermie://chat/b%C3%B6b?gateway=\(work.key)"))

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "böb"))

    // An unrelated registry write before the switch commits keeps the selection.
    router.gatewaysChanged(both)
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "böb"))

    // The switch commits.
    router.gatewaysChanged(GatewayIndex(entries: [home, work], activeId: work.id))
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "böb"))
  }

  @Test("a chat link for a gateway this device does not know opens nothing and says so")
  func unknownKey() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))

    let effects = router.handle(link("hermie://chat/mallory?gateway=cccccccccccccccc"))

    #expect(effects.isEmpty)
    #expect(router.notice == .gatewayNotConfigured)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
    #expect(router.selectedGatewayId == home.id)

    router.dismissNotice()
    #expect(router.notice == nil)
  }

  @Test("a chat link with no gateway configured says so")
  func noGateway() {
    let router = AppRouter()

    router.gatewaysChanged(GatewayIndex(entries: [], activeId: nil))

    #expect(router.handle(link("hermie://chat/alice")).isEmpty)
    #expect(router.notice == .noGatewayYet)
    #expect(router.selectedChat == nil)
  }

  @Test("links that arrive before the gateway list wait, then replay in order")
  func beforeReady() {
    let router = AppRouter()

    #expect(router.handle(link("hermie://folder/inbox")).isEmpty)
    #expect(router.handle(link("hermie://chat/alice?gateway=\(work.key)")).isEmpty)
    #expect(!router.isReady)
    #expect(router.pendingLinks.count == 2)
    #expect(router.selectedChat == nil)

    let effects = router.gatewaysChanged(both)

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.pendingLinks.isEmpty)
    #expect(router.focusedFolderId == "inbox")
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "alice"))
  }

  @Test("a link closes Settings and the picker so the chat is visible, but not setup")
  func sheets() {
    let router = AppRouter()

    router.gatewaysChanged(both)

    router.present(.settings)
    router.handle(link("hermie://chat/alice"))
    #expect(router.sheet == nil)

    router.present(.onboarding(.additionalGateway))
    router.handle(link("hermie://chat/bob"))
    #expect(router.sheet == .onboarding(.additionalGateway))
  }

  @Test("a flow that finishes late closes its own sheet, never the one that replaced it")
  func lateFinish() {
    let router = AppRouter()

    router.present(.onboarding(.firstGateway))
    router.present(.signIn(gatewayId: home.id))
    router.dismissSheet(.onboarding(.firstGateway))
    #expect(router.sheet == .signIn(gatewayId: home.id))

    router.dismissSheet(.signIn(gatewayId: home.id))
    #expect(router.sheet == nil)
  }

  @Test("share and Shortcut links are queued for their tasks; anything else is ignored")
  func queued() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(link("hermie://share/s-1"))
    router.handle(link("hermie://intent/i.2"))

    #expect(router.pendingShares == ["s-1"])
    #expect(router.pendingIntents == ["i.2"])
    #expect(router.handle(url: URL(string: "https://example.com/chat/alice")!).isEmpty)
    #expect(router.handle(url: URL(string: "hermie://chat/a/b")!).isEmpty)
    #expect(router.selectedChat == nil)
  }
}

@MainActor
@Suite("Router: selection and gateways")
struct AppRouterSelectionTests {
  @Test("opening another chat clears what was pushed on the previous one")
  func openClearsPath() {
    let router = AppRouter()
    let alice = ChatRef(gatewayId: home.id, bot: "alice")

    router.gatewaysChanged(both)
    router.openChat(alice)
    router.push(.botProfile(alice))
    router.openChat(alice)
    #expect(router.detailPath == [.botProfile(alice)])

    router.openChat(ChatRef(gatewayId: home.id, bot: "bob"))
    #expect(router.detailPath.isEmpty)

    router.select(nil)
    #expect(router.selectedChat == nil)
  }

  @Test("switching gateway closes the chat and asks for the switch; the live one asks nothing")
  func switching() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))
    router.present(.gatewayPicker)

    #expect(router.switchGateway(to: home.id).isEmpty)
    #expect(router.selectedChat != nil)

    #expect(router.switchGateway(to: work.id) == [.activateGateway(work.id)])
    #expect(router.selectedChat == nil)
    #expect(router.sheet == nil)

    #expect(router.switchGateway(to: "g0000000000000000").isEmpty)
  }

  @Test("a gateway switched from another window moves the selection and closes the chat")
  func switchedElsewhere() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))
    router.gatewaysChanged(GatewayIndex(entries: [home, work], activeId: work.id))

    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == nil)
  }

  @Test("removing the selected chat's gateway closes it")
  func removed() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))
    router.gatewaysChanged(GatewayIndex(entries: [work], activeId: work.id))

    #expect(router.selectedChat == nil)
    #expect(router.selectedGatewayId == work.id)
  }

  @Test("the Find command is a counter the search task watches")
  func find() {
    let router = AppRouter()

    router.requestFind()
    router.requestFind()
    #expect(router.findRequests == 2)
  }
}

@MainActor
@Suite("Router: restoration")
struct AppRouterRestorationTests {
  @Test("a snapshot round-trips through its stored form")
  func roundTrip() throws {
    let alice = ChatRef(gatewayId: home.id, bot: "alice")
    let snapshot = RouterSnapshot(section: .activity, selectedChat: alice, detailPath: [.sessions(alice)])

    #expect(RouterSnapshot.decode(snapshot.encoded()) == snapshot)
    #expect(RouterSnapshot.decode(Data("{".utf8)) == nil)
    #expect(RouterSnapshot.decode(nil) == nil)
  }

  @Test("a restored chat on the live gateway comes back with its path")
  func restoresLiveChat() {
    let router = AppRouter()
    let alice = ChatRef(gatewayId: home.id, bot: "alice")

    router.restore(RouterSnapshot(section: .chats, selectedChat: alice, detailPath: [.botProfile(alice)]))
    router.gatewaysChanged(both)

    #expect(router.selectedChat == alice)
    #expect(router.detailPath == [.botProfile(alice)])
    #expect(router.snapshot == RouterSnapshot(section: .chats, selectedChat: alice, detailPath: [.botProfile(alice)]))
  }

  @Test("a restored chat on a gateway that is gone, or not live, is dropped")
  func dropsStaleChat() {
    let gone = AppRouter()

    gone.restore(RouterSnapshot(selectedChat: ChatRef(gatewayId: "g1234123412341234", bot: "alice")))
    gone.gatewaysChanged(both)
    #expect(gone.selectedChat == nil)

    let notLive = AppRouter()

    notLive.gatewaysChanged(both)
    notLive.restore(RouterSnapshot(selectedChat: ChatRef(gatewayId: work.id, bot: "alice")))
    #expect(notLive.selectedChat == nil)
  }

  @Test("a link always wins over a restored snapshot")
  func linkWins() {
    let router = AppRouter()

    router.handle(link("hermie://chat/bob"))
    router.restore(RouterSnapshot(section: .routines, selectedChat: ChatRef(gatewayId: home.id, bot: "alice")))
    router.gatewaysChanged(both)

    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "bob"))
    #expect(router.section == .chats)
  }
}
