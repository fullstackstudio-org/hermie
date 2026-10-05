import Foundation
import HermieCore
import HermieShared
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let work = GatewayIndex.Entry(id: "g8899aabbccddeeff", key: "bbbbbbbbbbbbbbbb")
private let both = GatewayIndex(entries: [home, work], activeId: home.id)

private func chatHit(_ gateway: GatewayIndex.Entry, bot: String = "researcher") -> SearchDestination {
  SearchDestination(gatewayID: gateway.id, bot: bot, target: .botChat)
}

private func threadHit(_ gateway: GatewayIndex.Entry, bot: String = "researcher") -> SearchDestination {
  SearchDestination(
    gatewayID: gateway.id, bot: bot, target: .conversation(id: "root-1", resolvedID: "tip-1", title: "Old one"))
}

/// What following a search result does to the router: the chat or the viewer it opens, the words it
/// leaves for the screen to find, the gateway switch it asks for, and what it closes on its way.
@MainActor
@Suite("Router: search results")
struct SearchRoutingTests {
  @Test("a hit in the bot's own chat opens it and leaves the words for the chat to find")
  func botChat() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openSearchResult(chatHit(home), finding: "  invoice ")
    let chat = ChatRef(gatewayId: home.id, bot: "researcher")

    #expect(effects.isEmpty)
    #expect(router.selectedChat == chat)
    #expect(router.detailPath.isEmpty)
    #expect(router.chatFind?.chat == chat)
    #expect(router.chatFind?.query == "invoice")
    #expect(router.conversationFind == nil)
  }

  @Test("a hit in another conversation opens the viewer under the Conversations page, with the words")
  func conversationHit() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openSearchResult(threadHit(home), finding: "invoice")
    let chat = ChatRef(gatewayId: home.id, bot: "researcher")

    #expect(effects.isEmpty)
    #expect(router.selectedChat == chat)
    #expect(
      router.detailPath == [.sessions(chat), .conversation(chat, id: "root-1", resolvedID: "tip-1", title: "Old one")])
    #expect(router.conversationFind?.chat == chat)
    #expect(router.conversationFind?.conversationID == "root-1")
    #expect(router.conversationFind?.query == "invoice")
    #expect(router.chatFind == nil)
  }

  @Test("the viewer's way back to the conversations and to the chat both stay on the route")
  func wayBack() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openSearchResult(threadHit(home), finding: "invoice")

    router.pop()
    #expect(router.detailPath == [.sessions(ChatRef(gatewayId: home.id, bot: "researcher"))])
    // The viewer is gone, and so is what was left for it.
    #expect(router.conversationFind == nil)

    router.openSearchResult(threadHit(home), finding: "invoice")
    router.showChat()
    #expect(router.detailPath.isEmpty)
    #expect(router.conversationFind == nil)
  }

  @Test("a hit on another gateway selects it, asks for the switch, and keeps the request for its chat")
  func otherGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "writer"))

    let effects = router.openSearchResult(chatHit(work), finding: "invoice")
    let chat = ChatRef(gatewayId: work.id, bot: "researcher")

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == chat)
    #expect(router.chatFind?.chat == chat)

    // The switch commits: the chat and the request survive it.
    router.gatewaysChanged(GatewayIndex(entries: [home, work], activeId: work.id))
    #expect(router.selectedChat == chat)
    #expect(router.chatFind?.chat == chat)
  }

  @Test("a conversation on another gateway keeps its viewer and request through the switch")
  func otherGatewayConversation() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openSearchResult(threadHit(work), finding: "invoice")

    #expect(effects == [.activateGateway(work.id)])

    router.gatewaysChanged(GatewayIndex(entries: [home, work], activeId: work.id))

    #expect(router.detailPath.count == 2)
    #expect(router.conversationFind?.chat.gatewayId == work.id)
  }

  @Test("a gateway this device no longer has opens nothing and says so")
  func unknownGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let ghost = GatewayIndex.Entry(id: "g1111111111111111", key: "cccccccccccccccc")
    let effects = router.openSearchResult(chatHit(ghost), finding: "invoice")

    #expect(effects.isEmpty)
    #expect(router.selectedChat == nil)
    #expect(router.notice == .gatewayNotConfigured)
  }

  @Test("following a result closes the search and what covers the chat, not a setup in progress")
  func sheets() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    router.presentSearch(seed: "inv")
    #expect(router.sheet == .search)
    #expect(router.searchSeed == "inv")

    router.openSearchResult(chatHit(home), finding: "invoice")
    #expect(router.sheet == nil)

    router.present(.settings)
    router.openSearchResult(chatHit(home), finding: "invoice")
    #expect(router.sheet == nil)

    router.present(.onboarding(.additionalGateway))
    router.openSearchResult(chatHit(home), finding: "invoice")
    #expect(router.sheet == .onboarding(.additionalGateway))
  }

  @Test("the same words asked twice are looked for twice, and a settled request is let go")
  func requestsAreIndependent() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    router.openSearchResult(threadHit(home), finding: "invoice")
    let first = router.conversationFind?.id
    router.openSearchResult(threadHit(home), finding: "invoice")
    let second = router.conversationFind?.id

    #expect(first != nil && second != nil && first != second)

    router.settleConversationFind(first ?? -1)
    #expect(router.conversationFind?.id == second)

    router.settleConversationFind(second ?? -1)
    #expect(router.conversationFind == nil)
  }

  @Test("opening another chat drops the words of the hit that was followed")
  func anotherChatDropsTheRequest() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openSearchResult(threadHit(home), finding: "invoice")

    router.openChat(ChatRef(gatewayId: home.id, bot: "writer"))

    #expect(router.conversationFind == nil)
  }

  @Test("a blank query opens the conversation and asks for nothing")
  func blankQuery() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    router.openSearchResult(threadHit(home), finding: "   ")

    #expect(router.detailPath.count == 2)
    #expect(router.conversationFind == nil)
  }

  @Test("a conversation link, as Spotlight hands it, opens the viewer on the right gateway")
  func conversationLink() throws {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let url = try #require(
      DeepLink.conversation(bot: "researcher", session: "20260915_142233_a1b2c3", gatewayKey: work.key).url)
    let effects = router.handle(url: url)
    let chat = ChatRef(gatewayId: work.id, bot: "researcher")

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedChat == chat)
    #expect(
      router.detailPath == [
        .sessions(chat),
        .conversation(chat, id: "20260915_142233_a1b2c3", resolvedID: "20260915_142233_a1b2c3", title: "")
      ])
    // A link carries no words.
    #expect(router.conversationFind == nil)
  }

  @Test("a conversation link for a gateway this device has not configured opens nothing")
  func conversationLinkUnknownGateway() throws {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let url = try #require(DeepLink.conversation(bot: "x", session: "s1", gatewayKey: "dddddddddddddddd").url)

    #expect(router.handle(url: url).isEmpty)
    #expect(router.selectedChat == nil)
    #expect(router.notice == .gatewayNotConfigured)
  }

  @Test("a conversation link that arrives before the gateway list waits for it")
  func conversationLinkWaits() throws {
    let router = AppRouter()
    let url = try #require(DeepLink.conversation(bot: "x", session: "s1", gatewayKey: home.key).url)

    #expect(router.handle(url: url).isEmpty)
    #expect(router.pendingLinks.count == 1)

    router.gatewaysChanged(both)

    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "x"))
    #expect(router.detailPath.count == 2)
  }
}
