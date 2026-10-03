import CoreGraphics
import Foundation
import HermieProtocol
import HermieTranscript
import Testing

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

@testable import HermieUI

private func base(_ id: String, ts: Double? = nil, version: Int = 1) -> ItemBase {
  ItemBase(id: id, seq: 0, ts: ts, origin: .history, version: version)
}

private func user(_ id: String, ts: Double? = nil, author: String? = nil) -> VisibleItem {
  VisibleItem(
    item: .user(UserItem(base: base(id, ts: ts), text: "hello", author: author.map { MessageAuthor(id: $0) })),
    presentation: .full)
}

private func reply(_ id: String, _ text: String = "ok", ts: Double? = nil, streaming: Bool = false) -> VisibleItem {
  VisibleItem(
    item: .assistant(AssistantItem(base: base(id, ts: ts), text: text, streaming: streaming, interim: false)),
    presentation: .full)
}

private func tool(
  _ id: String, name: String = "read_file", summary: String? = nil, presentation: Presentation = .collapsed,
  status: ToolStatus = .complete
) -> VisibleItem {
  VisibleItem(
    item: .tool(
      ToolItem(
        base: base(id), toolID: id, name: name, status: status, resultKnown: true, summary: summary)),
    presentation: presentation)
}

private func status(_ id: String, presentation: Presentation = .full) -> VisibleItem {
  VisibleItem(item: .status(StatusItem(base: base(id), statusKind: "info", text: "Working")), presentation: presentation)
}

/// Messages' grouping, the tool groups and their names, and the bubbles' colours.
@Suite struct ChatBubbleTests {
  // MARK: Grouping

  @Test func consecutiveMessagesFromOneSideGroupAndOnlyTheLastHasTheTail() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [
      user("u1", ts: 1000), user("u2", ts: 1010), reply("a1", ts: 1020), reply("a2", ts: 1030), user("u3", ts: 1040)
    ])
    let layout = rows.map { $0.bubble.map { "\($0.opensGroup ? "o" : "-")\($0.closesGroup ? "c" : "-")" } ?? "nil" }
    #expect(layout == ["o-", "-c", "o-", "-c", "oc"])
    #expect(rows.map { $0.bubble?.sender } == [.person(authorID: nil), .person(authorID: nil), .bot, .bot, .person(authorID: nil)])
  }

  @Test func aVisibleRowBetweenTwoMessagesEndsTheGroupAndAHiddenOneDoesNot() {
    var builder = TranscriptRowBuilder()
    let hidden = VisibleItem(
      item: .status(StatusItem(base: base("s"), statusKind: "info", text: "x")), presentation: .hiddenPlaceholder)
    let rows = builder.rows(for: [reply("a1"), tool("t1"), reply("a2"), hidden, reply("a3")])
    let bubbles = rows.compactMap(\.bubble)
    #expect(bubbles.count == 3)
    #expect(bubbles[0].closesGroup, "the tool group ends the first group")
    #expect(bubbles[1].opensGroup && !bubbles[1].closesGroup, "the hidden row does not part a2 and a3")
    #expect(!bubbles[2].opensGroup && bubbles[2].closesGroup)
  }

  @Test func theTimeGoesAboveTheFirstMessageAndAfterAnHoursPause() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [user("u1", ts: 1000), reply("a1", ts: 1100), user("u2", ts: 1100 + 3600), reply("a2", ts: 8000)])
    #expect(rows.map(\.bubble?.timeHeader) == [1000, nil, 4700, nil])
    // The pause also ends a group from one sender.
    let same = builder.rows(for: [reply("x1", ts: 0 + 1), reply("x2", ts: 1 + 3600)])
    #expect(same.map(\.bubble?.closesGroup) == [true, true])
  }

  @Test func aRowWhoseNeighbourChangedIsDrawnAgain() {
    var builder = TranscriptRowBuilder()
    let before = builder.rows(for: [reply("a1")])
    let after = builder.rows(for: [reply("a1"), reply("a2")])
    #expect(before[0] != after[0], "a1 lost its tail: the row must not compare equal")
  }

  @Test func aTypingReplyIsABubbleAndAnEmptySettledOneIsNot() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [reply("typing", "", streaming: true), reply("empty", "")])
    #expect(rows[0].bubble != nil)
    #expect(rows[1].bubble == nil)
  }

  // MARK: Tool groups

  @Test func theCallsBetweenTwoMessagesAreOneGroupNamedForItsFirstCall() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [user("u1"), tool("t1"), tool("t2"), tool("t3"), reply("a1"), tool("t4")])
    #expect(rows.map(\.id) == ["u1", "tools:t1", "a1", "tools:t4"])
    guard case .toolGroup(let members) = rows[1].content else {
      Issue.record("expected a tool group")
      return
    }
    #expect(members.map(\.item.id) == ["t1", "t2", "t3"])
  }

  @Test func aGroupKeepsItsIdAndItsMembersWhenPresentationsChange() {
    // When a turn ends the selectors hide rows; a group must not take in its neighbours then, or a
    // dozen row ids vanish above the reader at once.
    var builder = TranscriptRowBuilder()
    let live = builder.rows(for: [tool("t1"), status("s1"), tool("t2"), tool("t3")])
    let settled = builder.rows(for: [
      tool("t1", presentation: .hiddenPlaceholder), status("s1", presentation: .hiddenPlaceholder),
      tool("t2", presentation: .hiddenPlaceholder), tool("t3")
    ])
    #expect(live.map(\.id) == ["tools:t1", "s1", "tools:t2"])
    #expect(settled.map(\.id) == live.map(\.id))
    #expect(TranscriptRowBuilder.drawsNothing(settled[0]))
    #expect(!TranscriptRowBuilder.drawsNothing(settled[2]))
  }

  @Test func quietsHiddenRunningToolTakesNoRoomAndDoesNotPartTheBubbles() {
    // At `quiet` the selectors keep only the running tool, as a hidden placeholder.
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [
      reply("a1"), tool("t1", presentation: .hiddenPlaceholder, status: .running), reply("a2", streaming: true)
    ])
    #expect(rows.map(\.id) == ["a1", "tools:t1", "a2"])
    #expect(TranscriptRowBuilder.drawsNothing(rows[1]))
    #expect(TranscriptItemView.gap(above: rows[1]) == 0)
    #expect(rows[0].bubble?.closesGroup == false, "a1 and a2 are one group across the hidden row")
    #expect(rows[2].bubble?.opensGroup == false)
    #expect(TranscriptItemView.gap(above: rows[2]) == 0)
  }

  @Test func theChatsGapsAreSmallInsideAGroupLargeBetweenGroupsAndNoneForARowThatDrawsNothing() {
    var builder = TranscriptRowBuilder()
    let gaps = TranscriptItemView.Gaps.chat
    let rows = builder.rows(for: [
      reply("a1", ts: 1000), reply("a2", ts: 1010), tool("t1", presentation: .hiddenPlaceholder, status: .running),
      reply("a3", ts: 1020), user("u1", ts: 1030), tool("t2")
    ])
    #expect(rows.map(\.id) == ["a1", "a2", "tools:t1", "a3", "u1", "tools:t2"])

    #expect(TranscriptItemView.gap(above: rows[0], gaps: gaps) == ChatSpacing.betweenGroups, "a group opens")
    #expect(TranscriptItemView.gap(above: rows[1], gaps: gaps) == ChatSpacing.withinGroup, "inside the group")
    #expect(TranscriptItemView.gap(above: rows[2], gaps: gaps) == 0, "draws nothing, takes nothing")
    #expect(TranscriptItemView.gap(above: rows[3], gaps: gaps) == ChatSpacing.withinGroup, "the hidden row does not part the group")
    #expect(TranscriptItemView.gap(above: rows[4], gaps: gaps) == ChatSpacing.betweenGroups, "the sender changes")
    #expect(TranscriptItemView.gap(above: rows[5], gaps: gaps) == ChatSpacing.betweenGroups, "a tool group stands apart")
  }

  @Test func aSilentToolThatWorkedDrawsNothingAndOneThatFailedDoes() {
    let worked = [tool("t1", name: "todo")]
    let failed = [tool("t1", name: "todo", status: .error)]
    #expect(TranscriptRowBuilder.drawnTools(worked).isEmpty)
    #expect(TranscriptRowBuilder.drawnTools(failed).count == 1)
  }

  // MARK: Tool names

  @Test func toolsAreNamedForWhatTheyDid() {
    func title(_ name: String, summary: String? = nil, status: ToolStatus = .complete) -> String {
      guard case .tool(let item) = tool("t", name: name, summary: summary, status: status).item else { return "" }
      return ToolLabel.title(item)
    }
    #expect(title("tool_call", summary: "Moneybird · list ledger accounts") == "Moneybird · list ledger accounts")
    #expect(title("execute_code", summary: "import json, collections") == NativeStrings.Tool.ranCode)
    #expect(title("execute_code", status: .running) == NativeStrings.Tool.runningCode)
    #expect(title("mcp__moneybird__list_ledger_accounts") == "Moneybird · list ledger accounts")
    #expect(title("terminal") == NativeStrings.Tool.ranCommand)
    #expect(title("read_file") == NativeStrings.Tool.readFile)
    #expect(title("web_search") == NativeStrings.Tool.searchedWeb)
    #expect(title("send_message") == "Send message")
    #expect(title("tool_call") == NativeStrings.Tool.usedTool)
  }

  @Test func codeNeverShowsUnderTheTitle() {
    guard case .tool(let code) = tool("t", name: "execute_code", summary: "import re\ncnt = 1").item,
      case .tool(let dispatch) = tool("u", name: "tool_call", summary: "Moneybird · list").item,
      case .tool(let command) = tool("v", name: "terminal", summary: "ls -la").item
    else { return }
    #expect(ToolLabel.subtitle(code) == nil)
    #expect(ToolLabel.subtitle(dispatch) == "tool_call", "no arguments: the dispatcher's own name")
    #expect(ToolLabel.subtitle(command) == "ls -la")
  }

  @Test func aDispatcherCallNamesTheToolItRanUnderItsTitle() {
    // The title is the call's summary, which the model shapes; the line under it is what the
    // gateway dispatched, so a title cannot pass one call off as another.
    let item = ToolItem(
      base: base("t"), toolID: "t", name: "tool_call",
      args: ["server": .string("moneybird"), "tool": .string("list_ledger_accounts")],
      status: .complete, resultKnown: true, summary: "Moneybird · list ledger accounts")
    #expect(ToolLabel.title(item) == "Moneybird · list ledger accounts")
    #expect(ToolLabel.subtitle(item) == "moneybird · list_ledger_accounts")
  }

  @Test func theFirstMessageGetsItsDateLineOnlyOnceTheWholeHistoryIsLoaded() {
    // Before, a page of history arriving took the line away from the row that had been first and
    // moved the reader's rows by its height.
    var builder = TranscriptRowBuilder()
    let partial = builder.rows(for: [user("u1", ts: 1000), reply("a1", ts: 1100)], historyComplete: false)
    #expect(partial.map(\.bubble?.timeHeader) == [nil, nil])
    let complete = builder.rows(for: [user("u1", ts: 1000), reply("a1", ts: 1100)], historyComplete: true)
    #expect(complete.map(\.bubble?.timeHeader) == [1000, nil])
  }

  @Test func aNewDayGetsADateLineWithoutAPause() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    // 23:50 and 00:10 the next day, twenty minutes apart.
    var rows = [TranscriptRow(user("u1", ts: 86_400 - 600)), TranscriptRow(reply("a1", ts: 86_400 + 600))]
    TranscriptRowBuilder.layOutBubbles(&rows, historyComplete: false, calendar: calendar)
    #expect(rows.map(\.bubble?.timeHeader) == [nil, 86_400 + 600])
  }

  @Test @MainActor func aProbeOfNoWidthGetsTheBubblesOwnSizeNotAWordALine() throws {
    // A width of 0 answered with the height at no width: a one-line bubble hundreds of points tall.
    #if os(macOS)
      let host = NSHostingController(
        rootView: BubbleColumn(side: .outgoing, width: .text) {
          Text("Oke nu wil ik dat als ik klik op download de checklist, dat die kaart omdraait")
        })
      let probed = host.sizeThatFits(in: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
      let laidOut = host.sizeThatFits(in: CGSize(width: 1200, height: CGFloat.greatestFiniteMagnitude))
      #expect(probed.height <= laidOut.height * 3, "probe \(probed), laid out \(laidOut)")
    #endif
  }

  @Test func aGroupSaysHowManyStepsAndWhatTheyDid() {
    let items = ["tool_call", "execute_code", "execute_code"].enumerated().compactMap { index, name -> ToolItem? in
      guard case .tool(let item) = tool("t\(index)", name: name, summary: index == 0 ? "Moneybird · list" : nil).item
      else { return nil }
      return item
    }
    #expect(ToolGroupView.summary(items) == "Moneybird · list, \(NativeStrings.Tool.ranCode)")
    #expect(NativeStrings.Tool.steps(5).contains("5"))
  }

  // MARK: Bubble widths and colours

  @Test func aBubbleIsAtMostThreeQuartersOfTheColumnAndNeverWiderThanItsCap() {
    #expect(BubbleWidth.text.cap(400) == 300)
    #expect(BubbleWidth.text.cap(1600) == 560)
    #expect(BubbleWidth.wide.cap(400) == 376)
    #expect(BubbleWidth.text.cap(-10) == 0)
  }

  @Test func whiteOnTheOwnersBlueAndTextOnTheBotsGreyMeetTheContrastBar() {
    let blue = (0x17, 0x72, 0xD3)
    #expect(Self.ratio(blue, (0xFF, 0xFF, 0xFF)) >= 4.5)
    let light = BubblePalette.incomingLight
    let dark = BubblePalette.incomingDark
    // The system's label colour: black in light, white in dark.
    #expect(Self.ratio((light.red, light.green, light.blue), (0, 0, 0)) >= 7)
    #expect(Self.ratio((dark.red, dark.green, dark.blue), (0xFF, 0xFF, 0xFF)) >= 7)
  }

  @Test func theTailReachesPastTheBubbleOnItsOwnSideOnly() {
    let rect = CGRect(x: 0, y: 0, width: 200, height: 40)
    let outgoing = BubbleShape(side: .outgoing, tail: true).path(in: rect).boundingRect
    let incoming = BubbleShape(side: .incoming, tail: true).path(in: rect).boundingRect
    let plain = BubbleShape(side: .outgoing, tail: false).path(in: rect).boundingRect
    #expect(outgoing.maxX > rect.maxX && outgoing.minX >= rect.minX - 0.5)
    #expect(incoming.minX < rect.minX && incoming.maxX <= rect.maxX + 0.5)
    #expect(plain.insetBy(dx: -0.5, dy: -0.5).contains(rect.insetBy(dx: 1, dy: 1)))
    // The tail is filled, not cut out of the body: its tip is inside the path.
    #expect(BubbleShape(side: .incoming, tail: true).path(in: rect).contains(CGPoint(x: -2, y: 39)))
    #expect(BubbleShape(side: .outgoing, tail: true).path(in: rect).contains(CGPoint(x: 202, y: 39)))
  }

  static func ratio(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Double {
    func luminance(_ c: (Int, Int, Int)) -> Double {
      func channel(_ v: Int) -> Double {
        let s = Double(v) / 255
        return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(c.0) + 0.7152 * channel(c.1) + 0.0722 * channel(c.2)
    }
    let la = luminance(a)
    let lb = luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }
}
