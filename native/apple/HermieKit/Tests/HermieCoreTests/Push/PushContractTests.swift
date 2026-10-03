import Foundation
import HermieProtocol
import HermieShared
import Testing

@testable import HermieCore

/// The Swift side of `contract/push/contract.json`: this suite fails when the contract names an
/// action, a flag, a type or a category the app does not know, or the reverse.
@Suite("Push contract")
struct PushContractTests {
  static func contract() throws -> JSONObject {
    guard case .object(let object) = try ContractFiles.json("push/contract.json") else {
      throw TimedOut(what: "the push contract as an object")
    }

    return object
  }

  static func strings(_ value: JSONValue?) -> [String] {
    guard case .array(let items)? = value else {
      return []
    }

    return items.compactMap { if case .string(let text) = $0 { text } else { nil } }
  }

  @Test("every action in the contract is one this build knows, with the same flags, and no more")
  func actions() throws {
    guard case .object(let category)? = try Self.contract()["category"], case .array(let actions)? = category["actions"]
    else {
      Issue.record("the contract has no category actions")
      return
    }

    var seen: [String] = []

    for case .object(let action) in actions {
      guard case .string(let id)? = action["id"] else {
        Issue.record("an action without an id")
        continue
      }

      seen.append(id)

      guard let known = PushContract.Action(rawValue: id) else {
        Issue.record("the contract names an action this build does not know: \(id)")
        continue
      }

      #expect(action["destructive"] == .bool(known.destructive), "destructive flag of \(id)")
      #expect(action["foreground"] == .bool(known.contractForeground), "foreground flag of \(id)")
      #expect(action["title"] == .string(known.contractTitle), "title of \(id)")
    }

    #expect(seen == PushContract.Action.allCases.map(\.rawValue))
  }

  @Test("the category id and the payload types match the contract")
  func categoryAndTypes() throws {
    let contract = try Self.contract()

    guard case .object(let category)? = contract["category"] else {
      Issue.record("no category")
      return
    }

    #expect(category["id"] == .string(PushContract.requestCategory))
    #expect(Self.strings(contract["types"]) == PushContract.types)
  }

  @Test("the types match the gateway vectors' PUSH_TYPES too")
  func vectorTypes() throws {
    guard case .array(let vectors) = try ContractFiles.json("gateway/vectors/push.json") else {
      Issue.record("push vectors are not a list")
      return
    }

    let entry = vectors.first { vector in
      if case .object(let object) = vector, object["fn"] == "PUSH_TYPES" { true } else { false }
    }

    guard case .object(let object)? = entry else {
      Issue.record("no PUSH_TYPES vector")
      return
    }

    #expect(Self.strings(object["result"]) == PushContract.types)
  }

  @Test("the one deliberate deviation: both actions open the app until background answering exists")
  func foregroundOverride() {
    // `PushContract.actionsForegroundOverride` says why. When it goes, this test and the `true`
    // below in `categories` go with it, and the registered flags are the contract's again.
    #expect(PushContract.actionsForegroundOverride)

    for action in PushContract.Action.allCases {
      #expect(!action.contractForeground)
      #expect(action.foreground)
    }
  }

  @Test("categories: the contract's and the legacy ids, each with both actions, authentication required")
  func categories() {
    let categories = PushCategoryDescriptor.all(title: \.contractTitle)
    let foreground = PushContract.actionsForegroundOverride

    #expect(categories.map(\.identifier) == ["hermie.request", "request", "hermie.approval"])

    for category in categories {
      #expect(
        category.actions
          == [
            PushActionDescriptor(
              identifier: "hermie.request.allow", title: "Allow", destructive: false, foreground: foreground,
              requiresAuthentication: true),
            PushActionDescriptor(
              identifier: "hermie.request.deny", title: "Deny", destructive: true, foreground: foreground,
              requiresAuthentication: true)
          ]
      )
    }
  }

  @Test("actions are recognised in both spellings; anything else is a plain open")
  func actionIdentifiers() {
    #expect(PushContract.Action(identifier: "hermie.request.allow") == .allow)
    #expect(PushContract.Action(identifier: "allow") == .allow)
    #expect(PushContract.Action(identifier: "hermie.request.deny") == .deny)
    #expect(PushContract.Action(identifier: "deny") == .deny)
    #expect(PushContract.Action(identifier: "com.apple.UNNotificationDefaultActionIdentifier") == nil)
    #expect(PushContract.Action(identifier: "") == nil)
  }

  // MARK: The rest of the contract

  static func object(_ value: JSONValue?) -> JSONObject {
    value?.objectValue ?? [:]
  }

  static func array(_ value: JSONValue?) -> [JSONObject] {
    (value?.arrayValue ?? []).compactMap { $0.objectValue }
  }

  static func field(_ key: String) throws -> JSONObject {
    let fields = Self.array(Self.object(try Self.contract()["data"])["fields"])

    guard let field = fields.first(where: { $0["key"] == .string(key) }) else {
      throw TimedOut(what: "the contract's data field \(key)")
    }

    return field
  }

  @Test("every data key the contract lists is one the payload reader reads or carries, and the reverse")
  func dataKeys() throws {
    let keys = try PushPayloadTests.contractKeys()

    #expect(PushPayload.readKeys.isDisjoint(with: PushPayload.carriedKeys))
    #expect(PushPayload.readKeys.union(PushPayload.carriedKeys) == keys)
  }

  @Test("the types, the unfiltered types, the legacy types and the type enum match the contract")
  func typeLists() throws {
    let contract = try Self.contract()

    #expect(Set(Self.object(contract["unfilteredTypes"]).keys.filter { $0 != "$comment" }) == Set(PushContract.unfilteredTypes))
    #expect(Set(Self.object(contract["legacyTypes"]).keys.filter { $0 != "$comment" }) == Set(PushContract.legacyTypes))
    #expect(Self.strings(try Self.field("type")["enum"]) == PushContract.types + PushContract.unfilteredTypes)

    // None of the unfiltered types is a switch: no row key, no settings entry.
    #expect(Set(PushContract.types).isDisjoint(with: PushContract.unfilteredTypes))

    for type in PushContract.types + PushContract.unfilteredTypes + PushContract.legacyTypes {
      #expect(PushPayload(shape: .relay, data: ["type": .string(type)]).type == type)
    }
  }

  @Test("the enums of the data fields match the cases this build reads")
  func fieldEnums() throws {
    #expect(Self.strings(try Self.field("method")["enum"]) == PushRequestMethod.allCases.map(\.rawValue))
    #expect(Self.strings(try Self.field("level")["enum"]) == PushConfirmLevel.allCases.map(\.rawValue))
    #expect(Self.strings(try Self.field("reason")["enum"]) == PushClearReason.allCases.map(\.rawValue))
    #expect(Self.strings(try Self.field("event")["enum"]) == PushEvent.allCases.map(\.rawValue))
    #expect(Self.strings(try Self.field("change")["enum"]) == PushSecurityChange.allCases.map(\.rawValue))
    #expect(Self.strings(try Self.field("sessionKind")["enum"]) == ["canonical", "branch", "other"])
    #expect(Self.strings(Self.object(try Self.contract()["clear"])["reasons"]) == PushClearReason.allCases.map(\.rawValue))
  }

  @Test("per request method: the request id rule, the actions, the preview rule and the levels match the contract")
  func requestMethods() throws {
    let contract = try Self.contract()
    let methods = Self.array(Self.object(contract["requests"])["methods"])

    #expect(methods.compactMap { $0["method"]?.stringValue } == PushRequestMethod.allCases.map(\.rawValue))

    for entry in methods {
      guard let name = entry["method"]?.stringValue, let method = PushRequestMethod(rawValue: name) else {
        Issue.record("a method this build does not know: \(entry)")
        continue
      }

      #expect(entry["requestId"]?.stringValue == method.requestId.rawValue, "requestId of \(name)")
      #expect(entry["actions"] == .bool(method.offersActions), "actions of \(name)")
      #expect(entry["preview"] == .bool(method.carriesPreview), "preview of \(name)")
      #expect(Self.strings(entry["level"]) == method.levels.map(\.rawValue), "levels of \(name)")
    }

    // `category.notFor` is every method without actions, and the category is for approvals only.
    let category = Self.object(contract["category"])

    #expect(
      Set(Self.strings(Self.object(category["notFor"])["methods"]))
        == Set(PushRequestMethod.allCases.filter { !$0.offersActions }.map(\.rawValue)))
    #expect(Self.object(category["when"])["method"] == .string(PushContract.actionsMethod.rawValue))
    #expect(Self.object(category["when"])["type"] == "request")
  }

  @Test("the requestId rule of the contract: the field names the strict form, the table says whenKnown for an approval")
  func requiredRequestIds() throws {
    let field = try Self.field("requestId")
    var required: Set<String> = []

    for condition in [Self.object(field["requiredWhen"])] + Self.array(field["alsoRequiredWhen"]) {
      if let method = condition["method"]?.stringValue {
        required.insert(method)
      }
    }

    // `requiredWhen` is the strict form (approval included: a sender that always has the id meets
    // it); the table's `required` is the omit-rather-than-send-without rule, and an approval is
    // `whenKnown` there.
    let strict = Set(PushRequestMethod.allCases.filter { $0.requestId == .required }.map(\.rawValue))
    #expect(required == strict.union([PushContract.actionsMethod.rawValue]))
    #expect(PushRequestMethod.approval.requestId == .whenKnown)
    #expect(PushRequestMethod.clarify.requestId == .whenKnown)
  }

  @Test("the channel ids and the unfiltered types' channels match the contract")
  func channels() throws {
    let android = Self.object(try Self.contract()["android"])
    let channels = Self.array(android["channels"])
    let also = Self.array(android["alsoChannels"])

    #expect(channels.compactMap { $0["id"]?.stringValue } == PushContract.channelIds)
    #expect((channels + also).compactMap { $0["id"]?.stringValue } == PushContract.allChannelIds)
    #expect(PushContract.allChannelIds.contains("security"))
    #expect(channels.allSatisfy { $0["id"] == $0["type"] })
    #expect(also.compactMap { $0["id"]?.stringValue } == PushContract.alsoChannelIds)
    #expect(also.allSatisfy { $0["id"] == $0["type"] })
  }

  @Test("the registration row opts in to clearing the way the contract says")
  func clearOptIn() throws {
    let clear = Self.object(try Self.contract()["clear"])
    #expect(clear["optIn"] == .string("registration row field `clears: true`"))
    #expect(PushRows.clearsKey == "clears")
  }

  // MARK: The examples

  static func examples() throws -> [(name: String, data: JSONObject, category: String?, silent: Bool)] {
    let list = Self.array(Self.object(try Self.contract()["examples"])["list"])

    return list.map { example in
      (
        example["name"]?.stringValue ?? "",
        Self.object(example["data"]),
        example["category"]?.stringValue,
        example["silent"] == .bool(true)
      )
    }
  }

  @Test("every example in the contract is read as the payload it describes")
  func examplePayloads() throws {
    let examples = try Self.examples()
    #expect(examples.count >= 17)

    for example in examples {
      let payload = PushPayload(shape: .relay, data: example.data)
      let name = example.name

      // The payload is whole: nothing in the bag was dropped by the reader, and the user-info
      // route (what the system hands the app) reads the same bag.
      #expect(payload.data == example.data, "\(name)")
      #expect(payload.string("type") == payload.type, "the type of \(name) is one the reader knows")
      #expect(payload.bypassesFilters == (payload.type == "security"), "\(name)")
      #expect(payload.eventId != "", "the eventId of \(name)")

      // The category is posted for an approval and for nothing else, and a clear is silent.
      #expect(payload.categoryIdentifier == example.category, "the category of \(name)")
      #expect(payload.wantsActions == (example.category != nil), "\(name)")
      #expect(payload.isClear == example.silent, "silent \(name)")

      if payload.type == "request" {
        #expect(payload.requestMethod != nil, "the method of \(name)")
        #expect(payload.sessionKey != "", "the sessionKey of \(name)")
      }

      if payload.isClear {
        #expect(payload.clearReason != nil, "the reason of \(name)")
        #expect(payload.replaces != "", "the replaces of \(name)")
        #expect(PushClear(payload: payload) != nil, "\(name)")
      }
    }
  }

  @Test("the requestId rule holds in every example: required methods carry one, a clarify may not")
  func exampleRequestIds() throws {
    for example in try Self.examples() {
      let payload = PushPayload(shape: .relay, data: example.data)

      guard let method = payload.requestMethod else {
        continue
      }

      if method.requestId == .required, !payload.isClear {
        #expect(payload.string("requestId") != "", "\(example.name)")
      }
    }

    let bare = try #require(try Self.examples().first { $0.name == "clarify_without_request_id" })
    #expect(PushPayload(shape: .relay, data: bare.data).string("requestId") == "")
  }

  @Test("a tap on each example: approvals answer, confirmations open in the app, nothing else gets an action")
  func exampleTaps() throws {
    for example in try Self.examples() {
      let payload = PushPayload(shape: .relay, data: example.data)

      guard let tap = PushTap(actionIdentifier: "hermie.request.allow", payload: payload) else {
        Issue.record("no tap for \(example.name)")
        continue
      }

      // Allow only means something on an approval that is not a clear.
      #expect(
        (tap.action == .allow) == (example.category != nil && !payload.string("requestId").isEmpty), "\(example.name)")
      #expect(tap.gatewayKey == "bf796761db84e312", "\(example.name)")

      let opens = PushTapRules.openRequest(tap, canonicalIds: [])

      if payload.type == "request", !payload.isClear, payload.requestMethod != .approval {
        #expect(opens?.method == payload.string("method"), "\(example.name)")
        #expect(opens?.requestId == payload.string("requestId"), "\(example.name)")
        #expect(opens?.level == payload.level, "\(example.name)")
        // The stored key opens the conversation, the runtime id never does.
        #expect(opens?.sessionKey == payload.string("sessionKey"), "\(example.name)")
        #expect(opens?.destination == .chat, "\(example.name)")
      } else {
        #expect(opens == nil, "\(example.name)")
      }
    }
  }

  @Test("the confirm examples: the level is read, passkey is proven in the app, and neither has an action")
  func confirmExamples() throws {
    let examples = try Self.examples()

    for (name, level) in [("confirm_passkey", PushConfirmLevel.passkey), ("confirm_plain", .plain)] {
      let example = try #require(examples.first { $0.name == name })
      let payload = PushPayload(shape: .relay, data: example.data)
      let tap = try #require(PushTap(actionIdentifier: "hermie.request.deny", payload: payload))
      let open = try #require(PushTapRules.openRequest(tap, canonicalIds: []))

      #expect(payload.level == level)
      #expect(!payload.wantsActions)
      #expect(tap.action == .open)
      #expect(open.needsDeviceAuthentication == (level == .passkey))
    }
  }

  @Test("the clearing examples withdraw the notifications of the examples they name")
  func clearExamples() throws {
    let examples = try Self.examples()

    func shown(_ name: String) throws -> PushDeliveredNotification {
      let example = try #require(examples.first { $0.name == name })
      return PushDeliveredNotification(identifier: name, payload: PushPayload(shape: .relay, data: example.data))
    }

    func clear(_ name: String) throws -> PushClear {
      let example = try #require(examples.first { $0.name == name })
      return try #require(PushClear(payload: PushPayload(shape: .relay, data: example.data)))
    }

    let everything = try [
      "approval", "approval_runtime_session", "clarify_without_request_id", "clarify", "secret", "sudo", "vault_code",
      "confirm_passkey", "background_complete", "security_added"
    ].map(shown)

    // Answered on another device: the approval, by id (and by event id, the same fact twice).
    #expect(
      Set(PushClearing.identifiers(for: try clear("clear_approval_answered"), among: everything))
        == ["approval", "approval_runtime_session"])
    // Timed out: a clarify seen without a request id, only by `replaces`.
    #expect(PushClearing.identifiers(for: try clear("clear_clarify_timeout"), among: everything) == ["clarify_without_request_id"])
    // Cancelled: a secure input, by id and event.
    #expect(PushClearing.identifiers(for: try clear("clear_secret_cancelled"), among: everything) == ["secret"])
  }

  @Test("the security and background examples: the switch that decides them")
  func securityExamples() throws {
    let examples = try Self.examples()

    for name in ["security_added", "security_added_preview", "security_revoked"] {
      let payload = PushPayload(shape: .relay, data: try #require(examples.first { $0.name == name }).data)

      #expect(payload.type == "security", "\(name)")
      #expect(payload.bypassesFilters, "\(name)")
      #expect(payload.switchType == nil, "\(name)")
      #expect(payload.securityChange != nil, "\(name)")
      #expect(PushFilter.allows(payload, wanted: [:], muted: true), "\(name)")
    }

    let background = PushPayload(shape: .relay, data: try #require(examples.first { $0.name == "background_complete" }).data)
    #expect(background.event == .backgroundComplete)
    #expect(background.switchType == "turn_done")
    #expect(!PushFilter.allows(background, wanted: ["turn_done": false], muted: false))
  }
}
