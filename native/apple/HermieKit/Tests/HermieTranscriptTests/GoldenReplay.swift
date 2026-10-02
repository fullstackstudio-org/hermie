import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

// The golden replay (`contract/README.md`): every call the TypeScript test suites
// made into the engine, replayed against the Swift port and compared as canonical
// JSON.
//
// - Each suite file is one test case below. An operation with no Swift function yet
//   is PENDING: counted and printed, never a failure. An implemented operation that
//   answers differently fails with the test name from the corpus and a diff.
// - `coverage` prints the table and writes the JSON summary.
// - `HERMIE_GOLDEN_FILTER` narrows the run (see `GoldenFilter`):
//     HERMIE_GOLDEN_FILTER=bot-dm native/apple/scripts/test.sh --filter GoldenReplay
//     HERMIE_GOLDEN_FILTER='*/applyEvent' native/apple/scripts/test.sh --filter GoldenReplay
//
// Adding an operation (Tasks 11–13): put an entry in your table
// (`Golden/GoldenOps+Reducer.swift`, `+History`, `+Selectors`), then pin your suites
// with an `expectCoverage` test like `helperSuitesPassInFull` below.

@Suite struct GoldenReplayTests {
  @Test(arguments: GoldenCorpus.suiteNames)
  func suite(_ name: String) throws {
    let report = GoldenReport.shared
    guard report.filter.includes(suite: name) else { return }
    let result = try #require(report.suites[name], "suite \(name) was not replayed")

    if let error = result.loadError {
      Issue.record(Comment(rawValue: "could not load \(name).json: \(error)"))
    }

    let totals = result.totals
    if report.filter.isActive && totals.calls == 0 { return }
    print(
      "golden \(name): \(totals.passed)/\(totals.calls) passed, \(totals.failed) failed, \(totals.pending) pending"
        + String(format: " (%.2f s)", result.seconds)
    )

    // A suite with many failures reports the first few in full and counts the rest.
    for failure in result.failures.prefix(25) {
      Issue.record(Comment(rawValue: failure.message))
    }
    if result.failures.count > 25 {
      Issue.record(Comment(rawValue: "\(name): \(result.failures.count - 25) more failures not shown"))
    }
  }

  @Test func coverage() throws {
    let report = GoldenReport.shared
    let streams = GoldenStreamResults.shared
    print(report.table(streams: streams))

    let summary = try report.summaryJSON(streams: streams).canonicalString()
    print("golden-coverage: \(summary)")

    let url = packageBuildDirectory.appendingPathComponent("golden-coverage.json")
    try? FileManager.default.createDirectory(at: packageBuildDirectory, withIntermediateDirectories: true)
    try Data(summary.utf8).write(to: url)
    print("golden coverage written to \(url.path)")

    #expect(report.totals.calls > 0 || report.filter.isActive, "the corpus replayed no calls")
  }

  /// Task 10's acceptance: the operations of the helper modules pass in full.
  @Test func helperSuitesPassInFull() {
    let report = GoldenReport.shared
    for (op, owner) in GoldenRegistry.owners where owner.hasPrefix("task 10") {
      report.expectCoverage(op: op, atLeast: 1.0)
    }
    for suite in ["bot-dm", "cron-delivery", "injected", "model-name", "context-usage"] {
      report.expectCoverage(suite: suite, atLeast: 1.0)
    }
  }

  /// Every operation the corpus records belongs to a task, so none can be
  /// forgotten: an operation the TypeScript gains shows up here first.
  @Test func everyRecordedOperationHasAnOwner() throws {
    let summary = try GoldenCorpus.summary()
    let unowned = summary.keys.filter { GoldenRegistry.owners[$0] == nil }.sorted()
    #expect(unowned.isEmpty, "operations with no owning task: \(unowned)")
  }

  /// The harness itself: a wrong answer, an unexpected throw, a missing throw, a
  /// harness-level argument problem and an unregistered operation are told apart.
  @Test func theHarnessJudgesCallsByTheReplayProtocol() throws {
    func call(_ op: String, _ args: [JSONValue], result: JSONValue? = nil, throwsError: Bool = false) throws -> GoldenCall {
      var json: JSONObject = ["op": .string(op), "args": .array(args)]
      if let result { json["result"] = result }
      if throwsError { json["throws"] = true }
      return try GoldenCall(index: 0, json: .object(json))
    }

    guard case .passed(false) = GoldenRunner.check(try call("prettyModelName", ["gpt-5"], result: "GPT-5")) else {
      Issue.record("a matching call did not pass")
      return
    }
    guard case .failed(let lines) = GoldenRunner.check(try call("prettyModelName", ["gpt-5"], result: "GPT 5")) else {
      Issue.record("a wrong answer passed")
      return
    }
    #expect(lines.first == #"$: expected "GPT 5", actual "GPT-5""#)
    guard case .failed = GoldenRunner.check(try call("prettyModelName", ["gpt-5"], throwsError: true)) else {
      Issue.record("a missing throw passed")
      return
    }
    // A harness problem (an argument of the wrong shape) never counts as the expected throw.
    guard case .failed = GoldenRunner.check(try call("prettyModelName", [42], throwsError: true)) else {
      Issue.record("an argument error passed as a throw")
      return
    }
    guard case .pending = GoldenRunner.check(try call("noSuchOperation", [])) else {
      Issue.record("an unregistered operation was not pending")
      return
    }
    // `undefined` and `null` results are the same thing; a `null` member and an
    // absent one pass, counted apart.
    guard case .passed(false) = GoldenRunner.check(try call("parseCronDelivery", ["plain"])) else {
      Issue.record("an absent result did not compare as null")
      return
    }
    #expect(GoldenCompare.compare(expected: ["a": 1, "b": nil], actual: ["a": 1]) == .equalModuloNull)
    #expect(
      GoldenCompare.compare(expected: ["items": [["id": "x", "seq": 1]]], actual: ["items": [["id": "x", "seq": 2]]])
        == .different(["$.items[0].seq: expected 1, actual 2"])
    )
  }

  @Test func theFilterReadsSuitesAndOperations() {
    let filter = GoldenFilter("reducer, */visibleItems,cache/stateFromCache")
    #expect(filter.includes(suite: "reducer", op: "applyEvent"))
    #expect(filter.includes(suite: "selectors", op: "visibleItems"))
    #expect(!filter.includes(suite: "selectors", op: "isBusy"))
    #expect(filter.includes(suite: "cache", op: "stateFromCache"))
    #expect(!filter.includes(suite: "cache", op: "snapshotForCache"))
    #expect(!GoldenFilter("").isActive)
    #expect(GoldenFilter("streams/approval").includes(stream: "approval"))
    #expect(!GoldenFilter("reducer").includes(stream: "approval"))
  }
}

/// The stream scenarios, replayed once per process.
enum GoldenStreamResults {
  static let shared: [StreamResult] = GoldenCorpus.streamNames
    .filter(GoldenFilter.current.includes(stream:))
    .map(GoldenStreamRunner.replay)
}

@Suite struct GoldenStreamTests {
  /// A scenario whose steps need an operation that is not registered yet is
  /// pending and passes; once every step's operation exists it must reach the
  /// recorded final state, and once `visibleItems` exists every checkpoint too.
  @Test(arguments: GoldenCorpus.streamNames)
  func scenario(_ name: String) {
    guard let result = GoldenStreamResults.shared.first(where: { $0.name == name }) else { return }

    switch result.status {
    case .pending(let missing):
      print("stream \(name): pending, needs \(missing.joined(separator: ", "))")
    case .passed:
      print(
        "stream \(name): passed, \(result.steps) steps, "
          + "\(result.checkpointsCompared) checkpoints compared, \(result.checkpointsPending) pending"
      )
    case .failed:
      for failure in result.failures {
        Issue.record(Comment(rawValue: "stream \(name): \(failure)"))
      }
    }
  }

  @Test func patchStateMergesThenRemoves() throws {
    let state = createChatState("bot", "stored", "resolved").jsonValue
    let patched = try GoldenStreamRunner.patchState(
      state,
      ["runtimeSessionId": "rt-1", "lastSeq": 0, "epoch": "e1"],
      ["epoch"]
    )
    #expect(patched["runtimeSessionId"] == "rt-1")
    #expect(patched["epoch"] == nil)
    #expect(patched["botName"] == "bot")
  }
}
