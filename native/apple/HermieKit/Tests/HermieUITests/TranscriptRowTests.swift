import HermieMarkdown
import HermieTranscript
import Testing

@testable import HermieUI

private func base(_ id: String, version: Int = 1) -> ItemBase {
  ItemBase(id: id, seq: 0, origin: .history, version: version)
}

private func dm(_ id: String, outbound: Bool = true, handle: String = "writer") -> VisibleItem {
  let item: TranscriptItem =
    outbound
    ? .botDmOut(
      BotDmOutItem(
        base: base(id), toolID: id, target: handle, targetHandle: handle, message: "hi",
        dispatch: BotDmDispatch(status: .queued)))
    : .botDmIn(BotDmInItem(base: base(id), senderName: handle, senderHandle: handle, text: "hi"))
  return VisibleItem(item: item, presentation: .collapsed)
}

private func user(_ id: String, author: String?, version: Int = 1) -> VisibleItem {
  VisibleItem(
    item: .user(UserItem(base: base(id, version: version), text: "hello", author: author.map { MessageAuthor(id: $0) })),
    presentation: .full)
}

private func assistant(_ id: String, _ text: String, version: Int = 1) -> VisibleItem {
  VisibleItem(
    item: .assistant(AssistantItem(base: base(id, version: version), text: text, streaming: true, interim: false)),
    presentation: .full)
}

@MainActor
@Suite struct TranscriptRowBuilderTests {
  @Test func moreThanThreeBotToBotRowsRollUp() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [user("u1", author: nil), dm("d1"), dm("d2"), dm("d3", outbound: false), dm("d4")])
    #expect(rows.map(\.id) == ["u1", "rollup:d1"])
    guard case .botDmRollup(let members) = rows[1].content else {
      Issue.record("expected a roll-up")
      return
    }
    #expect(members.map(\.item.id) == ["d1", "d2", "d3", "d4"])
  }

  @Test func threeBotToBotRowsStayRows() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [dm("d1"), dm("d2"), dm("d3"), user("u1", author: nil)])
    #expect(rows.map(\.id) == ["d1", "d2", "d3", "u1"])
  }

  @Test func aHiddenPlaceholderDoesNotBreakARun() {
    var builder = TranscriptRowBuilder()
    let hidden = VisibleItem(
      item: .user(UserItem(base: base("h"), text: "", unknownAuthor: true)), presentation: .hiddenPlaceholder)
    let rows = builder.rows(for: [dm("d1"), dm("d2"), hidden, dm("d3"), dm("d4")])
    #expect(rows.map(\.id) == ["rollup:d1"])
  }

  @Test func anAuthorRunShowsItsNameOnce() {
    var builder = TranscriptRowBuilder(sharedChat: true)
    let rows = builder.rows(for: [
      user("u1", author: "a"), user("u2", author: "a"), user("u3", author: "b"), assistant("x", "ok"),
      user("u4", author: "b")
    ])
    #expect(rows.map(\.opensAuthorRun) == [true, false, true, true, true])
  }

  @Test func anUnchangedItemKeepsItsDocumentAndAStreamedOneParsesOnlyItsTail() {
    var builder = TranscriptRowBuilder()
    var text = (0..<40).map { "Paragraph \($0) with **bold** text." }.joined(separator: "\n\n")
    let first = builder.rows(for: [assistant("a", text), assistant("b", "settled")])
    let parsedAtStart = first[0].markdown?.parseCount ?? 0
    #expect(parsedAtStart >= 40)

    var parsed = parsedAtStart
    for step in 0..<50 {
      text += " more"
      let rows = builder.rows(for: [assistant("a", text, version: 2 + step), assistant("b", "settled")])
      #expect(rows[0].markdown?.text == text)
      // One delta re-parses the open tail (at most the last two slices), never
      // the forty settled paragraphs.
      let now = rows[0].markdown?.parseCount ?? 0
      #expect(now - parsed <= 2)
      parsed = now
      #expect(rows[1].markdown?.parseCount == 1, "an unchanged row was parsed again")
    }
    // The same version again: nothing is parsed.
    let again = builder.rows(for: [assistant("a", text, version: 51), assistant("b", "settled")])
    #expect(again[0].markdown?.parseCount == parsed)
    #expect(builder.documentCount == 2)
  }

  @Test func rowsAreEqualUntilTheirItemChanges() {
    let a = TranscriptRow(assistant("a", "one"))
    #expect(a == TranscriptRow(assistant("a", "one")))
    #expect(a != TranscriptRow(assistant("a", "one two", version: 2)))
    var collapsed = assistant("a", "one")
    collapsed.presentation = .collapsed
    #expect(a != TranscriptRow(collapsed))
    // Without its thought (thinking hidden) the item differs at the same version.
    var thoughtful = assistant("a", "one")
    thoughtful.item.updateAssistant { $0.reasoning = "hmm" }
    #expect(a != TranscriptRow(thoughtful))
  }
}

@MainActor
@Suite struct ItemFormatTests {
  @Test func durationsReadAsTheExpoAppWritesThem() {
    #expect(ItemFormat.duration(nil) == "")
    #expect(ItemFormat.duration(4.24) == "4.2s")
    #expect(ItemFormat.duration(4) == "4s")
    #expect(ItemFormat.duration(12.4) == "12s")
    #expect(ItemFormat.duration(65) == "1m 05s")
    #expect(ItemFormat.duration(3840) == "1h 04m")
  }

  @Test func countsAbbreviate() {
    #expect(ItemFormat.count(912) == "912")
    #expect(ItemFormat.count(1234) == "1.2k")
    #expect(ItemFormat.count(3_400_000) == "3.4M")
  }

  @Test func initialsAndTintsMatchTheTypeScript() {
    #expect(ItemFormat.initial("  robin") == "R")
    #expect(ItemFormat.initial("") == "?")
    // `tintIndex` in chat-ui/format.ts, evaluated for these keys.
    #expect(ItemFormat.tintIndex("telegram:42", buckets: 4) == 3)
    #expect(ItemFormat.tintIndex("telegram:7", buckets: 4) == 2)
    #expect(ItemFormat.tintIndex("😀x", buckets: 7) == 0)
    #expect(ItemFormat.tintIndex("", buckets: 4) == 0)
  }

  @Test func attachmentNamesComeOffTheReference() {
    #expect(ItemFormat.attachmentName("@file:/tmp/a/report.pdf") == "report.pdf")
    #expect(ItemFormat.attachmentName("@image:\"C:\\photos\\cat.jpg\"") == "cat.jpg")
    #expect(ItemFormat.attachmentName("@file:`notes.md`") == "notes.md")
  }

  @Test func toolFamiliesFollowTheRenderClassRules() {
    #expect(ToolFamily(name: "mcp__github__list") == .mcp)
    #expect(ToolFamily(name: "write_file") == .diff)
    #expect(ToolFamily(name: "run_command") == .terminal)
    #expect(ToolFamily(name: "read_file") == .fileRead)
    #expect(ToolFamily(name: "web_search") == .search)
    #expect(ToolFamily(name: "browser_navigate") == .browser)
    #expect(ToolFamily(name: "calculator") == .other)
  }
}
