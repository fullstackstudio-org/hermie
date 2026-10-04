import Foundation
import HermieTranscript
import Testing

@testable import HermieCore

/// The menu of a message (`MessageMenu`): which lines each message has, what a line copies, and the
/// rules a line is disabled or left out by.
@Suite("Message menu") struct MessageMenuTests {
  static func base(_ id: String, _ seq: Int = 1) -> ItemBase {
    ItemBase(id: id, seq: seq, ts: 1, origin: .history, version: 1)
  }

  static func reply(_ id: String, _ text: String, interim: Bool = false) -> TranscriptItem {
    .assistant(AssistantItem(base: base(id), text: text, streaming: false, interim: interim))
  }

  static func turn(_ id: String, _ text: String, author: String? = nil, attachments: [String]? = nil) -> TranscriptItem {
    .user(
      UserItem(base: base(id), text: text, attachments: attachments, author: author.map { MessageAuthor(id: $0) }))
  }

  private let live = MessageMenuContext(regenerateTarget: "a1", canEdit: true, canBranch: true)

  // MARK: Replies

  @Test("a reply with only words has Copy text, Regenerate when it is the newest, and Branch")
  func plainReply() {
    let menu = MessageMenu.menu(for: Self.reply("a1", "just words"), context: live)

    #expect(menu.entries == [.init(.copyText), .init(.regenerate), .init(.branch)])
    #expect(menu.links.isEmpty)
  }

  @Test("a reply with Markdown has Copy as Markdown as well, after Copy text")
  func markdownReply() {
    let menu = MessageMenu.menu(for: Self.reply("a1", "**bold** words"), context: live)

    #expect(menu.entries.map(\.action) == [.copyText, .copyMarkdown, .regenerate, .branch])
  }

  @Test("an older reply has no Regenerate")
  func olderReply() {
    let menu = MessageMenu.menu(for: Self.reply("a0", "an earlier answer"), context: live)

    #expect(menu.entries.map(\.action) == [.copyText, .branch])
  }

  @Test("the copies differ: plain words without the marks, the source with them")
  func copyPayloads() {
    let item = Self.reply("a1", "# Title\n\nSome **bold** and a [link](https://example.com).")

    #expect(MessageMenu.copyText(of: item) == "Title\n\nSome bold and a link.")
    #expect(MessageMenu.copyMarkdown(of: item) == "# Title\n\nSome **bold** and a [link](https://example.com).")
    #expect(MessageMenu.copyMarkdown(of: Self.turn("u1", "typed *as is*")) == nil, "the reader's own words have one copy")
  }

  @Test("a reply with no words has no copy lines")
  func emptyReply() {
    let menu = MessageMenu.menu(for: Self.reply("a1", " \n "), context: live)

    #expect(menu.entries.map(\.action) == [.regenerate, .branch])
    #expect(MessageMenu.copyText(of: Self.reply("a1", "")) == nil)
    #expect(MessageMenu.copyMarkdown(of: Self.reply("a1", "")) == nil)
  }

  @Test("a message that holds links lists them: one line for one link, a submenu for several")
  func links() {
    let one = MessageMenu.menu(for: Self.reply("a1", "Docs: https://example.com/a"), context: live)
    #expect(one.links == ["https://example.com/a"])

    let many = MessageMenu.menu(
      for: Self.reply("a1", "[a](https://a.example) and [b](https://b.example) and https://a.example"), context: live)
    #expect(many.links == ["https://a.example", "https://b.example"], "no duplicates")
  }

  // MARK: The reader's own turns

  @Test("the reader's own turn has Copy, Edit and resend, and Branch")
  func ownTurn() {
    let menu = MessageMenu.menu(for: Self.turn("u1", "write a haiku"), context: live)

    #expect(menu.entries == [.init(.copyText), .init(.editResend), .init(.branch)])
    #expect(MessageMenu.copyText(of: Self.turn("u1", "write *a* haiku")) == "write *a* haiku", "copied as typed")
  }

  @Test("a colleague's turn in a shared chat cannot be edited and sent as the reader's")
  func colleagueTurn() {
    let shared = MessageMenuContext(
      authors: RetryAuthors(trusted: true, own: "oidc:me"), canEdit: true, canBranch: true)

    #expect(
      MessageMenu.menu(for: Self.turn("u1", "mine", author: "oidc:me"), context: shared).entry(.editResend) != nil)
    #expect(
      MessageMenu.menu(for: Self.turn("u2", "theirs", author: "oidc:sam"), context: shared).entry(.editResend) == nil)
    #expect(
      MessageMenu.menu(for: Self.turn("u2", "theirs", author: "oidc:sam"), context: shared).entry(.copyText) != nil,
      "copying is theirs to read")

    let unknownReader = MessageMenuContext(authors: RetryAuthors(trusted: true, own: nil), canEdit: true)
    #expect(MessageMenu.menu(for: Self.turn("u2", "theirs", author: "oidc:sam"), context: unknownReader).entry(.editResend) == nil)
  }

  @Test("Edit and resend brings back the words and the files, not the pictures")
  func editDraft() {
    #expect(MessageMenu.editResendDraft(of: Self.turn("u1", "summarise this")) == "summarise this")
    #expect(
      MessageMenu.editResendDraft(
        of: Self.turn("u1", "summarise this", attachments: ["@file:/srv/a.pdf", "@image:photo.png", "@file:/srv/b.csv"]))
        == "summarise this\n@file:/srv/a.pdf @file:/srv/b.csv")
    #expect(MessageMenu.editResendDraft(of: Self.turn("u1", "  ")) == nil)
    #expect(MessageMenu.editResendDraft(of: Self.reply("a1", "not the reader's")) == nil)
  }

  // MARK: What waits, and what is left out

  @Test("while a turn runs Regenerate and Edit and resend are shown but cannot be chosen")
  func turnRunning() {
    var context = live
    context.turnActive = true

    let reply = MessageMenu.menu(for: Self.reply("a1", "words"), context: context)
    #expect(reply.entry(.regenerate)?.enabled == false)
    #expect(reply.entry(.copyText)?.enabled == true)
    #expect(reply.entry(.branch)?.enabled == true, "forking starts nothing on the session")

    let own = MessageMenu.menu(for: Self.turn("u1", "words"), context: context)
    #expect(own.entry(.editResend)?.enabled == false)
  }

  @Test("while a request has the composer nothing that sends, types or forks can be chosen (HERM-251)")
  func requestBlocks() {
    var context = live
    context.blocked = true

    let reply = MessageMenu.menu(for: Self.reply("a1", "words"), context: context)
    #expect(reply.entry(.regenerate)?.enabled == false)
    #expect(reply.entry(.branch)?.enabled == false)
    #expect(reply.entry(.copyText)?.enabled == true, "copying touches nothing")

    let own = MessageMenu.menu(for: Self.turn("u1", "words"), context: context)
    #expect(own.entry(.editResend)?.enabled == false)
    #expect(own.entry(.branch)?.enabled == false)
  }

  @Test("a transcript that only reads offers the copies")
  func readOnly() {
    let menu = MessageMenu.menu(for: Self.reply("a1", "**x**"), context: .readOnly)
    #expect(menu.entries.map(\.action) == [.copyText, .copyMarkdown])
    #expect(MessageMenu.menu(for: Self.turn("u1", "hi"), context: .readOnly).entries.map(\.action) == [.copyText])
  }

  @Test("rows that are neither a person's turn nor the bot's words have no menu")
  func otherRows() {
    let status = TranscriptItem.status(StatusItem(base: Self.base("s1"), statusKind: "model", text: "model changed"))
    #expect(MessageMenu.menu(for: status, context: live).isEmpty)
    #expect(MessageMenu.copyText(of: status) == nil)
    #expect(MessageMenu.words(of: status) == nil)
  }
}
