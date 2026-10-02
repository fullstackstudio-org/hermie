import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The JavaScript behaviours the views lean on that the corpus does not pin.
@Suite struct SelectorsSupportTests {
  @Test func localeCompareIsTheRootCollation() {
    // Recorded from Node (`'a'.localeCompare('B')` and so on, en-US ICU).
    #expect(JS.localeCompare("a", "A") == -1)
    #expect(JS.localeCompare("a", "B") == -1)
    #expect(JS.localeCompare("researcher:dm-10", "researcher:dm-2") == -1)
    #expect(JS.localeCompare("co-op", "coop") == -1)
    #expect(JS.localeCompare("é", "f") == -1)
    #expect(JS.localeCompare("writer", "writer") == 0)
    #expect(JS.localeCompare("Z", "a") == 1)
  }

  @Test func jsStableSortedKeepsTiesInPlace() {
    let sorted = [(1, "a"), (0, "b"), (1, "c"), (0, "d")].jsStableSorted { $0.0 - $1.0 }
    #expect(sorted.map(\.1) == ["b", "d", "a", "c"])
  }

  @Test func textFingerprintIsFnv1aOverCodeUnits() {
    #expect(textFingerprint("") == "811c9dc5")
    #expect(textFingerprint("a") == "e40c292c")
    // An astral character is two code units, as `charCodeAt` walks it (from Node).
    #expect(textFingerprint("😀") == "cb31c4b8")
  }

  @Test func theActivityCutoffReadsTheClockItIsGiven() {
    var chat = createChatState("researcher", "stored", "stored")
    for (index, ts) in [1_000.0, 2_000.0].enumerated() {
      let id = "dm:\(index)"
      chat.items[id] = .botDmOut(
        BotDmOutItem(
          base: ItemBase(id: id, seq: index, ts: ts, origin: .history, version: 0),
          toolID: "t\(index)",
          target: "@writer",
          targetHandle: "writer",
          message: "errand \(index)",
          dispatch: BotDmDispatch(status: .queued)
        )
      )
      chat.order.append(id)
    }

    // now = 2 500 s; the last 1 000 s keep only the second dispatch.
    let recent = activityEntries([chat], ActivityOptions(sinceSeconds: 1_000), now: 2_500_000)
    #expect(recent.map(\.itemID) == ["dm:1"])
    #expect(activityEntries([chat], ActivityOptions(), now: 2_500_000).count == 2)
  }
}

/// `visibleItems` is the transcript view's hot path. Run in the debug build the
/// tests use; the bound is loose enough for a loaded CI machine and tight enough
/// to catch a quadratic walk.
@Suite(.serialized) struct VisibleItemsBenchmarkTests {
  /// A 5 000-item conversation in the mix a long chat has: turns, replies (some
  /// with a thought), tool calls, notices, statuses and bot-to-bot traffic.
  static func longChat(items count: Int) -> ChatState {
    var state = createChatState("bench", "stored", "stored")
    state.order.reserveCapacity(count)
    for index in 0..<count {
      let id = "i:\(index)"
      let base = ItemBase(id: id, seq: index * seqStep, ts: Double(index), rowID: index, origin: .history, version: 1)
      let item: TranscriptItem
      switch index % 10 {
      case 0, 5:
        item = .user(UserItem(base: base, text: "question \(index)"))
      case 1, 6:
        item = .assistant(
          AssistantItem(
            base: base,
            text: "answer \(index) with a paragraph of text",
            reasoning: index % 20 == 1 ? "a thought" : nil,
            streaming: false,
            interim: false
          )
        )
      case 2, 3, 7:
        item = .tool(ToolItem(base: base, toolID: "t\(index)", name: "read_file", status: index == count - 3 ? .running : .complete, resultKnown: true))
      case 4:
        item = .notice(NoticeItem(base: base, noticeKind: .modelSwitch, title: "Switched model"))
      case 8:
        item = .status(StatusItem(base: base, statusKind: "thinking", text: "Thinking…"))
      default:
        item = .botDmIn(BotDmInItem(base: base, senderName: "Writer", senderHandle: "writer", text: "note \(index)"))
      }
      state.items[id] = item
      state.order.append(id)
    }
    return state
  }

  @Test func visibleItemsIsCheapOnALongChat() {
    let state = Self.longChat(items: 5_000)
    let runs = 20
    var lines: [String] = []

    for level in [Verbosity.quiet, .normal, .verbose] {
      for showThinking in [false, true] {
        let options = VisibilityOptions(level: level, showBotToBot: true, showThinking: showThinking)
        var best = Double.infinity
        var total = 0.0
        var rows = 0
        for _ in 0..<runs {
          let start = ContinuousClock.now
          rows = visibleItems(state, options).count
          let elapsed = GoldenRunner.seconds(since: start)
          best = min(best, elapsed)
          total += elapsed
        }
        lines.append(
          String(
            format: "  %@ thinking=%@: %d rows, best %.2f ms, mean %.2f ms",
            level.rawValue, showThinking ? "on" : "off", rows, best * 1000, total / Double(runs) * 1000
          )
        )
        // Generous: a debug build does one pass of 5 000 items in a few ms.
        #expect(best < 0.25, "visibleItems(\(level), thinking \(showThinking)) took \(best * 1000) ms on 5 000 items")
      }
    }

    var versionBest = Double.infinity
    for _ in 0..<runs {
      let start = ContinuousClock.now
      _ = itemsVersion(state)
      versionBest = min(versionBest, GoldenRunner.seconds(since: start))
    }
    lines.append(String(format: "  itemsVersion: best %.2f ms", versionBest * 1000))
    print("visibleItems on 5 000 items (\(runs) runs each):\n" + lines.joined(separator: "\n"))
  }

  /// Twice the items, about twice the time: linear, not quadratic.
  @Test func visibleItemsIsLinear() {
    func best(_ state: ChatState) -> Double {
      let options = VisibilityOptions(level: .normal, showBotToBot: true, showThinking: false)
      var best = Double.infinity
      for _ in 0..<10 {
        let start = ContinuousClock.now
        _ = visibleItems(state, options)
        best = min(best, GoldenRunner.seconds(since: start))
      }
      return best
    }
    let small = best(Self.longChat(items: 5_000))
    let large = best(Self.longChat(items: 20_000))
    print(String(format: "visibleItems: 5 000 items %.2f ms, 20 000 items %.2f ms (×%.1f)", small * 1000, large * 1000, large / small))
    #expect(large < small * 10, "4× the items took \(large / small)× the time")
  }
}
