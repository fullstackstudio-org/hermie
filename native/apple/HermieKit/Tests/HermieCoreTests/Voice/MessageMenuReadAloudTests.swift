import Foundation
import HermieTranscript
import Testing

@testable import HermieCore

/// Read aloud on a message's menu: the bot's words only, dropped (not disabled) where the screen cannot
/// speak, and "Stop reading" for a reply that is being read or waits to be.
@Suite("Message menu: read aloud") struct MessageMenuReadAloudTests {
  private let speaking = MessageMenuContext(canReadAloud: true)

  @Test("a reply has Read aloud under its copies")
  func reply() {
    let menu = MessageMenu.menu(for: MessageMenuTests.reply("a1", "**bold** words"), context: speaking)

    #expect(menu.entries.map(\.action) == [.copyText, .copyMarkdown, .readAloud])
    #expect(menu.entry(.readAloud)?.enabled == true)
  }

  @Test("a reply being read, or waiting its turn, has Stop reading instead")
  func reading() {
    let context = MessageMenuContext(canReadAloud: true, reading: ["a1"])

    #expect(MessageMenu.menu(for: MessageMenuTests.reply("a1", "words"), context: context).entries.map(\.action) == [.copyText, .stopReading])
    #expect(MessageMenu.menu(for: MessageMenuTests.reply("a2", "words"), context: context).entries.map(\.action) == [.copyText, .readAloud])
  }

  @Test("a screen that cannot speak has no such line at all")
  func cannotSpeak() {
    let menu = MessageMenu.menu(for: MessageMenuTests.reply("a1", "words"), context: MessageMenuContext())

    #expect(menu.entry(.readAloud) == nil)
    #expect(menu.entry(.stopReading) == nil)
  }

  @Test("the reader's own words, and a reply with none, are not read")
  func notTheirs() {
    #expect(MessageMenu.menu(for: MessageMenuTests.turn("u1", "my words"), context: speaking).entry(.readAloud) == nil)
    #expect(MessageMenu.menu(for: MessageMenuTests.reply("a1", "  "), context: speaking).entry(.readAloud) == nil)
  }

  @Test("a reply still being written is not offered")
  func streaming() {
    let reply = TranscriptItem.assistant(
      AssistantItem(base: MessageMenuTests.base("a1"), text: "half a thou", streaming: true, interim: false))

    #expect(MessageMenu.menu(for: reply, context: speaking).entry(.readAloud) == nil)
  }

  @Test("the words to read are the reply's Markdown, read off the item")
  func words() {
    #expect(MessageMenu.readAloudText(of: MessageMenuTests.reply("a1", "**bold**")) == "**bold**")
    #expect(MessageMenu.readAloudText(of: MessageMenuTests.reply("a1", " ")) == nil)
    #expect(MessageMenu.readAloudText(of: MessageMenuTests.turn("u1", "mine")) == nil)
  }
}
