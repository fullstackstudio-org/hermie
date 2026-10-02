import Foundation
import HermieProtocol
import Synchronization

/// Calls of one operation, by outcome.
struct OpStats: Sendable, Equatable {
  var calls = 0
  var passed = 0
  /// Of `passed`: calls that only matched once `null` and absent members were
  /// treated as equal (see `GoldenCompare`).
  var passedModuloNull = 0
  var failed = 0
  /// No Swift function registered yet.
  var pending = 0

  static func + (lhs: OpStats, rhs: OpStats) -> OpStats {
    OpStats(
      calls: lhs.calls + rhs.calls,
      passed: lhs.passed + rhs.passed,
      passedModuloNull: lhs.passedModuloNull + rhs.passedModuloNull,
      failed: lhs.failed + rhs.failed,
      pending: lhs.pending + rhs.pending
    )
  }

  /// Passed calls over all calls; pending calls count as not covered.
  var coverage: Double { calls == 0 ? 1 : Double(passed) / Double(calls) }
}

/// One implemented call that did not match.
struct GoldenFailure: Sendable {
  let suite: String
  let test: String
  let callIndex: Int
  let op: String
  let lines: [String]

  var message: String {
    "\(suite) › \(test) › call \(callIndex) \(op):\n  " + lines.joined(separator: "\n  ")
  }
}

/// Every replayed call of one suite file.
struct SuiteResult: Sendable {
  let name: String
  var ops: [String: OpStats] = [:]
  var failures: [GoldenFailure] = []
  /// The suite file could not be read at all.
  var loadError: String?
  var seconds: Double = 0

  var totals: OpStats { ops.values.reduce(OpStats(), +) }
}

/// The whole corpus, replayed once per test process and shared by every test that
/// reads it (a `static let` is initialised once, thread-safely).
struct GoldenReport: Sendable {
  let filter: GoldenFilter
  let suites: [String: SuiteResult]
  let seconds: Double

  static let shared = GoldenRunner.run(filter: .current)

  var totals: OpStats { suites.values.reduce(OpStats()) { $0 + $1.totals } }

  /// Per operation, across every suite.
  var operations: [String: OpStats] {
    var out: [String: OpStats] = [:]
    for suite in suites.values {
      for (op, stats) in suite.ops { out[op, default: OpStats()] = out[op, default: OpStats()] + stats }
    }
    return out
  }
}

enum GoldenRunner {
  /// Replays every suite the filter lets through, the suites in parallel.
  static func run(filter: GoldenFilter) -> GoldenReport {
    let start = ContinuousClock.now
    let names = GoldenCorpus.suiteNames.filter(filter.includes(suite:))
    let results = Mutex<[String: SuiteResult]>([:])

    DispatchQueue.concurrentPerform(iterations: names.count) { index in
      let result = replay(suite: names[index], filter: filter)
      results.withLock { $0[result.name] = result }
    }

    return GoldenReport(filter: filter, suites: results.withLock { $0 }, seconds: seconds(since: start))
  }

  static func replay(suite name: String, filter: GoldenFilter) -> SuiteResult {
    let start = ContinuousClock.now
    var result = SuiteResult(name: name)
    let suite: GoldenSuite

    do {
      suite = try GoldenCorpus.loadSuite(name)
    } catch {
      result.loadError = "\(error)"
      return result
    }

    for test in suite.tests {
      for call in test.calls where filter.includes(suite: name, op: call.op) {
        var stats = result.ops[call.op, default: OpStats()]
        stats.calls += 1

        switch check(call) {
        case .pending:
          stats.pending += 1
        case .passed(let moduloNull):
          stats.passed += 1
          if moduloNull { stats.passedModuloNull += 1 }
        case .failed(let lines):
          stats.failed += 1
          result.failures.append(GoldenFailure(suite: name, test: test.name, callIndex: call.index, op: call.op, lines: lines))
        }

        result.ops[call.op] = stats
      }
    }

    result.seconds = seconds(since: start)
    return result
  }

  enum Outcome {
    case pending
    case passed(moduloNull: Bool)
    case failed([String])
  }

  /// Runs one call through the registry and judges it by the replay protocol.
  static func check(_ call: GoldenCall) -> Outcome {
    guard let operation = GoldenRegistry.operations[call.op] else {
      return .pending
    }

    let actual: JSONValue?

    do {
      actual = try operation(GoldenArgs(call.args, now: call.now))
    } catch let error as GoldenHarnessError {
      return .failed(["the harness could not run it: \(error.description)", "args: \(GoldenCompare.excerpt(.array(call.args)))"])
    } catch {
      if call.throwsError { return .passed(moduloNull: false) }
      return .failed(["threw \(error), expected \(GoldenCompare.excerpt(call.result ?? .null))"])
    }

    if call.throwsError {
      return .failed(["returned \(GoldenCompare.excerpt(actual ?? .null)), expected a throw"])
    }

    switch GoldenCompare.compare(expected: call.result ?? .null, actual: actual ?? .null) {
    case .equal:
      return .passed(moduloNull: false)
    case .equalModuloNull:
      return .passed(moduloNull: true)
    case .different(let lines):
      return .failed(lines + ["args: \(GoldenCompare.excerpt(.array(call.args)))"])
    }
  }

  static func seconds(since start: ContinuousClock.Instant) -> Double {
    let elapsed = ContinuousClock.now - start
    return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
  }
}
