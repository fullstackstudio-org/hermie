import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// Every entry of `contract/gateway/vectors/session-search.json`, replayed against the Swift port. A
/// failure names the entry, the function and both answers.
@Suite struct SessionSearchVectorTests {
  struct Entry {
    var index: Int
    var fn: String
    var args: [JSONValue]
    var result: JSONValue

    func arg(_ position: Int) -> JSONValue {
      position < args.count ? args[position] : .null
    }
  }

  /// The vectors, found by walking up from this file.
  static func entries(from filePath: String = #filePath) throws -> [Entry] {
    var directory = URL(fileURLWithPath: filePath).deletingLastPathComponent()

    while directory.path != "/" {
      let candidate = directory.appendingPathComponent("contract/gateway/vectors/session-search.json")

      if FileManager.default.fileExists(atPath: candidate.path) {
        let parsed = try JSONValue(parsing: try Data(contentsOf: candidate))
        let rows = try #require(parsed.arrayValue)

        return rows.enumerated().map { index, row in
          Entry(
            index: index,
            fn: row["fn"]?.stringValue ?? "",
            args: row["args"]?.arrayValue ?? [],
            result: row["result"] ?? .null
          )
        }
      }

      directory.deleteLastPathComponent()
    }

    throw CocoaError(.fileNoSuchFile)
  }

  /// The port's answer, or `nil` when it has no function of that name.
  static func run(_ entry: Entry) -> JSONValue? {
    switch entry.fn {
    case "SESSION_SEARCH_LIMIT_CAP": .number(Double(SessionSearch.limitCap))
    case "SNIPPET_MATCH_OPEN": .string(SessionSearch.matchOpen)
    case "SNIPPET_MATCH_CLOSE": .string(SessionSearch.matchClose)
    case "sessionSearchHitOf":
      SessionSearch.hit(of: entry.arg(0))?.jsonValue ?? .null
    case "parseSessionSearch":
      .array(SessionSearch.parse(entry.arg(0)).map(\.jsonValue))
    case "snippetSegments":
      entry.arg(0).stringValue.map { text in
        .array(
          SessionSearch.snippetSegments(text).map {
            .object(["match": .bool($0.match), "text": .string($0.text)])
          })
      }
    case "tidySnippet":
      entry.arg(0).stringValue.map { .string(SessionSearch.tidySnippet($0)) }
    case "plainSnippet":
      entry.arg(0).stringValue.map { .string(SessionSearch.plainSnippet($0)) }
    default: nil
    }
  }

  @Test func everyVectorHolds() throws {
    let entries = try Self.entries()
    var failures: [String] = []

    #expect(entries.count == 121)

    for entry in entries {
      guard let answer = Self.run(entry) else {
        failures.append("session-search[\(entry.index)] \(entry.fn): no Swift function")
        continue
      }

      if answer != entry.result {
        failures.append(
          "session-search[\(entry.index)] \(entry.fn)(\(entry.args)): returned \(answer), expected \(entry.result)")
      }
    }

    for failure in failures {
      Issue.record(Comment(rawValue: failure))
    }
  }
}
