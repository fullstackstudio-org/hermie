import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// Performance guards for the state model, run in the debug build the tests use.
/// They print their numbers; the bounds are loose enough for a loaded CI machine
/// and tight enough to catch a quadratic regression or a pathological decoder.
@Suite(.serialized) struct StateCopyBenchmarkTests {
  /// CPU seconds the calling thread spends in `body`, not wall-clock seconds. The ratios these guards
  /// compare (twice the work, twice the time) hold for the work itself; a wall clock also counts every
  /// moment the thread was preempted, and on a machine busy with other builds and test runs that is the
  /// whole of the noise. The body must run on the calling thread, which every caller's does.
  static func seconds(_ body: () throws -> Void) rethrows -> Double {
    let start = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
    try body()
    return Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - start) / 1_000_000_000
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
    // The two sizes take turns and the fastest round of each counts: the other
    // suites run alongside, and one timing of each let a burst of load land on
    // the large size alone.
    var small = Double.infinity
    var large = Double.infinity
    var smallLength = 0
    var largeLength = 0
    for _ in 0..<5 {
      let (smallTime, smallBytes) = Self.appendInPlace(deltas: 10_000, filler: 500)
      let (largeTime, largeBytes) = Self.appendInPlace(deltas: 40_000, filler: 500)
      small = min(small, smallTime)
      large = min(large, largeTime)
      smallLength = smallBytes
      largeLength = largeBytes
    }
    print(
      String(
        format: "in-place append: 10,000 deltas %.3f s, 40,000 deltas %.3f s (ratio %.2f), text %d → %d bytes",
        small, large, large / small, smallLength, largeLength
      )
    )

    #expect(smallLength == 10_000 * "token · ".utf8.count)
    #expect(small < 2.0, "10,000 in-place deltas took \(small) s")
    // Four times the deltas: linear is ×4, quadratic ×16, so 8 sits between them with a factor of two to
    // spare on either side. (Twice the deltas left linear ×2 and quadratic ×4 with a bound of 3 between,
    // which a few milliseconds of noise at these sizes could cross.)
    #expect(large / small < 8.0, "4× the deltas multiplied the time by \(large / small)")
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
