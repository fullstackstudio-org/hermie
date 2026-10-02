import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// Every entry of `contract/gateway/vectors/ui-meta.json`, replayed against the
/// Swift port. A failure names the entry, the function and both answers.
@Suite struct UIMetaVectorTests {
  struct Entry {
    var index: Int
    var fn: String
    var args: [JSONValue]
    var result: JSONValue

    func arg(_ position: Int) -> JSONValue {
      position < args.count ? args[position] : .null
    }
  }

  /// `contract/gateway/vectors/ui-meta.json`, found by walking up from this file.
  static func entries(from filePath: String = #filePath) throws -> [Entry] {
    var directory = URL(fileURLWithPath: filePath).deletingLastPathComponent()

    while directory.path != "/" {
      let candidate = directory.appendingPathComponent("contract/gateway/vectors/ui-meta.json")

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
    case "HERMIE_KEY": .string(UIMeta.botKey)
    case "HERMIE_APP_KEY": .string(UIMeta.legacyAppKey)
    case "BOT_MARKER_KEY": .string(UIMeta.botMarkerKey)
    case "HERMIE_SECTION_VERSION": .number(Double(UIMeta.botSectionVersion))
    case "HERMIE_APP_SECTION_VERSION": .number(Double(UIMeta.appSectionVersion))
    case "APP_UPDATED_AT": .string(UIMeta.appUpdatedAt)
    case "appKeyFor": entry.arg(0).stringValue.map { .string(UIMeta.appKey(for: $0)) }
    case "appStampOf": .number(UIMeta.appStamp(of: entry.arg(0).objectValue))
    case "inheritedFromLegacy": entry.arg(0).objectValue.map { .object(UIMeta.inheritedFromLegacy($0)) }
    case "readSection":
      entry.arg(1).stringValue.flatMap { key in
        entry.arg(2).doubleValue.map { known in
          UIMeta.readSection(entry.arg(0), key: key, known: known).map(JSONValue.object) ?? .null
        }
      }
    default: nil
    }
  }

  @Test func everyVectorHolds() throws {
    let entries = try Self.entries()
    var failures: [String] = []

    #expect(entries.count == 72)

    for entry in entries {
      guard let answer = Self.run(entry) else {
        failures.append("ui-meta[\(entry.index)] \(entry.fn): no Swift function")
        continue
      }

      if answer != entry.result {
        failures.append("ui-meta[\(entry.index)] \(entry.fn)(\(entry.args)): returned \(answer), expected \(entry.result)")
      }
    }

    for failure in failures {
      Issue.record(Comment(rawValue: failure))
    }
  }

  /// The vectors pin what `readSection` hands back; this pins that it is the
  /// stored object itself, unknown fields and all, and not a reshaped copy.
  @Test func aSectionComesBackWithEveryFieldItCarried() {
    let section: JSONObject = ["v": 1, "colour": "teal", "fromTheFuture": ["nested": [1, 2, nil]]]
    let bag: JSONValue = ["hermie": .object(section), "hermes-bots": [:]]

    #expect(UIMeta.readSection(bag, key: UIMeta.botKey, known: 1) == section)
  }
}
