import Foundation
import HermieProtocol
import Synchronization
import Testing

@testable import HermieTranscript

/// Every engine state and every transcript item recorded anywhere in
/// `contract/transcript` (golden calls, their results, stream steps, checkpoints,
/// final states) decodes into the Swift types and encodes back to the very same
/// JSON — exactly, with no `null`/absent leniency.
@Suite struct StateRoundTripTests {
  /// What one file held, and what did not survive.
  struct FileTally: Sendable {
    var states = 0
    var items = 0
    var failures: [String] = []
  }

  static func isStateShaped(_ object: JSONObject) -> Bool {
    object["botName"]?.stringValue != nil && object["items"]?.objectValue != nil
      && object["order"]?.arrayValue != nil && object["turn"]?.objectValue != nil
  }

  static func isItemShaped(_ object: JSONObject) -> Bool {
    guard let kind = object["kind"]?.stringValue, TranscriptItemKind(rawValue: kind).isKnown else { return false }
    return object["id"]?.stringValue != nil && object["seq"]?.doubleValue != nil
      && object["version"]?.doubleValue != nil && object["origin"]?.stringValue != nil
  }

  /// Walks `value`, round-tripping every state and item it finds (items inside a
  /// state are counted too: they are checked again on their own).
  static func walk(_ value: JSONValue, path: String, into tally: inout FileTally) {
    switch value {
    case .array(let elements):
      for (index, element) in elements.enumerated() {
        walk(element, path: "\(path)[\(index)]", into: &tally)
      }
    case .object(let object):
      if isStateShaped(object) {
        tally.states += 1
        check(ChatState.self, value, path: path, into: &tally)
      } else if isItemShaped(object) {
        tally.items += 1
        check(TranscriptItem.self, value, path: path, into: &tally)
      }
      for (key, member) in object {
        walk(member, path: "\(path).\(key)", into: &tally)
      }
    default:
      break
    }
  }

  static func check<T: TranscriptJSONCodable>(_ type: T.Type, _ value: JSONValue, path: String, into tally: inout FileTally) {
    guard tally.failures.count < 10 else { return }
    do {
      let decoded = try T(decoding: value)
      let encoded = decoded.jsonValue
      if encoded != value {
        var lines: [String] = []
        GoldenCompare.diff(value, encoded, path: "$", into: &lines, limit: 5)
        tally.failures.append("\(path) (\(T.self)) does not re-encode to the same JSON:\n  " + lines.joined(separator: "\n  "))
      }
    } catch {
      tally.failures.append("\(path) (\(T.self)) does not decode: \(error)")
    }
  }

  @Test func everyRecordedStateAndItemRoundTrips() throws {
    let files =
      GoldenCorpus.suiteNames.map { GoldenCorpus.goldenDirectory.appendingPathComponent("\($0).json") }
      + GoldenCorpus.streamNames.map { GoldenCorpus.streamsDirectory.appendingPathComponent("\($0).json") }
    let tallies = Mutex<[String: FileTally]>([:])
    let start = ContinuousClock.now

    DispatchQueue.concurrentPerform(iterations: files.count) { index in
      let url = files[index]
      var tally = FileTally()
      do {
        Self.walk(try GoldenCorpus.loadJSON(url), path: url.lastPathComponent, into: &tally)
      } catch {
        tally.failures.append("could not read \(url.lastPathComponent): \(error)")
      }
      tallies.withLock { $0[url.lastPathComponent] = tally }
    }

    let all = tallies.withLock { $0 }
    let states = all.values.reduce(0) { $0 + $1.states }
    let items = all.values.reduce(0) { $0 + $1.items }
    print(
      "round trip: \(states) states and \(items) items from \(files.count) corpus files"
        + String(format: " in %.2f s", GoldenRunner.seconds(since: start))
    )

    #expect(states > 4000, "expected the corpus's ~4800 recorded states, found \(states)")
    for (file, tally) in all.sorted(by: { $0.key < $1.key }) {
      for failure in tally.failures {
        Issue.record(Comment(rawValue: "\(file): \(failure)"))
      }
    }
  }
}
