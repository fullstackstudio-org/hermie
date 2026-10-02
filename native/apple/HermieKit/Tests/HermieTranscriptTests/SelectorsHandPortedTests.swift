import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

// The selector calls the golden corpus could not record, ported by hand from the
// TypeScript tests with the same names (`contract/README.md`, "Skipped calls"):
//
// - `exportTranscript` with a `formatTime` or `resolveSenderName` callback
//   (`export.test.ts`, 18 calls): every test of that file that passes one;
// - `previewFromChat` / `chatRowPreview` with a `resolveSenderName` callback
//   (`preview.test.ts`, 5 + 1 calls).
//
// The two `contextUsageOf` calls with `NaN` / `Infinity` are already ported in
// `TranscriptModelTests.swift` ("refuses a figure that is not a finite count").

// MARK: - Fixtures

private final class SeqCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  func next() -> Int {
    lock.lock()
    defer { lock.unlock() }
    value += 1
    return value
  }
}

private let seqCounter = SeqCounter()

/// `base(ts)` in `export.test.ts`.
private func base(_ ts: Double? = nil) -> ItemBase {
  let seq = seqCounter.next()
  return ItemBase(id: "i\(seq)", seq: seq, ts: ts, origin: .history, version: 1)
}

/// `new Date(seconds * 1000).toISOString().slice(11, 16)`: `HH:MM` in UTC, no
/// locale and no time zone involved.
private func clock(_ seconds: Double) -> String {
  let total = Int(seconds.rounded(.down))
  let minutes = ((total / 60) % 60 + 60) % 60
  let hours = ((total / 3600) % 24 + 24) % 24
  return String(format: "%02d:%02d", hours, minutes)
}

private func options(
  botName: String = "Researcher",
  exportedAt: Double? = nil,
  groupChat: Bool? = nil,
  ownAuthorID: String? = nil,
  resolveSenderName: ((MessageAuthor) -> String)? = nil
) -> TranscriptExportOptions {
  TranscriptExportOptions(
    botName: botName,
    selfName: "You",
    formatTime: clock,
    exportedAt: exportedAt,
    groupChat: groupChat,
    ownAuthorID: ownAuthorID,
    resolveSenderName: resolveSenderName
  )
}

private func user(_ ts: Double, _ text: String, attachments: [String]? = nil, author: MessageAuthor? = nil) -> TranscriptItem {
  .user(UserItem(base: base(ts), text: text, attachments: attachments, author: author))
}

private func assistant(_ ts: Double, _ text: String, error: AssistantFailure? = nil) -> TranscriptItem {
  .assistant(AssistantItem(base: base(ts), text: text, streaming: false, interim: false, error: error))
}

/// Every non-overlapping match of a literal, like `markdown.match(/…/gu)`.
private func occurrences(of needle: String, in haystack: String) -> Int {
  haystack.components(separatedBy: needle).count - 1
}

/// A stand-in for `fallbackSenderName` (chat-ui/format.ts): the engine cannot
/// import the chat kit, so the resolver is always the caller's.
private func resolveSenderName(_ author: MessageAuthor) -> String { author.name ?? author.id }

private let me = "authentik:me"
private let writer = MessageAuthor(id: "authentik:writer", name: "Robin")
private let researcherAuthor = MessageAuthor(id: "authentik:researcher-person", name: "Sam")

// MARK: - export.test.ts

@Suite("serializing a conversation") struct ExportSerializingTests {
  @Test("writes the two speakers, in order, in both formats")
  func twoSpeakers() {
    let items = [user(60, "Introduce yourself."), assistant(120, "# Hello\n\nI am **researcher**.")]

    let exported = exportTranscript(items, options())

    #expect(
      exported.markdown
        == [
          "# Researcher",
          "",
          "**You** · 00:01",
          "",
          "Introduce yourself.",
          "",
          "**Researcher** · 00:02",
          "",
          "# Hello",
          "",
          "I am **researcher**.",
          ""
        ].joined(separator: "\n")
    )
    #expect(exported.text.contains("00:01 · You:"))
    #expect(exported.text.contains("00:02 · Researcher:"))
    // The reply's own markdown survives into the .txt file: those are the
    // author's characters, and an export must not edit what it preserves.
    #expect(exported.text.contains("I am **researcher**."))
  }

  @Test("writes the rows that are about the conversation as asides")
  func asides() {
    let items: [TranscriptItem] = [
      .tool(ToolItem(base: base(60), toolID: "t1", name: "terminal", context: "ls -la", status: .complete, resultKnown: true)),
      .notice(NoticeItem(base: base(70), noticeKind: .modelSwitch, title: "Switched model", body: "to example-large")),
      .approval(
        ApprovalItem(
          base: base(80),
          requestID: "srq-1",
          approvalID: "a1",
          command: "rm -rf ./build",
          choices: ["allow", "deny"],
          state: .answered,
          answer: "allow"
        )
      )
    ]

    let exported = exportTranscript(items, options())

    #expect(exported.markdown.contains("> 00:01 · terminal: ls -la"))
    #expect(exported.markdown.contains("> 00:01 · Switched model — to example-large"))
    #expect(exported.markdown.contains("> 00:01 · Permission request — rm -rf ./build (answered allow)"))
    #expect(exported.text.contains("  · 00:01 · terminal: ls -la"))
    // An aside is never attributed to a speaker in either format.
    #expect(!exported.markdown.contains("**terminal**"))
  }

  @Test("carries a turn’s attachments by the reference the turn holds")
  func attachments() {
    let items = [user(60, "Read this.", attachments: ["@file:/root/notes.md"])]

    #expect(exportTranscript(items, options()).markdown.contains("[@file:/root/notes.md]"))
  }

  @Test("keeps a failed turn for its error and drops one that said nothing at all")
  func failedTurn() {
    let items = [
      assistant(60, "", error: AssistantFailure(message: "the worker died", partial: false)),
      assistant(70, "   ")
    ]

    let markdown = exportTranscript(items, options()).markdown

    #expect(markdown.contains("(the worker died)"))
    #expect(occurrences(of: "**Researcher**", in: markdown) == 1)
  }

  @Test("drops the rows that are gone from the screen a second later")
  func transientRows() {
    let items: [TranscriptItem] = [
      .status(StatusItem(base: base(60), statusKind: "compaction", text: "Compacting…")),
      user(70, "Still here.")
    ]

    let markdown = exportTranscript(items, options()).markdown

    // A file of transient one-liners is a file of things that are no longer
    // true.
    #expect(!markdown.contains("Compacting"))
    #expect(markdown.contains("Still here."))
  }

  @Test("exports exactly the items it was handed, hidden rows included or not")
  func exactlyTheItems() {
    // The contract this package cannot check for itself, stated here so the
    // caller cannot quietly change it: the input is the VISIBLE list, so a chat
    // filtered to Quiet exports the quiet conversation.
    let visible = [user(60, "Only me.")]

    #expect(exportTranscript(visible, options()).markdown.contains("Only me."))
    #expect(exportTranscript([], options()).markdown == "# Researcher\n")
  }

  @Test("names the bot-to-bot lines without making either bot the speaker")
  func botToBotLines() {
    let items: [TranscriptItem] = [
      .botDmOut(
        BotDmOutItem(
          base: base(60),
          toolID: "d1",
          target: "@writer",
          targetHandle: "writer",
          message: "Draft the summary.",
          dispatch: BotDmDispatch(status: .queued),
          reply: BotDmReply(text: "Done.")
        )
      ),
      .botDmIn(BotDmInItem(base: base(70), senderName: "Writer", senderHandle: "writer", text: "Anything else?"))
    ]

    let markdown = exportTranscript(items, options()).markdown

    #expect(markdown.contains("> 00:01 · Message to @writer: Draft the summary."))
    #expect(markdown.contains("> Reply: Done."))
    // An inbound message IS speech, and it is attributed to whoever sent it.
    #expect(markdown.contains("**Writer**"))
  }

  @Test("heads the file with the bot and, when it knows, when it was taken")
  func header() {
    let exported = exportTranscript([], options(exportedAt: 3_600))

    #expect(exported.markdown.contains("_Exported 01:00_"))
    #expect(exported.text.contains("Exported 01:00"))
  }
}

@Suite("who a `user` row is exported under (HERM-83, Task 5)") struct ExportSenderTests {
  private func groupOptions(groupChat: Bool = true) -> TranscriptExportOptions {
    options(groupChat: groupChat, ownAuthorID: me, resolveSenderName: resolveSenderName)
  }

  @Test("carries both names when two people share the group chat")
  func bothNames() {
    let items = [user(60, "Draft the summary.", author: writer), user(120, "Already on it.", author: researcherAuthor)]

    let exported = exportTranscript(items, groupOptions())

    #expect(exported.markdown.contains("**Robin**"))
    #expect(exported.markdown.contains("Draft the summary."))
    #expect(exported.markdown.contains("**Sam**"))
    #expect(exported.markdown.contains("Already on it."))
    #expect(exported.text.contains("Robin:"))
    #expect(exported.text.contains("Sam:"))
  }

  @Test("keeps the reader’s own attributed row under `selfName`")
  func ownRow() {
    let items = [user(60, "ship it", author: MessageAuthor(id: me, name: "Me"))]

    #expect(exportTranscript(items, groupOptions()).markdown.contains("**You**"))
  }

  @Test("keeps an unattributed row under `selfName`, even in the group chat")
  func unattributed() {
    let items = [user(60, "from before the stamp existed")]

    #expect(exportTranscript(items, groupOptions()).markdown.contains("**You**"))
  }

  @Test("never names anybody outside the group chat, even with everything else known")
  func outsideTheGroupChat() {
    let items = [user(60, "Draft the summary.", author: writer)]

    let markdown = exportTranscript(items, groupOptions(groupChat: false)).markdown

    #expect(!markdown.contains("**Robin**"))
    #expect(markdown.contains("**You**"))
  }

  @Test("leaves every row under `selfName` when the caller has no resolver to name one with")
  func noResolver() {
    let items = [user(60, "Draft the summary.", author: writer)]

    let markdown = exportTranscript(items, options(groupChat: true, ownAuthorID: me)).markdown

    #expect(!markdown.contains("**Robin**"))
    #expect(markdown.contains("**You**"))
  }

  @Test("exports exactly as before when the caller passes none of the new options")
  func noNewOptions() {
    let items = [user(60, "Draft the summary.", author: writer)]

    #expect(exportTranscript(items, options()).markdown.contains("**You**"))
  }
}

/*
  A name is somebody else's text, and in the `.md` file it sits inside
  `**…**`. Unescaped, a `*` closes the bold early, a `[x](y)` becomes a link,
  and a `<b>` becomes markup in any renderer that allows HTML. The `.txt` file
  is plain text and keeps the name exactly as shown in the app.
*/
@Suite("a sender name in the Markdown export") struct ExportMarkdownNameTests {
  private let groupOptions = options(groupChat: true, ownAuthorID: me, resolveSenderName: resolveSenderName)

  @Test("escapes Markdown in a person’s name")
  func personName() {
    let items = [
      user(60, "hi", author: MessageAuthor(id: "authentik:x", name: "*Robin_[site](https://example.test)` <b>#1"))
    ]

    let exported = exportTranscript(items, groupOptions)

    #expect(exported.markdown.contains(##"**\*Robin\_\[site\]\(https://example.test\)\` \<b\>\#1**"##))
    #expect(exported.text.contains("*Robin_[site](https://example.test)` <b>#1:"))
  }

  @Test("escapes Markdown in a bot’s name too")
  func botName() {
    let items = [assistant(60, "done")]

    let markdown = exportTranscript(items, options(botName: "ops_*bot*")).markdown

    #expect(markdown.contains(#"**ops\_\*bot\***"#))
  }

  @Test("leaves an ordinary name exactly as it was")
  func ordinaryName() {
    let items = [user(60, "hi", author: MessageAuthor(id: "authentik:x", name: "Robin Vale"))]

    #expect(exportTranscript(items, groupOptions).markdown.contains("**Robin Vale**"))
  }
}

// MARK: - preview.test.ts

/// `chatOf([authoredRowOf(author)])`: what `reconcile(rowsToItems(…))` makes of
/// one authored `user` row, built directly (the history port is another task's).
private func chatOf(_ items: [TranscriptItem]) -> ChatState {
  var state = createChatState("researcher", "stored-1", "resolved-1")
  for item in items {
    state.items[item.id] = item
    state.order.append(item.id)
  }
  return state
}

private func authoredRowOf(_ author: MessageAuthor?) -> ChatState {
  chatOf([.user(UserItem(base: ItemBase(id: "r:1", seq: 0, rowID: 1, origin: .history, version: 0), text: "draft is ready", author: author))])
}

@Suite("who a group-chat row’s preview leads with (HERM-83, Task 5)") struct PreviewSenderTests {
  private let groupOptions = ChatPreviewOptions(groupChat: true, ownAuthorID: me, resolveSenderName: resolveSenderName)

  @Test("leads with the resolved name for somebody else’s row")
  func leadsWithTheName() {
    #expect(
      previewFromChat(authoredRowOf(writer), groupOptions)
        == ChatPreview(text: "draft is ready", senderName: "Robin", system: false)
    )
  }

  @Test("never names the reader’s own attributed row")
  func ownRow() {
    #expect(previewFromChat(authoredRowOf(MessageAuthor(id: me, name: "Me")), groupOptions)?.senderName == nil)
  }

  @Test("never names anybody outside the group chat, even with everything else known")
  func outsideTheGroupChat() {
    let options = ChatPreviewOptions(groupChat: false, ownAuthorID: me, resolveSenderName: resolveSenderName)
    #expect(previewFromChat(authoredRowOf(writer), options)?.senderName == nil)
  }

  @Test("never names anybody before the reader’s own identity is known")
  func identityUnknown() {
    let options = ChatPreviewOptions(groupChat: true, resolveSenderName: resolveSenderName)
    #expect(previewFromChat(authoredRowOf(writer), options)?.senderName == nil)
  }

  @Test("never names an unattributed row")
  func unattributed() {
    let chat = chatOf([.user(UserItem(base: ItemBase(id: "r:1", seq: 0, rowID: 1, origin: .history, version: 0), text: "no stamp on this one"))])
    #expect(previewFromChat(chat, groupOptions)?.senderName == nil)
  }

  @Test("threads the same options through `chatRowPreview`")
  func chatRowPreviewThreadsOptions() {
    #expect(chatRowPreview(authoredRowOf(writer), "", groupOptions)?.senderName == "Robin")
  }

  /// Not in the TypeScript: a resolver that answers an empty string names nobody
  /// (`resolveSenderName(author) || undefined`).
  @Test func anEmptyResolvedNameIsNoName() {
    let options = ChatPreviewOptions(groupChat: true, ownAuthorID: me, resolveSenderName: { _ in "" })
    #expect(previewFromChat(authoredRowOf(writer), options) == ChatPreview(text: "draft is ready", system: false))
  }
}
