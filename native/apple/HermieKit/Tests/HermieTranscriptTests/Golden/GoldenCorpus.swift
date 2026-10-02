import Foundation
import HermieProtocol

/// The repository's `contract/transcript` directory, found from this file's own path
/// (`<repo>/native/apple/HermieKit/Tests/HermieTranscriptTests/Golden/GoldenCorpus.swift`).
let transcriptContractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract/transcript", isDirectory: true)
}()

/// `<repo>/native/apple/HermieKit/.build`, where the coverage summary is written.
let packageBuildDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<4 { url.deleteLastPathComponent() }
  return url.appendingPathComponent(".build", isDirectory: true)
}()

/// One recorded call (`contract/README.md`, "Replaying `transcript/golden/`").
struct GoldenCall: Sendable {
  /// Position within its test, from 0.
  let index: Int
  let op: String
  /// Positional; a top-level `null` means "not supplied".
  let args: [JSONValue]
  /// Absent means the function returned `undefined`; compared as `null`.
  let result: JSONValue?
  let throwsError: Bool
  /// Present only when the function read the clock itself.
  let now: Double?

  init(index: Int, json: JSONValue) throws {
    guard let op = json["op"]?.stringValue, let args = json["args"]?.arrayValue else {
      throw GoldenHarnessError("malformed call \(index): \(json)")
    }
    self.index = index
    self.op = op
    self.args = args
    result = json["result"]
    throwsError = json["throws"] == .bool(true)
    now = json["now"]?.doubleValue
  }
}

struct GoldenTest: Sendable {
  /// `describe name > test name`, or `(module scope)`.
  let name: String
  let calls: [GoldenCall]
}

/// One `contract/transcript/golden/<suite>.json`.
struct GoldenSuite: Sendable {
  let name: String
  let tests: [GoldenTest]

  var callCount: Int { tests.reduce(0) { $0 + $1.calls.count } }
}

enum GoldenCorpus {
  static let goldenDirectory = transcriptContractDirectory.appendingPathComponent("golden", isDirectory: true)
  static let streamsDirectory = transcriptContractDirectory.appendingPathComponent("streams", isDirectory: true)

  /// Every suite name (file name without `.json`), sorted.
  static let suiteNames: [String] = jsonFileNames(in: goldenDirectory)

  /// Every stream scenario name, sorted.
  static let streamNames: [String] = jsonFileNames(in: streamsDirectory)

  static func jsonFileNames(in directory: URL) -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return names.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
  }

  static func loadJSON(_ url: URL) throws -> JSONValue {
    try JSONValue(parsing: Data(contentsOf: url))
  }

  static func loadSuite(_ name: String) throws -> GoldenSuite {
    let json = try loadJSON(goldenDirectory.appendingPathComponent("\(name).json"))
    guard let tests = json.arrayValue else { throw GoldenHarnessError("\(name).json is not an array") }
    return GoldenSuite(
      name: name,
      tests: try tests.map { test in
        guard let testName = test["test"]?.stringValue, let calls = test["calls"]?.arrayValue else {
          throw GoldenHarnessError("\(name).json: malformed test \(test)")
        }
        let parsed = try calls.enumerated().map { try GoldenCall(index: $0.offset, json: $0.element) }
        return GoldenTest(name: testName, calls: parsed)
      }
    )
  }

  /// `golden-summary.json`'s per-operation counts: what the recorder saw, including
  /// what it could not record.
  static func summary() throws -> [String: JSONValue] {
    try loadJSON(transcriptContractDirectory.appendingPathComponent("golden-summary.json"))["operations"]?.objectValue ?? [:]
  }
}

/// The harness could not even run a call: a malformed corpus, an argument of the
/// wrong shape for the Swift function. Never mistaken for the function throwing.
struct GoldenHarnessError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

/// `HERMIE_GOLDEN_FILTER`: run part of the corpus. Comma-separated terms, each
/// `suite`, `suite/op` or `*/op` (`HERMIE_GOLDEN_FILTER=reducer`,
/// `HERMIE_GOLDEN_FILTER='*/applyEvent'`, `HERMIE_GOLDEN_FILTER=selectors/visibleItems,cache`).
/// Unset or empty: everything. It applies to the stream scenarios by scenario name
/// (`HERMIE_GOLDEN_FILTER=streams/approval`, or `streams` for all six).
struct GoldenFilter: Sendable {
  private let terms: [(suite: String?, op: String?)]

  static let current = GoldenFilter(ProcessInfo.processInfo.environment["HERMIE_GOLDEN_FILTER"] ?? "")

  init(_ text: String) {
    terms = text.split(separator: ",").compactMap { raw in
      let term = raw.trimmingCharacters(in: .whitespaces)
      if term.isEmpty { return nil }
      let parts = term.split(separator: "/", maxSplits: 1).map(String.init)
      let suite = parts[0] == "*" ? nil : parts[0]
      return (suite, parts.count > 1 ? parts[1] : nil)
    }
  }

  var isActive: Bool { !terms.isEmpty }

  /// Whether any call of `suite` can run.
  func includes(suite: String) -> Bool {
    !isActive || terms.contains { $0.suite == nil || $0.suite == suite }
  }

  func includes(suite: String, op: String) -> Bool {
    !isActive || terms.contains { ($0.suite == nil || $0.suite == suite) && ($0.op == nil || $0.op == op) }
  }

  func includes(stream: String) -> Bool {
    !isActive || terms.contains { $0.suite == "streams" && ($0.op == nil || $0.op == stream) }
  }
}
