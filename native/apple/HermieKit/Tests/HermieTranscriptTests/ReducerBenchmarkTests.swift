import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// What the reducer costs per event on a long chat, through the store's `inout`
/// form, in the debug build the tests use. Each benchmark runs the same events
/// over a 500-item and a 10,000-item transcript: nothing an event does may be
/// proportional to the transcript, so the two must take about as long. The
/// numbers are printed; the bounds are loose enough for a loaded CI machine and
/// tight enough to catch a walk over every item.
@Suite(.serialized) struct ReducerBenchmarkTests {
  static let small = 500
  static let large = 10_000

  /// A settled transcript of `filler` items with a turn running on top of it.
  static func runningTurn(filler: Int) -> ChatState {
    ReducerBranchTests.streamingSetup(deltas: 0, filler: filler).0
  }

  static func event(_ type: String, _ payload: JSONObject, seq: Int) -> GatewayEvent {
    GatewayEvent(json: ["type": .string(type), "payload": .object(payload), "seq": .number(Double(seq))])
  }

  /// The fastest of three runs of `events` over a fresh copy of `state`.
  static func fastest(_ state: ChatState, _ events: [GatewayEvent], publishEvery: Int? = nil) -> Double {
    (0..<3).map { _ in
      var state = state
      var published: ChatState? = nil
      let time = StateCopyBenchmarkTests.seconds {
        for (index, event) in events.enumerated() {
          applyEvent(into: &state, event, 3_000)
          // The store publishes a snapshot to the main actor every so often and
          // the view holds it until the next one: the next write pays for it.
          if let publishEvery, index % publishEvery == 0 {
            published = state
          }
        }
      }
      withExtendedLifetime(published) {}
      return time
    }
    .min()!
  }

  /// `tool.start` then `tool.complete`, 1,000 times.
  static func toolEvents() -> [GatewayEvent] {
    (0..<1_000).flatMap { index -> [GatewayEvent] in
      [
        event("tool.start", ["tool_id": .string("c\(index)"), "name": "terminal", "args": ["command": "ls"]], seq: 2 * index + 2),
        event("tool.complete", ["tool_id": .string("c\(index)"), "result_text": "ok"], seq: 2 * index + 3)
      ]
    }
  }

  /// One child spawned, then 2,000 progress lines from it.
  static func subagentEvents() -> [GatewayEvent] {
    let child: JSONObject = [
      "subagent_id": "child-0", "delegation_id": "del-1", "goal": "Audit deps", "task_index": 0, "task_count": 1,
      "status": "running"
    ]
    return [event("subagent.start", child, seq: 2)]
      + (0..<2_000).map { index in
        var payload = child
        payload["text"] = .string("working on step \(index)")
        return event("subagent.progress", payload, seq: index + 3)
      }
  }

  /// Runs `events` once, for the checks that the benchmark measured real work.
  static func applied(_ events: [GatewayEvent]) -> ChatState {
    var state = runningTurn(filler: small)
    for event in events {
      applyEvent(into: &state, event, 3_000)
    }
    return state
  }

  @Test func toolEventsDoNotScaleWithTheTranscript() {
    let events = Self.toolEvents()
    let after = Self.applied(events)
    #expect(after.byToolID.count == 1_000)
    #expect(after.items["t:c999"]?.asTool?.status == .complete)

    let small = Self.fastest(Self.runningTurn(filler: Self.small), events)
    let large = Self.fastest(Self.runningTurn(filler: Self.large), events)
    print(
      String(
        format: "applyEvent(into:) tool.start + tool.complete ×1,000: %.4f s over %d items, %.4f s over %d items (ratio %.2f)",
        small, Self.small, large, Self.large, large / small
      )
    )
    #expect(large < 2.0, "1,000 tool calls over \(Self.large) items took \(large) s")
    #expect(large / small < 4.0, "a 20× larger transcript multiplied the time by \(large / small)")
  }

  @Test func subagentProgressDoesNotScaleWithTheTranscript() {
    let events = Self.subagentEvents()
    let child = Self.applied(events).subagents["child-0"]
    #expect(child?.stream.count == subagentStreamCap)
    #expect(child?.stream.last?.text == "working on step 1999")

    let small = Self.fastest(Self.runningTurn(filler: Self.small), events)
    let large = Self.fastest(Self.runningTurn(filler: Self.large), events)
    print(
      String(
        format: "applyEvent(into:) subagent.progress ×2,000: %.4f s over %d items, %.4f s over %d items (ratio %.2f)",
        small, Self.small, large, Self.large, large / small
      )
    )
    #expect(large < 2.0, "2,000 progress events over \(Self.large) items took \(large) s")
    #expect(large / small < 4.0, "a 20× larger transcript multiplied the time by \(large / small)")
  }

  /// Streaming while the store publishes a snapshot every 16 deltas. Each publish
  /// costs the next write one copy of `items` (a retain per item) and one copy of
  /// the growing reply, so this one DOES grow with the transcript; it is measured
  /// so a change that makes it worse shows up.
  @Test func streamingWhilePublishingSnapshots() {
    let deltas = 10_000
    let publishEvery = 16
    var results: [(filler: Int, plain: Double, publishing: Double)] = []

    for filler in [Self.small, Self.large] {
      let (state, events) = ReducerBranchTests.streamingSetup(deltas: deltas, filler: filler)
      results.append(
        (filler, Self.fastest(state, events), Self.fastest(state, events, publishEvery: publishEvery))
      )
    }

    for result in results {
      print(
        String(
          format: "applyEvent(into:) message.delta ×%d over %d items: %.4f s, publishing every %d: %.4f s",
          deltas, result.filler, result.plain, publishEvery, result.publishing
        )
      )
    }
    #expect(results.allSatisfy { $0.publishing < 5.0 }, "\(results)")
  }
}
