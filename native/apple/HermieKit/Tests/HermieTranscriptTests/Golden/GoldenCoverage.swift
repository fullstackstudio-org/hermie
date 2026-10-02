import Foundation
import HermieProtocol
import Testing

/// The coverage report: a table for people, a JSON summary for machines, and the
/// minimum-coverage assertion later tasks pin their suites with.
extension GoldenReport {
  /// The machine-readable summary. Printed after the `golden-coverage:` marker and
  /// written to `.build/golden-coverage.json` by `GoldenReplayTests.coverage`.
  func summaryJSON(streams: [StreamResult]) -> JSONValue {
    func stats(_ stats: OpStats) -> JSONObject {
      [
        "calls": .number(Double(stats.calls)),
        "passed": .number(Double(stats.passed)),
        "passedModuloNull": .number(Double(stats.passedModuloNull)),
        "failed": .number(Double(stats.failed)),
        "pending": .number(Double(stats.pending)),
        "coverage": .number((stats.coverage * 10_000).rounded() / 10_000)
      ]
    }

    var suitesJSON: JSONObject = [:]
    for (name, suite) in suites {
      var object = stats(suite.totals)
      if let error = suite.loadError { object["loadError"] = .string(error) }
      suitesJSON[name] = .object(object)
    }

    var operationsJSON: JSONObject = [:]
    for (op, opStats) in operations {
      var object = stats(opStats)
      object["implemented"] = .bool(GoldenRegistry.operations[op] != nil)
      object["owner"] = .string(GoldenRegistry.owners[op] ?? "unassigned")
      operationsJSON[op] = .object(object)
    }

    var streamsJSON: JSONObject = [:]
    for stream in streams {
      var object: JSONObject = [
        "steps": .number(Double(stream.steps)),
        "checkpointsCompared": .number(Double(stream.checkpointsCompared)),
        "checkpointsPending": .number(Double(stream.checkpointsPending))
      ]
      switch stream.status {
      case .passed: object["status"] = "passed"
      case .failed: object["status"] = "failed"
      case .pending(let missing):
        object["status"] = "pending"
        object["missing"] = .array(missing.map(JSONValue.string))
      }
      streamsJSON[stream.name] = .object(object)
    }

    return [
      "filter": filter.isActive ? .string(ProcessInfo.processInfo.environment["HERMIE_GOLDEN_FILTER"] ?? "") : .null,
      "totals": .object(stats(totals)),
      "suites": .object(suitesJSON),
      "operations": .object(operationsJSON),
      "streams": .object(streamsJSON)
    ]
  }

  /// The human-readable table: per suite, per operation (implemented first), the
  /// pending operations grouped by the task that owns them, and the streams.
  func table(streams: [StreamResult]) -> String {
    func percent(_ value: Double) -> String { String(format: "%5.1f %%", value * 100) }
    func row(_ name: String, _ stats: OpStats, _ extra: String = "") -> String {
      name.padding(toLength: 30, withPad: " ", startingAt: 0)
        + String(format: "%7d %7d %7d %8d %8d  ", stats.calls, stats.passed, stats.failed, stats.pending, stats.passedModuloNull)
        + percent(stats.coverage) + extra
    }
    let header = "".padding(toLength: 30, withPad: " ", startingAt: 0) + "  calls  passed  failed  pending  null=abs  coverage"

    var lines: [String] = []
    lines.append("Golden replay of contract/transcript/golden (\(String(format: "%.2f", seconds)) s)"
      + (filter.isActive ? " — filter \(ProcessInfo.processInfo.environment["HERMIE_GOLDEN_FILTER"] ?? "")" : ""))
    lines.append("")
    lines.append("By suite")
    lines.append(header)
    for name in suites.keys.sorted() {
      let suite = suites[name]!
      // A filtered run loads every suite a `*/op` term may touch; list only those it ran.
      if filter.isActive && suite.totals.calls == 0 && suite.loadError == nil { continue }
      lines.append(row("  " + name, suite.totals, suite.loadError.map { "  LOAD ERROR: \($0)" } ?? ""))
    }
    lines.append(row("  TOTAL", totals))

    let ops = operations
    let implemented = ops.keys.filter { GoldenRegistry.operations[$0] != nil }.sorted()
    let pending = ops.keys.filter { GoldenRegistry.operations[$0] == nil }.sorted()

    lines.append("")
    lines.append("Implemented operations (\(implemented.count))")
    lines.append(header)
    for op in implemented { lines.append(row("  " + op, ops[op]!)) }
    lines.append(row("  TOTAL", implemented.reduce(OpStats()) { $0 + ops[$1]! }))

    lines.append("")
    lines.append("Pending operations (\(pending.count)), by owner")
    let byOwner = Dictionary(grouping: pending) { GoldenRegistry.owners[$0] ?? "unassigned" }
    for owner in byOwner.keys.sorted() {
      let opsOfOwner = byOwner[owner]!.sorted()
      let calls = opsOfOwner.reduce(0) { $0 + ops[$1]!.calls }
      lines.append("  \(owner): \(opsOfOwner.count) operations, \(calls) calls")
      lines.append("    " + opsOfOwner.map { "\($0) (\(ops[$0]!.calls))" }.joined(separator: ", "))
    }

    lines.append("")
    lines.append("Stream scenarios (contract/transcript/streams)")
    for stream in streams {
      let status: String =
        switch stream.status {
        case .passed: "passed"
        case .failed: "FAILED"
        case .pending(let missing): "pending — needs \(missing.joined(separator: ", "))"
        }
      lines.append(
        "  \(stream.name.padding(toLength: 18, withPad: " ", startingAt: 0)) \(stream.steps) steps, "
          + "checkpoints \(stream.checkpointsCompared) compared / \(stream.checkpointsPending) pending: \(status)"
      )
    }
    return lines.joined(separator: "\n")
  }

  /// Records an issue unless `suite` covers at least `minimum` (0…1) of its calls.
  /// Pending calls count against it. A suite the filter excludes is not judged.
  ///
  ///     GoldenReport.shared.expectCoverage(suite: "reducer", atLeast: 1.0)
  func expectCoverage(suite name: String, atLeast minimum: Double, sourceLocation: SourceLocation = #_sourceLocation) {
    guard filter.includes(suite: name) else { return }
    guard let suite = suites[name] else {
      Issue.record("no golden suite named \(name)", sourceLocation: sourceLocation)
      return
    }
    let stats = suite.totals
    #expect(
      stats.coverage >= minimum,
      Comment(
        rawValue: "suite \(name): \(stats.passed)/\(stats.calls) calls pass (\(stats.failed) failed, \(stats.pending) pending), "
          + "need \(minimum * 100) %"
      ),
      sourceLocation: sourceLocation
    )
  }

  /// Records an issue unless operation `op` covers at least `minimum` of its calls
  /// across the whole corpus. An operation the filter excludes entirely is not judged.
  func expectCoverage(op: String, atLeast minimum: Double, sourceLocation: SourceLocation = #_sourceLocation) {
    guard let stats = operations[op] else {
      if !filter.isActive {
        Issue.record("the corpus records no calls to \(op)", sourceLocation: sourceLocation)
      }
      return
    }
    #expect(
      stats.coverage >= minimum,
      Comment(
        rawValue: "\(op): \(stats.passed)/\(stats.calls) calls pass (\(stats.failed) failed, \(stats.pending) pending), "
          + "need \(minimum * 100) %"
      ),
      sourceLocation: sourceLocation
    )
  }

  /// Records an issue unless the whole corpus covers at least `minimum`.
  func expectTotalCoverage(atLeast minimum: Double, sourceLocation: SourceLocation = #_sourceLocation) {
    guard !filter.isActive else { return }
    let stats = totals
    #expect(
      stats.coverage >= minimum,
      "corpus: \(stats.passed)/\(stats.calls) calls pass, need \(minimum * 100) %",
      sourceLocation: sourceLocation
    )
  }
}
