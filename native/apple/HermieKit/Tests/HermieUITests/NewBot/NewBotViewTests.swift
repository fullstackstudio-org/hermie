import HermieCore
import Testing

@testable import HermieUI

@MainActor
@Suite("New bot")
struct NewBotViewTests {
  @Test("the sheet is the router's, opened and closed like any other")
  func routerSheet() {
    let router = AppRouter()

    router.present(.newBot)
    #expect(router.sheet == .newBot)

    router.dismissSheet(.settings)
    #expect(router.sheet == .newBot, "another sheet's dismissal leaves it up")

    router.dismissSheet(.newBot)
    #expect(router.sheet == nil)
  }

  @Test("opening the bot that was made selects its chat on the gateway it was made on")
  func openChat() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "scout")

    router.openChat(chat)

    #expect(router.selectedChat == chat)
    #expect(router.section == .chats)
  }

  @Test("every problem with a handle is said, and said about the handle")
  func problems() {
    let sentences = [
      NewBotText.problem(.empty),
      NewBotText.problem(.builtIn),
      NewBotText.problem(.shape(suggestion: "my-work")),
      NewBotText.problem(.reserved("sudo")),
      NewBotText.problem(.taken("alpha"))
    ]

    #expect(Set(sentences).count == 5)
    #expect(sentences.allSatisfy { !$0.hasPrefix("native.") })
    #expect(sentences[2].contains("my-work"))
    #expect(sentences[3].contains("sudo"))
    #expect(sentences[4].contains("alpha"))
  }

  @Test("a failure is said in the sheet's words, with the gateway's own words only where it has some")
  func failures() {
    let refused = NewBotText.failure(.request(.refused("Profile exists")))
    let offline = NewBotText.failure(.request(.offline))

    #expect(refused.contains("Profile exists"))
    #expect(refused != offline)
    #expect(NewBotText.failure(.notListed("scout")).contains("scout"))
    #expect(NewBotText.failure(.request(.forbidden("nope"))) != refused)
    #expect(!NewBotText.failure(.request(.forbidden("nope"))).contains("nope"))
  }

  @Test("a warning is not a problem: the handle is still fine")
  func warning() {
    #expect(!NewBotText.warning(.subcommand("chat")).isEmpty)
  }

  @Test(arguments: [
    "native.newBot.menuTitle", "native.newBot.open", "native.newBot.handleEmpty", "native.newBot.handleBuiltIn",
    "native.newBot.handleShape", "native.newBot.handleReserved", "native.newBot.handleTaken",
    "native.newBot.subcommandWarning", "native.newBot.notListed", "native.newBot.offline",
    "native.newBot.unsupported", "native.newBot.readOnly", "native.newBot.ready", "native.newBot.openChat"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}
