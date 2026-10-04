import Foundation
import HermieProtocol
import Testing

// The parity gates
// ================
//
// The transcript engine is a transliteration of `packages/transcript/src`, and
// these tests are what holds it there. They pin the golden replay (`GoldenReplay.swift`)
// at the whole corpus:
//
// - every suite in `contract/transcript/golden` passes in full;
// - every operation `contract/transcript/golden-summary.json` records is
//   registered and passes in full, so an operation the TypeScript gains fails
//   here until it is ported and put in a `GoldenOps` table;
// - the replay covers exactly the calls the corpus holds (`corpusCalls`), so a
//   suite file that goes missing or stops loading cannot pass by being smaller;
// - no call passes only because `null` and an absent member were taken as one:
//   the engine writes exactly the keys the TypeScript writes;
// - every stream scenario in `contract/transcript/streams` reaches its recorded
//   final state and every checkpoint, none left pending.
//
// A re-recorded corpus (`npm run golden`) that adds or drops calls changes
// `corpusCalls`, and `streamCount` when a scenario is added: update them in the
// same commit, which is where a reviewer sees the corpus moved.
//
// `HERMIE_GOLDEN_FILTER` narrows the replay; a filtered run judges only what it
// replayed and skips the corpus-wide counts.

@Suite struct ParityGates {
  /// The calls the golden corpus records, every one of them replayable.
  static let corpusCalls = 4_974

  /// The stream scenarios the corpus records.
  static let streamCount = 13

  /// Every operation the corpus records, from `golden-summary.json`.
  static let recordedOperations: [String] = ((try? GoldenCorpus.summary()) ?? [:]).keys.sorted()

  // MARK: - The golden suites

  @Test(arguments: GoldenCorpus.suiteNames)
  func suitePassesInFull(_ name: String) throws {
    let report = GoldenReport.shared
    guard report.filter.includes(suite: name) else { return }
    let suite = try #require(report.suites[name], "suite \(name) was not replayed")

    #expect(suite.loadError == nil, "suite \(name) did not load: \(suite.loadError ?? "")")
    report.expectCoverage(suite: name, atLeast: 1.0)

    let totals = suite.totals
    #expect(
      totals.failed == 0 && totals.pending == 0,
      "suite \(name): \(totals.failed) failed, \(totals.pending) pending"
    )
    if !report.filter.isActive {
      #expect(totals.calls > 0, "suite \(name) replayed no calls")
    }
  }

  // MARK: - The operations

  @Test func theSummaryListsTheOperations() throws {
    let summary = try GoldenCorpus.summary()
    #expect(!summary.isEmpty, "golden-summary.json lists no operations")
    #expect(Self.recordedOperations.count == summary.count)
  }

  @Test(arguments: recordedOperations)
  func operationIsRegisteredAndPassesInFull(_ op: String) {
    #expect(GoldenRegistry.operations[op] != nil, "\(op) is recorded in the corpus but not registered in GoldenOps")
    GoldenReport.shared.expectCoverage(op: op, atLeast: 1.0)
  }

  /// The replay met no operation the summary does not list: the summary is the
  /// whole corpus, so the parameterised gate above judges every operation.
  @Test func everyReplayedOperationIsInTheSummary() {
    let recorded = Set(Self.recordedOperations)
    let unlisted = GoldenReport.shared.operations.keys.filter { !recorded.contains($0) }.sorted()
    #expect(unlisted.isEmpty, "operations replayed but missing from golden-summary.json: \(unlisted)")
  }

  // MARK: - The total

  @Test func theReplayCoversExactlyTheCorpus() throws {
    let report = GoldenReport.shared
    guard !report.filter.isActive else { return }

    let replayable = try GoldenCorpus.summary().values.reduce(0) { sum, entry in
      sum + (entry["replayable"]?.intValue ?? 0)
    }
    #expect(replayable == Self.corpusCalls, "golden-summary.json records \(replayable) replayable calls")

    let totals = report.totals
    #expect(totals.calls == Self.corpusCalls, "the replay ran \(totals.calls) calls, the corpus holds \(Self.corpusCalls)")
    #expect(totals.passed == Self.corpusCalls, "\(totals.passed)/\(Self.corpusCalls) calls pass")
    #expect(totals.failed == 0 && totals.pending == 0, "\(totals.failed) failed, \(totals.pending) pending")
    report.expectTotalCoverage(atLeast: 1.0)
  }

  @Test func noCallPassesOnlyModuloNull() {
    let report = GoldenReport.shared
    for (op, stats) in report.operations.sorted(by: { $0.key < $1.key }) {
      #expect(stats.passedModuloNull == 0, "\(op): \(stats.passedModuloNull) calls matched only modulo null")
    }
  }

  // MARK: - The stream scenarios

  @Test func everyStreamScenarioIsReplayed() {
    guard !GoldenFilter.current.isActive else { return }
    #expect(GoldenCorpus.streamNames.count == Self.streamCount, "streams: \(GoldenCorpus.streamNames)")
    #expect(GoldenStreamResults.shared.count == Self.streamCount)
  }

  @Test(arguments: GoldenCorpus.streamNames)
  func streamScenarioPasses(_ name: String) throws {
    guard GoldenFilter.current.includes(stream: name) else { return }
    let result = try #require(GoldenStreamResults.shared.first { $0.name == name }, "stream \(name) was not replayed")

    #expect(result.status == .passed, "stream \(name): \(result.status), \(result.failures)")
    #expect(result.checkpointsPending == 0, "stream \(name): \(result.checkpointsPending) checkpoints pending")
    #expect(result.checkpointsCompared > 0, "stream \(name) compared no checkpoint")
    #expect(result.failures.isEmpty)
  }
}
