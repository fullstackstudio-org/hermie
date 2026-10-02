import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// Task 11's acceptance, pinned: every reducer call in the corpus passes, and the
/// suites the reducer is judged by pass in full for every reducer operation they
/// record. (Their other operations belong to Tasks 12 and 13 and are pending until
/// those land, so the suites are judged per operation, not by their totals.)
@Suite struct ReducerGoldenTests {
  static let operations = GoldenRegistry.owners.filter { $0.value.hasPrefix("task 11") }.map(\.key).sorted()

  static let suites = [
    "reducer", "duplicate-turns", "duplicate-cron-turns", "duplicate-injected-turns", "request-order",
    "command-notice-order", "bot-to-bot", "turn-activity"
  ]

  @Test func everyReducerOperationIsRegistered() {
    #expect(Self.operations.count == 11)
    for op in Self.operations {
      #expect(GoldenOps.reducer[op] != nil, "\(op) is not registered")
    }
  }

  @Test func everyReducerCallInTheCorpusPasses() {
    let report = GoldenReport.shared
    for op in Self.operations {
      report.expectCoverage(op: op, atLeast: 1.0)
    }

    guard !report.filter.isActive else { return }
    let calls = Self.operations.reduce(0) { $0 + (report.operations[$1]?.passed ?? 0) }
    print("reducer: \(calls) corpus calls pass")
    #expect(calls == 1_515, "the corpus records 1,515 reducer calls; \(calls) passed")
  }

  @Test(arguments: suites)
  func suitePassesInFullForTheReducer(_ name: String) throws {
    let report = GoldenReport.shared
    guard report.filter.includes(suite: name) else { return }
    let suite = try #require(report.suites[name], "suite \(name) was not replayed")
    var judged = 0

    for op in Self.operations {
      guard let stats = suite.ops[op] else { continue }
      judged += stats.calls
      #expect(
        stats.passed == stats.calls && stats.failed == 0 && stats.passedModuloNull == 0,
        "\(name) › \(op): \(stats.passed)/\(stats.calls) pass (\(stats.failed) failed, \(stats.passedModuloNull) only modulo null)"
      )
    }

    if !report.filter.isActive {
      #expect(judged > 0, "suite \(name) records no reducer call")
    }
  }
}
