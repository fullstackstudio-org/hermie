import Foundation
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// Settings › Chats reaches the open conversations: the ones without a view of their own follow the
/// default at once, the others keep theirs.
@Suite(.timeLimit(.minutes(1))) @MainActor struct DefaultVisibilityTests {
  private let verbose = VisibilityOptions(level: .verbose, showBotToBot: false, showThinking: true)

  @Test func aChatWithoutAViewOfItsOwnFollowsTheDefault() async {
    let harness = SessionHarness()
    let chat = harness.session.chat("researcher")
    #expect(chat.visibility == SyncedSettings.defaultChatView)

    harness.session.setDefaultVisibility(verbose)

    #expect(chat.visibility == verbose)
    #expect(!chat.hasOwnVisibility)
    await harness.session.shutdown()
  }

  @Test func aChatWithAViewOfItsOwnKeepsIt() async {
    let harness = SessionHarness()
    let chat = harness.session.chat("researcher")
    let own = VisibilityOptions(level: .normal, showBotToBot: true, showThinking: false)

    chat.setVisibility(own)
    harness.session.setDefaultVisibility(verbose)

    #expect(chat.visibility == own)
    #expect(chat.hasOwnVisibility)
    await harness.session.shutdown()
  }

  @Test func aChatOpenedLaterStartsAtTheCurrentDefault() async {
    let harness = SessionHarness()

    harness.session.setDefaultVisibility(verbose)
    harness.session.release("researcher")

    #expect(harness.session.chat("researcher").visibility == verbose)
    await harness.session.shutdown()
  }

  @Test func settingTheSameViewAsTheOwnOneStillMakesItTheChatsOwn() async {
    let harness = SessionHarness()
    let chat = harness.session.chat("researcher")

    // The reader picked what the default happens to be: it is their choice, and stays when the default moves.
    chat.setVisibility(SyncedSettings.defaultChatView)
    harness.session.setDefaultVisibility(verbose)

    #expect(chat.visibility == SyncedSettings.defaultChatView)
    await harness.session.shutdown()
  }
}
