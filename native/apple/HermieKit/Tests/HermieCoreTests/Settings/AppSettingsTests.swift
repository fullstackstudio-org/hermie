import Foundation
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// The reader's settings: what is device-wide, what follows the account, and what is written.
@Suite(.timeLimit(.minutes(1))) @MainActor struct AppSettingsTests {
  private func open() throws -> (store: SQLiteStore, keyValues: KeyValueStore) {
    let store = try SQLiteStore(.inMemory)
    return (store, KeyValueStore(store: store))
  }

  private func makeSettings(_ opened: (store: SQLiteStore, keyValues: KeyValueStore)) -> AppSettings {
    AppSettings(keyValues: opened.keyValues, store: opened.store)
  }

  @Test func startsOnTheDefaults() async throws {
    let settings = makeSettings(try open())
    await settings.hydrate()

    #expect(settings.loaded)
    #expect(settings.scheme == .system)
    #expect(settings.transcriptCache)
    #expect(settings.cacheSwitch.isEnabled)
    #expect(settings.synced == SyncedSettings())
    #expect(settings.synced.defaults == VisibilityOptions(level: .quiet, showBotToBot: true, showThinking: false))
  }

  // MARK: This device's

  @Test func theSchemeLivesInTheExpoAppsAppearanceBlobAndKeepsItsOtherFields() async throws {
    let opened = try open()
    try await opened.keyValues.setString(#"{"appearance":"light","hideHandleWhenNamed":false}"#, forKey: StoreKeys.appearance)

    let settings = makeSettings(opened)
    await settings.hydrate()
    #expect(settings.scheme == .light)

    settings.setScheme(.dark)
    #expect(settings.scheme == .dark)
    await settings.settled()

    let stored = try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance)
    #expect(stored == ["appearance": "dark", "hideHandleWhenNamed": false])

    let again = makeSettings(opened)
    await again.hydrate()
    #expect(again.scheme == .dark)
  }

  @Test func anUnknownSchemeIsTheDevicesOwn() async throws {
    let opened = try open()
    try await opened.keyValues.setString(#"{"appearance":"sepia"}"#, forKey: StoreKeys.appearance)

    let settings = makeSettings(opened)
    await settings.hydrate()

    #expect(settings.scheme == .system)
  }

  @Test func theTranscriptCacheStoresOnlyTheDepartureFromTheDefault() async throws {
    let opened = try open()
    let settings = makeSettings(opened)
    await settings.hydrate()

    settings.setTranscriptCache(false)
    #expect(!settings.transcriptCache)
    #expect(!settings.cacheSwitch.isEnabled, "the cache reads the switch, from any thread")
    await settings.settled()
    #expect(try await opened.keyValues.string(forKey: StoreKeys.transcriptCache) == "false")

    let restarted = makeSettings(opened)
    await restarted.hydrate()
    #expect(!restarted.transcriptCache)
    #expect(!restarted.cacheSwitch.isEnabled)

    restarted.setTranscriptCache(true)
    await restarted.settled()
    #expect(try await opened.keyValues.string(forKey: StoreKeys.transcriptCache) == nil)
  }

  @Test func clearingTheCacheEmptiesEveryGatewaysRosterAndTranscripts() async throws {
    let opened = try open()
    let settings = makeSettings(opened)
    let transcript = CachedTranscript(bot: "a", itemsJSON: "[]", lastRowId: 1, lastSeq: 2, epoch: nil, updatedAt: 3)
    let one = SQLiteChatCache(store: opened.store, gatewayId: "g1")
    let other = SQLiteChatCache(store: opened.store, gatewayId: "g2")

    for cache in [one, other] {
      try await cache.write(transcript)
      try await cache.writeBots([CachedBot(name: "a", json: "{}", avatarRevision: 0, updatedAt: 1)])
    }

    try await settings.clearTranscriptCache()

    for cache in [one, other] {
      #expect(try await cache.read(bot: "a") == nil)
      #expect(try await cache.readBots().isEmpty)
    }
  }

  @Test func clearingWithoutADatabaseSaysSo() async {
    let settings = AppSettings()

    await #expect(throws: (any Error).self) { try await settings.clearTranscriptCache() }
  }

  // MARK: The account's

  @Test func theAccountsSettingsAreMirroredAndComeBackOnTheNextLaunch() async throws {
    let opened = try open()
    let settings = makeSettings(opened)
    await settings.hydrate()

    let defaults = VisibilityOptions(level: .verbose, showBotToBot: false, showThinking: true)
    settings.setDefaults(defaults)
    settings.setTextSize(.large)
    settings.setThemeChoice(.preset("lime"))
    settings.setBotNameOrder(.profile)
    await settings.settled()

    #expect(settings.synced.defaults == defaults)

    let restarted = makeSettings(opened)
    await restarted.hydrate()
    #expect(restarted.synced.defaults == defaults)
    #expect(restarted.synced.textSize == .large)
    #expect(restarted.synced.themeChoice == .preset("lime"))
    #expect(restarted.synced.botNameOrder == .profile)
  }

  @Test func theMirrorCarriesTheReadersOwnThemesWhole() async throws {
    let opened = try open()
    let theme: JSONObject = ["id": "t1", "name": "Studio", "base": "lime", "dark": ["accentBubble": "#336699", "future": 1]]
    let settings = makeSettings(opened)
    await settings.hydrate()

    await settings.applySynced(SyncedSettingsPatch(themeChoice: .user(id: "t1"), userThemes: [theme]))
    await settings.settled()

    let restarted = makeSettings(opened)
    await restarted.hydrate()
    #expect(restarted.synced.themeChoice == .user(id: "t1"))
    #expect(restarted.synced.userThemes == [theme])
  }

  @Test func aGatewaysCopyChangesOnlyTheFieldsItCarries() async throws {
    let settings = makeSettings(try open())
    await settings.hydrate()
    settings.setTextSize(.xlarge)
    settings.setDefaults(VisibilityOptions(level: .normal, showBotToBot: true, showThinking: false))

    await settings.applySynced(SyncedSettingsPatch(themeChoice: .preset("graphite")))

    #expect(settings.synced.themeChoice == .preset("graphite"))
    #expect(settings.synced.textSize == .xlarge)
    #expect(settings.synced.defaults.level == .normal)
    #expect(await settings.syncedSettings == settings.synced)
  }

  @Test func theDevicesChoicesAreNotTheAccountsAndTheOtherWayAround() async throws {
    let opened = try open()
    let settings = makeSettings(opened)
    await settings.hydrate()

    settings.setScheme(.dark)
    settings.setTranscriptCache(false)
    await settings.settled()

    // The scheme and the cache switch are not in what the bridge sends.
    #expect(settings.synced == SyncedSettings())
    #expect(try await opened.keyValues.string(forKey: StoreKeys.syncedSettings) == nil)
  }

  @Test func aChoiceMadeBeforeTheStoreWasReadWinsOverWhatWasStored() async throws {
    let opened = try open()
    try await opened.keyValues.setString(#"{"appearance":"light"}"#, forKey: StoreKeys.appearance)

    let settings = makeSettings(opened)
    settings.setScheme(.dark)
    await settings.hydrate()

    #expect(settings.scheme == .dark)
    await settings.settled()
    #expect(try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.appearance) == ["appearance": "dark"])
  }

  @Test func writesGoOutInTheOrderTheChoicesWereMade() async throws {
    let opened = try open()
    let settings = makeSettings(opened)
    await settings.hydrate()

    for size in [TranscriptTextSize.large, .small, .xlarge, .standard, .large] {
      settings.setTextSize(size)
    }

    await settings.settled()

    let restarted = makeSettings(opened)
    await restarted.hydrate()
    #expect(restarted.synced.textSize == .large, "the last choice is the one that survives")
  }

  @Test func aStoredValueThatDoesNotDecodeIsLeftWhereItIs() async throws {
    let opened = try open()
    try await opened.keyValues.setString("not json", forKey: StoreKeys.syncedSettings)
    try await opened.keyValues.setString("[1,2]", forKey: StoreKeys.appearance)

    let settings = makeSettings(opened)
    await settings.hydrate()

    #expect(settings.synced == SyncedSettings())
    #expect(settings.scheme == .system)
    #expect(try await opened.keyValues.string(forKey: StoreKeys.syncedSettings) == "not json")
  }

  // MARK: Through the sync

  @Test func theBridgeCarriesAChoiceToTheGateway() async throws {
    let gateway = HoldingGateway()
    let settings = makeSettings(try open())
    await settings.hydrate()

    let sync = UIMetaSync.device(gateway.gateway, persistence: MemoryPersistence(), debounce: .zero, clock: TestWallClock(noon))
    let bridge = UIMetaSettingsBridge(store: settings, sync: sync)
    await bridge.start()
    #expect(!sync.pending, "the device's baseline is not a choice")

    settings.setTextSize(.large)
    await bridge.settingsDidChange()

    #expect(sync.app?["textSize"] == "large")
    #expect(sync.pending, "a reader's choice is sent")
  }

  @Test func theBridgeReadsAGatewaysCopyIntoTheModel() async throws {
    let gateway = HoldingGateway()
    gateway.write("researcher", [ownerKey: [
      "v": 1,
      "defaults": ["level": "verbose", "showBotToBot": false, "showThinking": true],
      "textSize": "xlarge",
      "themeChoice": ["kind": "preset", "name": "graphite"]
    ]])

    let opened = try open()
    let settings = makeSettings(opened)
    await settings.hydrate()

    let sync = UIMetaSync.device(gateway.gateway, persistence: MemoryPersistence(), debounce: .zero, clock: TestWallClock(noon))
    let bridge = UIMetaSettingsBridge(store: settings, sync: sync)
    await bridge.start()
    await sync.reconcile()

    #expect(settings.synced.themeChoice == .preset("graphite"))
    #expect(settings.synced.textSize == .xlarge)
    #expect(settings.synced.defaults == VisibilityOptions(level: .verbose, showBotToBot: false, showThinking: true))

    // What came from the gateway is also what the device remembers for the next launch.
    await settings.settled()

    let restarted = makeSettings(opened)
    await restarted.hydrate()
    #expect(restarted.synced == settings.synced)
  }
}
