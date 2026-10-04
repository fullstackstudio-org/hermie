import Foundation
import HermieProtocol
import HermieStore
import HermieTranscript
import Observation

/// Light, dark, or whatever the device is on (`Appearance` in the Expo app's `store/settings.ts`).
public enum AppearanceChoice: String, Sendable, Hashable, CaseIterable {
  case system
  case light
  case dark
}

/**
 The reader's settings, in the two halves the Expo app keeps apart.

 - **This device's** (`scheme`, `transcriptCache`): about the eyes in front of the screen and the
   disk in the device, not about an account. Whatever gateway is live, and after a sign-out, they
   stay. The scheme lives in the Expo app's own `hermie.appearance` blob (`StoreKeys.appearance`),
   so an import finds it; the cache switch in `StoreKeys.transcriptCache`.
 - **The account's** (`synced`: the default chat view, the name order, the chat text size and the
   theme): they follow the person to every device through the app section of ui_meta. This model is
   the device's one copy of them. `UIMetaSettingsBridge` carries it to and from the live gateway
   (`SettingsStore`), and a mirror in the key-value store (`StoreKeys.syncedSettings`) keeps the last
   value this device held, so a launch is right from its first frame, before a gateway has answered
   and without one.

 Every change takes effect at once for whoever reads this model (it is observable), and is written
 to the store in order, one write after the other, so the last choice is the one that survives.
 Nothing here reads what was stored with a guess: a value that does not decode is left where it is
 and the default is used for this launch.

 The model is read before the launch is ready (`hydrate()`); a choice made before that wins over
 what was stored.
 */
@MainActor
@Observable
public final class AppSettings: SettingsStore {
  /// Light, dark or the device's own. Device-wide.
  public private(set) var scheme = AppearanceChoice.system
  /// Whether this device keeps the transcripts it has read. On unless the reader switched it off.
  public private(set) var transcriptCache = true
  /// The settings that follow the account.
  public private(set) var synced = SyncedSettings()
  /// `hydrate()` has finished.
  public private(set) var loaded = false

  /// What the chat cache reads, from any thread (`GatedChatCache`).
  @ObservationIgnored public let cacheSwitch = ChatCacheSwitch()

  @ObservationIgnored private let keyValues: KeyValueStore?
  @ObservationIgnored private let store: SQLiteStore?
  /// The rest of the `hermie.appearance` blob (the Expo app keeps its own fields in it): written
  /// back as it was found.
  @ObservationIgnored private var appearanceRest: JSONObject = [:]
  /// What was chosen before `hydrate()` finished, so the read does not overwrite it.
  @ObservationIgnored private var chosenBeforeLoad: Set<String> = []
  /// The last write, so the next one starts after it.
  @ObservationIgnored private var writing: Task<Void, Never>?

  private static let appearanceField = "appearance"

  /// - Parameters:
  ///   - keyValues: where the choices are kept; nil keeps them in memory (tests, previews).
  ///   - store: the database "clear the cache" empties; nil has nothing to clear.
  public init(keyValues: KeyValueStore? = nil, store: SQLiteStore? = nil) {
    self.keyValues = keyValues
    self.store = store
  }

  // MARK: Reading from the store

  /// Read what the device kept. Idempotent; the launch calls it before anything is shown.
  public func hydrate() async {
    guard !loaded else {
      return
    }

    if let keyValues {
      let appearance = try? await keyValues.value(JSONObject.self, forKey: StoreKeys.appearance)
      let cache = try? await keyValues.string(forKey: StoreKeys.transcriptCache)
      let mirror = try? await keyValues.value(JSONObject.self, forKey: StoreKeys.syncedSettings)

      if var appearance {
        let stored = appearance.removeValue(forKey: Self.appearanceField)?.stringValue
        appearanceRest = appearance

        if !chosenBeforeLoad.contains(StoreKeys.appearance) {
          scheme = stored.flatMap(AppearanceChoice.init(rawValue:)) ?? .system
        }
      }

      if !chosenBeforeLoad.contains(StoreKeys.transcriptCache) {
        transcriptCache = cache != "false"
      }

      if let mirror, !chosenBeforeLoad.contains(StoreKeys.syncedSettings) {
        synced = SyncedSettings().applying(SyncedSettingsPatch(app: mirror))
      }
    }

    cacheSwitch.isEnabled = transcriptCache
    loaded = true
    chosenBeforeLoad = []
  }

  // MARK: This device's choices

  public func setScheme(_ choice: AppearanceChoice) {
    guard choice != scheme else {
      return
    }

    scheme = choice
    chosenBeforeLoad.insert(StoreKeys.appearance)

    var blob = appearanceRest
    blob[Self.appearanceField] = .string(choice.rawValue)

    let written = blob
    persist { try await $0.set(written, forKey: StoreKeys.appearance) }
  }

  /// Switch the transcript cache on or off. Switching it off does not clear what is stored: that is
  /// `clearTranscriptCache()`, which the page calls with it (a setting that stopped new copies and
  /// left the old ones would not mean what it says).
  public func setTranscriptCache(_ enabled: Bool) {
    guard enabled != transcriptCache else {
      return
    }

    transcriptCache = enabled
    cacheSwitch.isEnabled = enabled
    chosenBeforeLoad.insert(StoreKeys.transcriptCache)

    // Only the departure from the default is stored.
    persist { keyValues in
      if enabled {
        try await keyValues.removeValue(forKey: StoreKeys.transcriptCache)
      } else {
        try await keyValues.setString("false", forKey: StoreKeys.transcriptCache)
      }
    }
  }

  /// Empty the cached rosters and transcripts of every gateway. What the live chats hold in memory
  /// is not touched. Throws when the database refuses, or there is none.
  public func clearTranscriptCache() async throws {
    guard let store else {
      throw CocoaError(.fileNoSuchFile)
    }

    try await store.clearAllChatCaches()
  }

  // MARK: The account's choices

  /// The view a conversation without a setting of its own starts at.
  public func setDefaults(_ options: VisibilityOptions) {
    update { $0.defaults = options }
  }

  public func setTextSize(_ size: TranscriptTextSize) {
    update { $0.textSize = size }
  }

  public func setBotNameOrder(_ order: BotNameOrder) {
    update { $0.botNameOrder = order }
  }

  public func setThemeChoice(_ choice: ThemeChoice) {
    update { $0.themeChoice = choice }
  }

  private func update(_ change: (inout SyncedSettings) -> Void) {
    var next = synced
    change(&next)

    guard next != synced else {
      return
    }

    synced = next
    chosenBeforeLoad.insert(StoreKeys.syncedSettings)

    let fields = next.appFields
    persist { try await $0.set(fields, forKey: StoreKeys.syncedSettings) }
  }

  // MARK: SettingsStore (the ui_meta bridge)

  public var syncedSettings: SyncedSettings {
    get async { synced }
  }

  public func applySynced(_ patch: SyncedSettingsPatch) async {
    update { $0 = $0.applying(patch) }
  }

  // MARK: Writing

  /// Write after the write before it. A failure leaves the choice in force for this launch.
  private func persist(_ write: @escaping @Sendable (KeyValueStore) async throws -> Void) {
    guard let keyValues else {
      return
    }

    let before = writing

    writing = Task {
      await before?.value
      try? await write(keyValues)
    }
  }

  /// Wait for every write started so far (tests; the app never needs to).
  public func settled() async {
    await writing?.value
  }
}
