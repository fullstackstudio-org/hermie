import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

// The contract the transcript list stands on: every engine mutation that changes
// what a visible item draws bumps that item's `version`.
//
// The list compares rows in O(1), on the item's id and `version` plus the
// selectors' presentation (`TranscriptRow.Stamp` in HermieUI). A mutation that
// changed an item and left its version alone would leave the old row on screen
// until something else touched it. Nothing else in the engine checks this, so
// this suite replays the recorded engine calls and the stream scenarios through
// the real Swift reducer and compares the visible items of every state with the
// next one, at every verbosity, with and without thoughts.
//
// A violation names the operation, the item and the field that moved. If one
// appears, look at the TypeScript reducer first: the port follows it, so a fix
// belongs in Swift only where the TypeScript bumps the version too.

@Suite("Item version contract")
struct VersionContractTests {
  /// Every visibility a chat screen can ask for.
  static let options: [VisibilityOptions] = [Verbosity.quiet, .normal, .verbose].flatMap { level in
    [true, false].flatMap { thinking in
      [true, false].map { botToBot in
        VisibilityOptions(level: level, showBotToBot: botToBot, showThinking: thinking)
      }
    }
  }

  /// One item that drew differently with the same version.
  struct Violation: CustomStringConvertible {
    let source: String
    let op: String
    let id: String
    let version: Int
    let before: JSONValue
    let after: JSONValue

    var description: String {
      let changed = Self.changedKeys(before, after).joined(separator: ", ")
      return "\(source): \(op) changed item \(id) at version \(version) without a bump (changed: \(changed))"
    }

    static func changedKeys(_ before: JSONValue, _ after: JSONValue) -> [String] {
      guard let lhs = before.objectValue, let rhs = after.objectValue else { return ["<value>"] }
      return Set(lhs.keys).union(rhs.keys).filter { lhs[$0] != rhs[$0] }.sorted()
    }
  }

  /// What a row can draw of an item: everything but `seq`, which only orders
  /// items (the reconcile renumbers it when it re-sorts a tail) and no view reads.
  static func drawn(_ item: TranscriptItem) -> TranscriptItem {
    var copy = item
    copy.seq = 0
    return copy
  }

  /// The items that changed between two states with the same version, per id.
  static func violations(from before: ChatState, to after: ChatState, source: String, op: String) -> [Violation] {
    var found: [String: Violation] = [:]

    for option in options {
      let old = Dictionary(visibleItems(before, option).map { ($0.item.id, $0.item) }, uniquingKeysWith: { $1 })

      for entry in visibleItems(after, option) {
        let item = entry.item
        guard found[item.id] == nil, let previous = old[item.id], previous.version == item.version,
          Self.drawn(previous) != Self.drawn(item)
        else { continue }

        found[item.id] = Violation(
          source: source,
          op: op,
          id: item.id,
          version: item.version,
          before: previous.jsonValue,
          after: item.jsonValue
        )
      }
    }

    return found.values.sorted { $0.id < $1.id }
  }

  /// Every recorded call whose first argument and result are both chat states,
  /// replayed through the Swift operation (not the recorded result), so the
  /// check is on the port.
  @Test("recorded engine calls bump the version of every item they change")
  func corpus() throws {
    var violations: [Violation] = []
    var compared = 0

    for suiteName in GoldenCorpus.suiteNames {
      let suite = try GoldenCorpus.loadSuite(suiteName)

      for test in suite.tests {
        for call in test.calls where !call.throwsError {
          guard let operation = GoldenRegistry.operations[call.op], let first = call.args.first,
            first.objectValue?["order"] != nil, let before = try? ChatState(decoding: first),
            let output = try? operation(GoldenArgs(call.args, now: call.now)),
            output.objectValue?["order"] != nil, let after = try? ChatState(decoding: output)
          else { continue }

          compared += 1
          violations += Self.violations(from: before, to: after, source: "\(suiteName) > \(test.name)", op: call.op)
        }
      }
    }

    #expect(compared > 500, "the corpus should hold hundreds of state-to-state calls; found \(compared)")

    for violation in violations.prefix(40) {
      Issue.record(Comment(rawValue: violation.description))
    }

    if violations.count > 40 {
      Issue.record(Comment(rawValue: "\(violations.count - 40) more version-contract violations not shown"))
    }
  }

  /// The stream scenarios, step by step, as the transcript store applies them.
  @Test("stream scenarios bump the version of every item they change", arguments: GoldenCorpus.streamNames)
  func stream(_ name: String) throws {
    let stream = try GoldenStream.load(name)
    var json: JSONValue = .null
    var previous: ChatState?
    var violations: [Violation] = []

    for step in stream.steps {
      switch step.op {
      case "createChatState":
        json = try #require(try GoldenRegistry.operations["createChatState"]?(GoldenArgs(step.args)))
      case "patchState":
        json = try GoldenStreamRunner.patchState(json, step.args.first, step.args.count > 1 ? step.args[1] : nil)
      default:
        let operation = try #require(GoldenRegistry.operations[step.op], "\(step.op) is not registered")
        json = try #require(try operation(GoldenArgs([json] + step.args)))
      }

      let state = try ChatState(decoding: json)

      if let previous {
        violations += Self.violations(from: previous, to: state, source: "\(name) step \(step.index)", op: step.op)
      }

      previous = state
    }

    #expect(previous != nil, "\(name) applied nothing")

    for violation in violations {
      Issue.record(Comment(rawValue: violation.description))
    }
  }

  /// The check itself catches what it is for: an item changed in place.
  @Test("an item changed without a bump is reported")
  func detectsAMissingBump() throws {
    var before = createChatState("contract", "s", "s")
    before = beginLocalTurn(before, "hello", nil, 1_000, nil)
    var after = before
    let id = try #require(after.orderedItems.first { $0.asUser != nil }?.id)
    after.items[id]?.updateUser { $0.text = "changed in place" }

    let found = Self.violations(from: before, to: after, source: "self-test", op: "edit")
    #expect(found.map(\.id) == [id])
    #expect(found.first.map { Violation.changedKeys($0.before, $0.after) } == ["text"])
  }
}
