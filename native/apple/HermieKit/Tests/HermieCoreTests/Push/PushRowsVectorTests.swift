import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// `contract/gateway/vectors/push.json`, every vector, replayed against `PushRows`: the rows this
/// app writes and the readers it applies are the ones the plugin and Hermie Web use.
@Suite("Push rows against the contract vectors")
struct PushRowsVectorTests {
  struct Vector {
    var fn: String
    var args: [JSONValue]
    /// nil where the reference returned `undefined`.
    var result: JSONValue?
  }

  static func vectors() throws -> [Vector] {
    guard case .array(let entries) = try ContractFiles.json("gateway/vectors/push.json") else {
      throw TimedOut(what: "the push vectors as a list")
    }

    return entries.compactMap { entry in
      guard case .object(let object) = entry, case .string(let fn)? = object["fn"] else {
        return nil
      }

      return Vector(fn: fn, args: object["args"]?.arrayValue ?? [], result: object["result"])
    }
  }

  /// The port of one call, or nil when the reference returned `undefined`.
  static func call(_ vector: Vector) throws -> JSONValue? {
    let args = vector.args
    let first = args.first

    switch vector.fn {
    case "PUSH_TYPES": return .array(PushContract.types.map(JSONValue.string))
    case "PUSH_SECTION_VERSION": return .number(Double(PushRows.sectionVersion))
    case "PUSH_SECTION_KEY": return .string(PushRows.sectionKey)
    case "PUSH_PER_BOT_KEY": return .string(PushRows.perBotKey)
    case "PUSH_SEEN_TTL_SECONDS": return .number(PushRows.seenTTL)
    case "PUSH_RELAY_ORIGIN": return .string(PushRelay.defaultOrigin)
    case "PUSH_RELAY_PLATFORMS": return .array(PushRows.relayPlatforms.map(JSONValue.string))
    case "pushStampOf": return .number(PushRows.stamp(milliseconds: first?.doubleValue ?? 0))
    case "noPushTypes": return .object(PushRows.noTypes())
    case "pushTypesOf": return .object(PushRows.typesOf(first))
    case "adoptedPushTypes": return .object(PushRows.adoptedTypes(first, defaults: args[1].objectValue ?? [:]))
    case "noTypeWanted": return .bool(PushRows.noTypeWanted(first?.objectValue ?? [:]))
    case "effectivePushTypes":
      return .object(PushRows.effectiveTypes(first?.objectValue ?? [:], overrides: args.count > 1 ? args[1].objectValue : nil))
    case "pushRowFor": return .object(PushRows.rowFor(first?.objectValue ?? [:]))
    case "pushRelayOriginOf": return .string(PushRows.relayOriginOf(first))
    case "pushRelayAllowed": return .bool(PushRows.relayAllowed(first, allowList: args[1].arrayValue ?? []))
    case "pushAddressOf": return PushRows.addressOf(first).map(JSONValue.object) ?? .null
    case "foreignPushRows": return .object(PushRows.foreignRows(first, installation: args[1].stringValue ?? ""))
    case "pushSeenOf":
      return .object(PushRows.seenOf(first).mapValues { ["bot": .string($0.bot), "at": .number($0.at)] })
    case "pushPerBotOf": return .object(PushRows.perBotOf(first))
    case "pushSectionFor": return PushRows.sectionFor(first?.objectValue ?? [:]).map(JSONValue.object)
    default:
      Issue.record("a push vector names a function this port does not have: \(vector.fn)")
      return nil
    }
  }

  @Test("every vector, every function")
  func replay() throws {
    let vectors = try Self.vectors()
    #expect(vectors.count > 250)

    var mismatches: [String] = []

    for (index, vector) in vectors.enumerated() {
      let got = try Self.call(vector)

      if got != vector.result {
        let shown = try? got.map { try $0.canonicalString() } ?? "undefined"
        mismatches.append("#\(index) \(vector.fn): got \(shown ?? "?")")
      }
    }

    #expect(mismatches.isEmpty, "\(mismatches.prefix(10).joined(separator: "\n"))")
  }

  @Test("the writer's row is one the reference builds from the same input")
  func writerRowMatchesTheReference() {
    let input: JSONObject = [
      "address": [
        "transport": "relay", "relay": "https://push.hermie.dev", "handle": "h_test-handle-0001",
        "secret": "test-send-secret-0001"
      ],
      "gatewayKey": "bf796761db84e312",
      "platform": "macos",
      "types": .object(PushRows.defaultTypes),
      "preview": false,
      "updatedAt": 1_790_001_453
    ]

    let row = PushRows.rowFor(input)
    #expect(PushRows.addressOf(.object(row)) != nil)
    #expect(row["secret"] == "test-send-secret-0001")
  }
}
