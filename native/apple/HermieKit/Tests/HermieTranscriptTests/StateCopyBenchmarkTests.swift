import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// Performance guards for the state model, run in the debug build the tests use.
/// They print their numbers; the bounds are loose enough for a loaded CI machine
/// and tight enough to catch a quadratic regression or a pathological decoder.
@Suite(.serialized) struct StateCopyBenchmarkTests {
  static func seconds(_ body: () throws -> Void) rethrows -> Double {
    let start = ContinuousClock.now
    try body()
    return GoldenRunner.seconds(since: start)
  }

  /// A state holding `filler` settled items and one streaming assistant item.
  static func streamingState(filler: Int) -> (ChatState, String) {
    var state = createChatState("bench", "stored", "stored")
    for index in 0..<filler {
      let id = "r:\(index)"
      let base = ItemBase(id: id, seq: index * seqStep, rowID: index, origin: .history, version: 0)
      state.items[id] = .user(UserItem(base: base, text: "message \(index)"))
      state.order.append(id)
      state.byRowID[String(index)] = id
    }
    let id = "a:live"
    state.items[id] = .assistant(
      AssistantItem(
        base: ItemBase(id: id, seq: filler * seqStep, origin: .live, version: 0),
        text: "",
        streaming: true,
        interim: false
      )
    )
    state.order.append(id)
    state.turn.assistantID = id
    return (state, id)
  }

  /// The store's way: one state owned and mutated `inout`.
  static func appendInPlace(deltas: Int, filler: Int) -> (Double, Int) {
    var (state, id) = streamingState(filler: filler)
    let time = seconds {
      for _ in 0..<deltas {
        state.items[id]?.updateAssistant { item in
          item.text += "token · "
          item.version += 1
        }
      }
    }
    return (time, state.items[id]?.asAssistant?.text.utf8.count ?? 0)
  }

  /// The TypeScript's way: `(state) -> state`, the old state still alive during
  /// the call, so every delta copies what it touches.
  static func appendPure(deltas: Int, filler: Int) -> (Double, Int) {
    var (state, id) = streamingState(filler: filler)

    func applyDelta(_ state: ChatState, _ delta: String) -> ChatState {
      var next = state
      next.items[id]?.updateAssistant { item in
        item.text += delta
        item.version += 1
      }
      return next
    }

    let time = seconds {
      for _ in 0..<deltas {
        state = applyDelta(state, "token · ")
      }
    }
    return (time, state.items[id]?.asAssistant?.text.utf8.count ?? 0)
  }

  @Test func appendingDeltasInPlaceIsLinear() {
    let (small, smallLength) = Self.appendInPlace(deltas: 10_000, filler: 500)
    let (large, largeLength) = Self.appendInPlace(deltas: 20_000, filler: 500)
    print(
      String(
        format: "in-place append: 10,000 deltas %.3f s, 20,000 deltas %.3f s (ratio %.2f), text %d → %d bytes",
        small, large, large / small, smallLength, largeLength
      )
    )

    #expect(smallLength == 10_000 * "token · ".utf8.count)
    #expect(small < 2.0, "10,000 in-place deltas took \(small) s")
    // Linear doubles; quadratic quadruples. Leave room for timer noise.
    #expect(large / small < 3.0, "doubling the deltas multiplied the time by \(large / small)")
  }

  @Test func appendingDeltasThroughAPureFunctionIsMeasured() {
    let (small, _) = Self.appendPure(deltas: 10_000, filler: 500)
    let (large, _) = Self.appendPure(deltas: 20_000, filler: 500)
    print(
      String(
        format: "pure (state) -> state append: 10,000 deltas %.3f s, 20,000 deltas %.3f s (ratio %.2f)",
        small, large, large / small
      )
    )
    // Reported, not bounded tightly: it copies the item dictionary and the growing
    // text on every delta. That is the reason the reducer runs `inout` on the store's
    // own state (see the header of `ChatState.swift`).
    #expect(small < 30)
  }

  @Test func copyingAStateIsConstantTime() {
    let (state, _) = Self.streamingState(filler: 5_000)
    var copies: [ChatState] = []
    copies.reserveCapacity(10_000)
    let time = Self.seconds {
      for _ in 0..<10_000 { copies.append(state) }
    }
    print(String(format: "copying a 5,001-item state 10,000 times: %.3f s", time))
    #expect(time < 1.0)
  }

  @Test func theLargestCorpusFileDecodesAndReencodesQuickly() throws {
    let url = GoldenCorpus.goldenDirectory.appendingPathComponent("duplicate-turns.json")
    let data = try Data(contentsOf: url)
    var document: JSONValue = .null
    let parse = try Self.seconds { document = try JSONValue(parsing: data) }

    // Every state in the file through the Swift types and back, in place.
    var states = 0
    var decodeTime = 0.0
    var encodeTime = 0.0

    func roundTrip(_ value: JSONValue) throws -> JSONValue {
      switch value {
      case .array(let elements):
        return .array(try elements.map(roundTrip))
      case .object(let object):
        if StateRoundTripTests.isStateShaped(object) {
          states += 1
          var state: ChatState?
          decodeTime += try Self.seconds { state = try ChatState(decoding: value) }
          var encoded: JSONValue = .null
          encodeTime += Self.seconds { encoded = state!.jsonValue }
          return encoded
        }
        return .object(try object.mapValues(roundTrip))
      default:
        return value
      }
    }

    var reencoded: JSONValue = .null
    let total = try Self.seconds { reencoded = try roundTrip(document) }
    var text = ""
    let write = try Self.seconds { text = try reencoded.canonicalString() }

    print(
      String(
        format: "duplicate-turns.json (%.1f MB): parse %.2f s, %d states decoded %.2f s, encoded %.2f s, "
          + "walk total %.2f s, canonical text %.2f s (%.1f MB)",
        Double(data.count) / 1_048_576, parse, states, decodeTime, encodeTime, total, write, Double(text.utf8.count) / 1_048_576
      )
    )

    #expect(reencoded == document)
    #expect(parse + total + write < 15, "decoding and re-encoding the largest file took \(parse + total + write) s")
  }
}
