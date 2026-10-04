import Foundation
import HermieProtocol
import HermieTranscript

/// One replayable engine function: the recorded arguments in, the JSON result out
/// (`nil` for `undefined`). Throwing a `GoldenHarnessError` means the arguments did
/// not fit the Swift function; throwing anything else is the function throwing.
typealias GoldenOperation = @Sendable (GoldenArgs) throws -> JSONValue?

/// Where each engine task registers the operations it ports. Each table lives in its
/// own file (`GoldenOps+<Area>.swift`), owned by the task that fills it; the harness
/// only merges them. An operation in the corpus that no table has is PENDING: it is
/// counted and printed, never failed.
enum GoldenOps {}

enum GoldenRegistry {
  /// Every table, merged. A name registered twice is a programming error.
  static let operations: [String: GoldenOperation] = {
    var merged: [String: GoldenOperation] = [:]
    for table in [GoldenOps.types, GoldenOps.helpers, GoldenOps.reducer, GoldenOps.history, GoldenOps.selectors] {
      for (name, operation) in table {
        precondition(merged[name] == nil, "golden operation \(name) is registered twice")
        merged[name] = operation
      }
    }
    return merged
  }()

  /// The task that ports each operation the corpus records, for the coverage report.
  /// An operation missing here is reported under `unassigned`.
  static let owners: [String: String] = {
    var owners: [String: String] = [:]
    let plan: [(String, [String])] = [
      ("task 10: types and helpers", [
        "createChatState", "parseIncomingBotMessage", "normalizeAgentTarget", "parseMessageAgentResult",
        "parseProcessCompleteText", "isBotDmDeliveryCommand", "deliveryTargetFromCommand", "replyFromDeliveryOutput",
        "dispatchedTo", "isBotToBotItem", "parseCronDelivery", "isCronDelivery", "contextUsageOf",
        "contextUsageOfInfo", "chatContextUsage", "parseInjectedRow", "isInjectedRow", "stripSteerWrapper",
        "unwrapSystemNote", "prettyModelName", "parseModelId", "turnActivity", "authorViaOf", "authorLabel"
      ]),
      ("task 11: reducer", [
        "applyEvent", "applyServerRequest", "answerRequest", "applyResumeSnapshot", "beginLocalTurn", "beginSteer",
        "dropSteer", "confirmSubmit", "markInterrupted", "applyProcessCompletion", "applySubagentSnapshot"
      ]),
      ("task 12: history, reconcile, cache", [
        "rowsToItems", "reconcile", "reconcileTail", "prependHistory", "snapshotForCache", "stateFromCache", "classifyUserRow",
        "stripUserText", "scanInlineImages", "isImagePlaceholder", "sniffImageType", "attachmentRefName", "attachmentsMatchKey", "normalizedItemText"
      ]),
      ("task 13: selectors and derived views", [
        "visibleItems", "isBusy", "runningSubagents", "subagentTree", "openRequests", "itemsVersion",
        "unreadCountSince", "lastMessageAt", "unreadBadgeLabel", "latestStatus", "previewFromChat",
        "previewFromGatewayText", "chatRowPreview", "activityEntries", "findDmCounterpart", "exportTranscript",
        "transcriptFileName", "transcriptDiagnostics", "formatTranscriptDiagnostics"
      ])
    ]
    for (owner, ops) in plan {
      for op in ops { owners[op] = owner }
    }
    return owners
  }()
}

/// The arguments of one recorded call, with typed readers that fail as a
/// `GoldenHarnessError` naming the argument.
struct GoldenArgs: Sendable {
  let values: [JSONValue]
  /// The call's `now` field: set only when the function read the clock itself.
  let now: Double?

  init(_ values: [JSONValue], now: Double? = nil) {
    self.values = values
    self.now = now
  }

  var count: Int { values.count }

  /// The raw argument, `nil` when not supplied (absent, or a top-level `null`).
  func raw(_ index: Int) -> JSONValue? {
    guard values.indices.contains(index), values[index] != .null else { return nil }
    return values[index]
  }

  /// A required argument decoded as a transcript type.
  func decode<T: TranscriptJSONCodable>(_ index: Int, as type: T.Type = T.self) throws -> T {
    guard let value = raw(index) else { throw GoldenHarnessError("argument \(index) (\(T.self)) is missing") }
    do {
      return try T(decoding: value, at: "args[\(index)]")
    } catch {
      throw GoldenHarnessError("argument \(index) is not a \(T.self): \(error)")
    }
  }

  /// An optional argument decoded as a transcript type.
  func decodeIfPresent<T: TranscriptJSONCodable>(_ index: Int, as type: T.Type = T.self) throws -> T? {
    guard raw(index) != nil else { return nil }
    return try decode(index, as: type)
  }

  /// An array argument of a transcript type (`TranscriptItem[]`, say).
  func decodeArray<T: TranscriptJSONCodable>(_ index: Int, of type: T.Type = T.self) throws -> [T] {
    guard case .array(let values)? = raw(index) else { throw GoldenHarnessError("argument \(index) is not an array") }
    return try values.enumerated().map { offset, value in
      do {
        return try T(decoding: value, at: "args[\(index)][\(offset)]")
      } catch {
        throw GoldenHarnessError("argument \(index)[\(offset)] is not a \(T.self): \(error)")
      }
    }
  }

  /// A required string argument.
  func string(_ index: Int) throws -> String {
    guard let value = raw(index)?.stringValue else { throw GoldenHarnessError("argument \(index) is not a string") }
    return value
  }

  /// An argument the TypeScript types as `unknown` and only reads when it is a
  /// string: anything else is `nil`, which the Swift functions treat the same way.
  func stringIfString(_ index: Int) -> String? {
    raw(index)?.stringValue
  }

  func number(_ index: Int) throws -> Double {
    guard let value = raw(index)?.doubleValue else { throw GoldenHarnessError("argument \(index) is not a number") }
    return value
  }

  func numberIfPresent(_ index: Int) throws -> Double? {
    guard let value = raw(index) else { return nil }
    guard let number = value.doubleValue else { throw GoldenHarnessError("argument \(index) is not a number") }
    return number
  }

  func bool(_ index: Int) throws -> Bool {
    guard let value = raw(index)?.boolValue else { throw GoldenHarnessError("argument \(index) is not a boolean") }
    return value
  }

  func boolIfPresent(_ index: Int) throws -> Bool? {
    guard let value = raw(index) else { return nil }
    guard let flag = value.boolValue else { throw GoldenHarnessError("argument \(index) is not a boolean") }
    return flag
  }

  func object(_ index: Int) throws -> JSONObject {
    guard let value = raw(index)?.objectValue else { throw GoldenHarnessError("argument \(index) is not an object") }
    return value
  }

  func objectIfPresent(_ index: Int) throws -> JSONObject? {
    guard let value = raw(index) else { return nil }
    guard let object = value.objectValue else { throw GoldenHarnessError("argument \(index) is not an object") }
    return object
  }

  /// A JSON-backed `HermieProtocol` type (`Usage`, `GatewayEvent`, `TranscriptRow`, …).
  func view<T: JSONObjectBacked>(_ index: Int, as type: T.Type = T.self) throws -> T {
    T(json: try object(index))
  }

  func viewIfPresent<T: JSONObjectBacked>(_ index: Int, as type: T.Type = T.self) throws -> T? {
    try objectIfPresent(index).map(T.init(json:))
  }
}

/// Result encoders for the operation tables: any `JSONConvertible` (transcript
/// types, `String`, `Bool`, `Double`, `Int`, arrays of them), `nil` for `undefined`.
enum GoldenResult {
  static func of<T: JSONConvertible>(_ value: T?) -> JSONValue? {
    value?.jsonValue
  }
}
