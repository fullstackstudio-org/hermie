import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

struct BotNamesTests {
  private let display = BotNamePolicy(order: .display, hideHandle: false)
  private let profile = BotNamePolicy(order: .profile, hideHandle: false)
  private let hidden = BotNamePolicy(order: .display, hideHandle: true)

  @Test func theNameLeadsAndTheHandleIsUnderItByDefault() {
    let names = BotNames.of(handle: "lance-vance", displayName: "Netwerkbeheerder")

    #expect(names == BotNames(primary: "Netwerkbeheerder", secondary: "lance-vance"))
    #expect(BotNamePolicy.standard == display)
  }

  @Test func theHandleCanLeadInstead() {
    #expect(
      BotNames.of(handle: "lance-vance", displayName: "Netwerkbeheerder", policy: profile)
        == BotNames(primary: "lance-vance", secondary: "Netwerkbeheerder"))
  }

  @Test func theNameTheReaderGaveWinsOverTheGatewaysAndAnEmptyOneIsNotAName() {
    #expect(
      BotNames.of(handle: "ops", displayName: "Operations", label: "De Beheerder")
        == BotNames(primary: "De Beheerder", secondary: "ops"))
    #expect(
      BotNames.of(handle: "ops", displayName: "Operations", label: "   ")
        == BotNames(primary: "Operations", secondary: "ops"), "clearing the field falls back, it does not blank the row")
  }

  @Test func aBotWithOneNameHasOneLine() {
    // No display name at all, the roster's fallback (a copy of the handle), and the same word capitalised.
    #expect(BotNames.of(handle: "researcher", displayName: "") == BotNames(primary: "researcher"))
    #expect(BotNames.of(handle: "researcher", displayName: "researcher") == BotNames(primary: "researcher"))
    #expect(BotNames.of(handle: "researcher", displayName: " Researcher ") == BotNames(primary: "researcher"))
    #expect(BotNames.of(handle: "researcher", displayName: "Researcher", policy: profile) == BotNames(primary: "researcher"))
  }

  @Test func hidingTheHandleLeavesTheNameAloneWhateverTheOrder() {
    for order in BotNameOrder.allCases {
      let policy = BotNamePolicy(order: order, hideHandle: true)

      #expect(
        BotNames.of(handle: "lance-vance", displayName: "Netwerkbeheerder", policy: policy)
          == BotNames(primary: "Netwerkbeheerder"))
      #expect(
        BotNames.of(handle: "ops", displayName: "", label: "De Beheerder", policy: policy)
          == BotNames(primary: "De Beheerder"))
    }
  }

  @Test func hidingTheHandleDoesNotInventANameForABotWithoutOne() {
    #expect(BotNames.of(handle: "ops", displayName: "", policy: hidden) == BotNames(primary: "ops"))
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct HideHandleSettingTests {
  private func open() throws -> (store: SQLiteStore, keyValues: KeyValueStore) {
    let store = try SQLiteStore(.inMemory)
    return (store, KeyValueStore(store: store))
  }

  @Test func itLivesInTheExpoAppsAppearanceBlobBesideTheSchemeAndKeepsItsOtherFields() async throws {
    let opened = try open()
    try await opened.keyValues.setString(
      #"{"appearance":"light","hideHandleWhenNamed":true,"somethingElse":3}"#, forKey: StoreKeys.appearance)

    let settings = AppSettings(keyValues: opened.keyValues, store: opened.store)
    await settings.hydrate()
    #expect(settings.hideHandleWhenNamed)
    #expect(settings.scheme == .light)
    #expect(settings.botNamePolicy == BotNamePolicy(order: .display, hideHandle: true))

    settings.setHideHandleWhenNamed(false)
    await settings.settled()
    let stored = try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance)
    #expect(stored == ["appearance": "light", "hideHandleWhenNamed": false, "somethingElse": 3])

    settings.setScheme(.dark)
    await settings.settled()
    #expect(
      try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance)
        == ["appearance": "dark", "hideHandleWhenNamed": false, "somethingElse": 3], "the scheme keeps the handle switch")

    let again = AppSettings(keyValues: opened.keyValues, store: opened.store)
    await again.hydrate()
    #expect(!again.hideHandleWhenNamed)
    #expect(again.scheme == .dark)
  }

  @Test func offIsTheDefaultAndTheSameAnswerWritesNothing() async throws {
    let opened = try open()
    let settings = AppSettings(keyValues: opened.keyValues, store: opened.store)
    await settings.hydrate()
    #expect(!settings.hideHandleWhenNamed)

    settings.setHideHandleWhenNamed(false)
    await settings.settled()
    #expect(try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance) == nil)

    settings.setHideHandleWhenNamed(true)
    await settings.settled()
    #expect(try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance)?["hideHandleWhenNamed"] == true)
  }

  @Test func theOrderIsTheAccountsAndFollowsIntoThePolicy() async throws {
    let settings = AppSettings()
    await settings.hydrate()

    settings.setBotNameOrder(.profile)

    #expect(settings.botNamePolicy == BotNamePolicy(order: .profile, hideHandle: false))
  }

  @Test func aChoiceMadeBeforeTheReadSurvivesIt() async throws {
    let opened = try open()
    try await opened.keyValues.setString(#"{"appearance":"light","hideHandleWhenNamed":true}"#, forKey: StoreKeys.appearance)
    let settings = AppSettings(keyValues: opened.keyValues, store: opened.store)

    settings.setHideHandleWhenNamed(false)
    settings.setHideHandleWhenNamed(true)
    settings.setHideHandleWhenNamed(false)
    await settings.hydrate()

    #expect(!settings.hideHandleWhenNamed, "the stored true does not overwrite what was chosen while it was read")
  }
}

@MainActor
struct BotNamesSessionTests {
  @Test func aSessionNamesBotsByThePolicyItWasGiven() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let session = harness.session
    let named: JSONValue = [
      "profiles": [["name": "ops", "display_name": "Operations", "canonical_session": ["id": "stored-1"]]]
    ]
    harness.link.respond(to: RPC.ProfilesList.name, with: named)
    _ = try await session.roster.refresh()
    try await eventually("the roster row") { await MainActor.run { session.chatList.rows["ops"] != nil } }

    #expect(session.botNames("ops") == BotNames(primary: "Operations", secondary: "ops"))
    #expect(session.chatName("ops") == "Operations")

    session.setBotNamePolicy(BotNamePolicy(order: .profile, hideHandle: false))
    #expect(session.botNames("ops") == BotNames(primary: "ops", secondary: "Operations"))
    #expect(session.chatName("ops") == "ops")

    session.setBotNamePolicy(BotNamePolicy(order: .profile, hideHandle: true))
    #expect(session.botNames("ops") == BotNames(primary: "Operations"))

    // A bot the roster does not know is its handle.
    #expect(session.chatName("gone") == "gone")
    await session.shutdown()
  }
}
