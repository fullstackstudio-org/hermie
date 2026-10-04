import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// The parts of the Conversations page and the viewer that are plain functions: the words of the
/// page, its sentences in all three languages, and the router's way in. (The views themselves are
/// not driven by UI tests.)
@MainActor
struct ConversationsViewTests {
  // MARK: The words

  @Test func aRowSaysHowManyMessagesAndWhenWhereTheGatewayKnew() {
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let known = Conversation(id: "s", title: "T", messageCount: 3, lastActive: 1_789_999_990, kind: .past)
    let unknown = Conversation(id: "s", title: "T", messageCount: 3, lastActive: 0, kind: .past)

    let withTime = ConversationsText.meta(known, now: now, calendar: calendar)

    #expect(withTime.hasPrefix(Strings.Chat.Sessions.messages(count: 3)))
    #expect(withTime.contains(" · "))
    #expect(ConversationsText.meta(unknown, now: now, calendar: calendar) == Strings.Chat.Sessions.messages(count: 3))
  }

  @Test func aRefusalCarriesTheGatewaysReasonAndABusyChatHasItsOwnSentence() {
    let refused = ConversationsText.notice(.failed(message: "title in use", busy: false))
    let busy = ConversationsText.notice(.failed(message: "ignored", busy: true))

    #expect(refused == NativeStrings.Conversations.actionFailed(message: "title in use"))
    #expect(refused.contains("title in use"))
    #expect(busy == Strings.Chat.Sessions.busy)
    #expect(!busy.contains("ignored"))
  }

  @Test func eachOutcomeHasItsOwnSentence() {
    let sentences = [
      ConversationsText.notice(.renamed), ConversationsText.notice(.deleted), ConversationsText.notice(.adopted)
    ]

    #expect(Set(sentences).count == 3)
    #expect(sentences.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
  }

  // MARK: Languages

  /// Every sentence of the page is in the Native table in English, Dutch and German, and the three
  /// differ where the languages differ.
  @Test(arguments: [
    "native.conversations.hint", "native.conversations.new", "native.conversations.newConfirmBody",
    "native.conversations.newConfirm", "native.conversations.renamed", "native.conversations.deleted",
    "native.conversations.adopted", "native.conversations.actionFailed", "native.conversations.readOnly",
    "native.conversations.backToChat", "native.conversations.actionsFor", "native.conversations.noMessages"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    var texts: [String: String] = [:]

    for language in ["en", "nl", "de"] {
      let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
      let bundle = try #require(Bundle(path: path))
      let text = bundle.localizedString(forKey: key, value: "MISSING", table: "Native")

      #expect(text != "MISSING", "\(key) is missing in \(language)")
      #expect(!text.isEmpty)
      texts[language] = text
    }

    #expect(texts["nl"] != texts["en"], "\(key) was not translated into Dutch")
    #expect(texts["de"] != texts["en"], "\(key) was not translated into German")
  }

  // MARK: The way in

  @MainActor
  @Test func openingTheConversationsSelectsTheChatAndPushesThePageOnce() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")

    router.showConversations(chat)
    #expect(router.selectedChat == chat)
    #expect(router.detailPath == [.sessions(chat)])

    router.showConversations(chat)
    #expect(router.detailPath == [.sessions(chat)], "asked again while it is showing: nothing is stacked")

    let other = ChatRef(gatewayId: "g1", bot: "writer")
    router.showConversations(other)
    #expect(router.selectedChat == other)
    #expect(router.detailPath == [.sessions(other)])
  }

  @MainActor
  @Test func aConversationOpensOverThePageAndTheWayBackIsTheChatOrThePage() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")
    router.showConversations(chat)

    router.showConversation(chat, id: "s-2", resolvedID: "tip-2", title: "Trip planning")
    #expect(router.detailPath == [.sessions(chat), .conversation(chat, id: "s-2", resolvedID: "tip-2", title: "Trip planning")])
    #expect(router.covers(chat), "a page over the chat marks nothing read in it")

    router.pop()
    #expect(router.detailPath == [.sessions(chat)])

    router.showConversation(chat, id: "s-2", resolvedID: "tip-2", title: "Trip planning")
    router.showChat()
    #expect(router.detailPath.isEmpty)
    #expect(router.selectedChat == chat)

    router.pop()
    #expect(router.detailPath.isEmpty, "popping nothing is nothing")
  }

  @Test func theRoutesSurviveARelaunch() {
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")
    let snapshot = RouterSnapshot(
      selectedChat: chat,
      detailPath: [.sessions(chat), .conversation(chat, id: "s-2", resolvedID: "tip-2", title: "Trip \"planning\" ✈︎")]
    )

    #expect(RouterSnapshot.decode(snapshot.encoded()) == snapshot)
  }
}
