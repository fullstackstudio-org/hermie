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

  @Test("every data key the contract lists is one the payload reader knows about")
  func dataKeys() throws {
    guard case .object(let data)? = try Self.contract()["data"], case .array(let fields)? = data["fields"] else {
      Issue.record("no data fields")
      return
    }

    let keys = fields.compactMap { field -> String? in
      if case .object(let object) = field, case .string(let key)? = object["key"] { key } else { nil }
    }

    #expect(Set(keys) == PushPayloadTests.contractKeys)
  }
}
