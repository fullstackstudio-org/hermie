import HermieCore
import Testing

@testable import HermieUI

@MainActor
@Suite("Own chats")
struct OwnChatViewTests {
  @Test("the sheet that starts a chat of my own is the router's, and carries the chat it is for")
  func routerSheet() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")

    router.present(.newOwnChat(chat))
    #expect(router.sheet == .newOwnChat(chat))

    router.dismissSheet(.newBot)
    #expect(router.sheet == .newOwnChat(chat), "another sheet's dismissal leaves it up")

    router.dismissSheet(.newOwnChat(chat))
    #expect(router.sheet == nil)
  }

  @Test("a refusal is said in the page's words: the reply-in-flight one has its own sentence")
  func failures() {
    #expect(OwnChatText.failure(ConversationBusyError(botName: "researcher")) == Strings.Chat.Sessions.busy)

    let refused = OwnChatText.failure(ChatRuntimeError(message: "Could not check the registry\nnow"))
    #expect(refused == "Could not check the registry now")
  }

  @Test(arguments: [
    "native.ownChats.start", "native.ownChats.nameHint", "native.conversations.usingHere",
    "native.conversations.useHere"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}
