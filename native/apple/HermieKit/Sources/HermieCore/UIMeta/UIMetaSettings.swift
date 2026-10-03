import Foundation
import HermieProtocol
import HermieTranscript
import Synchronization

/// Every field the app sections carry, as `expo/hermie/src/store/ui-meta-bridge.ts`
/// writes them. The settings bridge below owns five; the chat list and the push
/// rows own the rest and plug in as `UIMetaContributor`s.
///
/// Not synced, on purpose: `sidebarCollapsed` and `conversationsCollapsed` are
/// about the window in front of the reader, and the read watermarks are this
/// device's reading.
public enum UIMetaField {
  // App section: the chat list (folders by id at the top level, then each folder).
  public static let entries = "entries"
  public static let folders = "folders"
  public static let pinned = "pinned"
  public static let myChats = "myChats"
  public static let current = "current"
  public static let labels = "labels"
  public static let mutes = "mutes"
  /// The person's own archive: bot names, sorted, no duplicates. Replaces the bot section's
  /// shared `archived` flag, which is only read once, to seed it.
  public static let archivedBots = "archivedBots"
  // App section: settings.
  public static let defaults = "defaults"
  public static let botNameOrder = "botNameOrder"
  public static let textSize = "textSize"
  public static let themeChoice = "themeChoice"
  public static let themes = "themes"
  // App section: the date and the push rows.
  public static let updatedAt = UIMeta.appUpdatedAt
  public static let push = UIMeta.pushField
  // Bot section. `archived` is no longer written: the archive is per person (`archivedBots`).
  public static let archived = "archived"
  public static let colour = "colour"
}

/// Which of a bot's two names leads (`store/bot-names.ts`).
public enum BotNameOrder: String, Sendable, Hashable, CaseIterable {
  case profile
  case display
}

/// How big the words in a transcript are (`store/text-size.ts`).
public enum TranscriptTextSize: String, Sendable, Hashable, CaseIterable {
  case small
  case standard = "default"
  case large
  case xlarge
}

/// Which theme is in use (`ThemeChoice` in `ui/themes.ts`).
public enum ThemeChoice: Sendable, Hashable {
  case preset(String)
  case user(id: String)

  /// The presets this build knows (`THEME_PRESET_ORDER`).
  public static let presets = ["blue", "graphite", "lime"]
  public static let standard = ThemeChoice.preset("blue")

  public var jsonValue: JSONValue {
    switch self {
    case .preset(let name): ["kind": "preset", "name": .string(name)]
    case .user(let id): ["kind": "user", "id": .string(id)]
    }
  }
}

/// The settings that follow the account through `hermie-app:<user_id>`.
public struct SyncedSettings: Sendable, Hashable {
  public var defaults: VisibilityOptions
  public var botNameOrder: BotNameOrder
  public var textSize: TranscriptTextSize
  public var themeChoice: ThemeChoice
  /// The reader's own themes, each carried raw so a field this build does not
  /// draw (D19) goes back to the gateway as it came.
  public var userThemes: [JSONObject]

  public init(
    defaults: VisibilityOptions = SyncedSettings.defaultChatView,
    botNameOrder: BotNameOrder = .display,
    textSize: TranscriptTextSize = .standard,
    themeChoice: ThemeChoice = .standard,
    userThemes: [JSONObject] = []
  ) {
    self.defaults = defaults
    self.botNameOrder = botNameOrder
    self.textSize = textSize
    self.themeChoice = themeChoice
    self.userThemes = userThemes
  }

  /// `DEFAULT_CHAT_VIEW`.
  public static let defaultChatView = VisibilityOptions(level: .quiet, showBotToBot: true, showThinking: false)
}

/// The fields a gateway's copy carried; `nil` leaves the store's own value.
/// Absent is not wrong: a section written before a field existed says nothing
/// about it, and must not be read as "they chose the other one".
public struct SyncedSettingsPatch: Sendable, Hashable {
  public var defaults: VisibilityOptions?
  public var botNameOrder: BotNameOrder?
  public var textSize: TranscriptTextSize?
  public var themeChoice: ThemeChoice?
  public var userThemes: [JSONObject]?

  public init(
    defaults: VisibilityOptions? = nil,
    botNameOrder: BotNameOrder? = nil,
    textSize: TranscriptTextSize? = nil,
    themeChoice: ThemeChoice? = nil,
    userThemes: [JSONObject]? = nil
  ) {
    self.defaults = defaults
    self.botNameOrder = botNameOrder
    self.textSize = textSize
    self.themeChoice = themeChoice
    self.userThemes = userThemes
  }

  /// Read the five fields out of an app section, defensively: it came off a
  /// wire another build wrote (`applySnapshot`'s rules).
  public init(app: JSONObject) {
    self.init(
      defaults: Self.defaults(app[UIMetaField.defaults]),
      botNameOrder: app[UIMetaField.botNameOrder]?.stringValue.flatMap(BotNameOrder.init(rawValue:)),
      textSize: app[UIMetaField.textSize]?.stringValue.flatMap(TranscriptTextSize.init(rawValue:)),
      themeChoice: Self.themeChoice(app[UIMetaField.themeChoice]),
      userThemes: Self.userThemes(app[UIMetaField.themes])
    )
  }

  /// True when the patch carries no field at all.
  public var isEmpty: Bool {
    self == SyncedSettingsPatch()
  }

  /// The fields of this patch whose value differs from `settings`.
  public func changes(from settings: SyncedSettings) -> SyncedSettingsPatch {
    SyncedSettingsPatch(
      defaults: defaults == settings.defaults ? nil : defaults,
      botNameOrder: botNameOrder == settings.botNameOrder ? nil : botNameOrder,
      textSize: textSize == settings.textSize ? nil : textSize,
      themeChoice: themeChoice == settings.themeChoice ? nil : themeChoice,
      userThemes: userThemes == settings.userThemes ? nil : userThemes
    )
  }

  /// `chatViewOf`: any object (an array is one too, to the reference), each
  /// field read on its own with the default for a value it does not know.
  static func defaults(_ value: JSONValue?) -> VisibilityOptions? {
    let raw: JSONObject

    switch value {
    case .object(let object)?: raw = object
    case .array?: raw = [:]
    default: return nil
    }

    let fallback = SyncedSettings.defaultChatView
    let level: Verbosity =
      switch raw["level"]?.stringValue {
      case "quiet"?: .quiet
      case "normal"?: .normal
      case "verbose"?: .verbose
      default: fallback.level
      }

    return VisibilityOptions(
      level: level,
      showBotToBot: raw["showBotToBot"]?.boolValue ?? fallback.showBotToBot,
      showThinking: raw["showThinking"]?.boolValue ?? fallback.showThinking
    )
  }

  /// `asThemeChoice`: a preset this build knows, or a user theme with an id.
  static func themeChoice(_ value: JSONValue?) -> ThemeChoice? {
    guard case .object(let raw)? = value else {
      return nil
    }

    if raw["kind"] == "preset", let name = raw["name"]?.stringValue, ThemeChoice.presets.contains(name) {
      return .preset(name)
    }

    if raw["kind"] == "user", let id = raw["id"]?.stringValue, !id.isEmpty {
      return .user(id: id)
    }

    return nil
  }

  /// `asUserThemes`, filtering as the reference does (an id, unique, on a known
  /// base) but keeping each entry whole.
  static func userThemes(_ value: JSONValue?) -> [JSONObject]? {
    guard case .array(let entries)? = value else {
      return nil
    }

    var seen = Set<String>()

    return entries.compactMap { entry -> JSONObject? in
      guard case .object(let raw) = entry, let id = raw["id"]?.stringValue, !id.isEmpty, !seen.contains(id),
        let base = raw["base"]?.stringValue, ThemeChoice.presets.contains(base)
      else {
        return nil
      }

      seen.insert(id)
      return raw
    }
  }
}

/// The device's settings model, as far as the sync needs it. A small protocol
/// because the native settings model is not there yet (M2-H); `InMemorySettingsStore`
/// stands in for it. Async, so a main-actor model conforms as it is.
public protocol SettingsStore: AnyObject, Sendable {
  /// What the store holds now.
  var syncedSettings: SyncedSettings { get async }
  /// Take the fields a gateway's copy carried; `nil` fields stay as they are.
  func applySynced(_ patch: SyncedSettingsPatch) async
}

extension SyncedSettings {
  /// These settings with a patch's fields taken over.
  public func applying(_ patch: SyncedSettingsPatch) -> SyncedSettings {
    var settings = self
    if let defaults = patch.defaults { settings.defaults = defaults }
    if let botNameOrder = patch.botNameOrder { settings.botNameOrder = botNameOrder }
    if let textSize = patch.textSize { settings.textSize = textSize }
    if let themeChoice = patch.themeChoice { settings.themeChoice = themeChoice }
    if let userThemes = patch.userThemes { settings.userThemes = userThemes }
    return settings
  }
}

/// The settings half of `UiMetaBridge`: `SyncedSettings` onto the app section and back.
///
/// - **Projects** the five fields into `hermie-app:<user_id>`, writing only the
///   ones that moved, so whatever else the section carries goes back untouched.
/// - **Notices** by diffing: `settingsDidChange` compares the store with what it
///   last saw, whoever changed it and however.
/// - **Does not echo**: it is deaf while a gateway's copy goes into the store, and
///   what it then remembers is what it applied, so the store's own notification
///   of that change is no change at all. A change the reader made meanwhile is
///   looked at once the copy is in. The debounce is the sync's.
public actor UIMetaSettingsBridge: UIMetaContributor {
  private let store: any SettingsStore
  private let sync: UIMetaSync
  /// What the store held when this bridge last looked, or applied. `nil` until started.
  private var seen: SyncedSettings?
  /// How many gateway copies are going into the store right now. A count, not a
  /// flag: two copies can be in flight on this reentrant actor, and the first
  /// one finishing must not make the bridge hear the second as a choice.
  private var applying = 0
  private var changedWhileApplying = false

  public init(store: any SettingsStore, sync: UIMetaSync) {
    self.store = store
    self.sync = sync
  }

  /// Load the device's copy, write what the store holds as this device's
  /// baseline (not a choice, not sent now, but what a gateway with no section is
  /// seeded from), then register. Call once, after the store has read its own
  /// disk; the caller keeps the bridge alive (the sync holds it weakly).
  public func start() async {
    await sync.load()

    let current = await store.syncedSettings
    seen = current

    sync.updateApp(.baseline) { app in
      Self.write(current, into: &app, over: Self.baselineHeld(app, current))
    }

    sync.register(self)
  }

  /// The store changed. What moved is a choice: sent, and the section is dated.
  public func settingsDidChange() async {
    while true {
      if applying > 0 {
        changedWhileApplying = true
        return
      }

      // Not started: there is nothing to diff against.
      guard let previous = seen else {
        return
      }

      let current = await store.syncedSettings

      // A copy went in while the store was being read: diff against that.
      guard applying == 0, seen == previous else {
        continue
      }

      guard current != previous else {
        return
      }

      seen = current
      sync.updateApp(.choice) { app in
        Self.write(current, into: &app, over: Self.patch(previous))
      }
      return
    }
  }

  public func didApply(_ documents: UIMetaDocuments, snapshot: UIMetaSnapshot) async {
    // The section as the sync holds it NOW, not the copy handed over: a choice
    // made between the take and this call is in it, and diffing the older copy
    // would put the value that choice replaced back on the screen. No section at
    // all says nothing about any setting.
    guard let app = sync.app, let held = seen else {
      return
    }

    // Only what the gateway's copy actually changes: a store that applies later
    // than asked must not have a change the reader made meanwhile overwritten
    // with the value it replaced.
    let patch = SyncedSettingsPatch(app: app).changes(from: held)

    guard !patch.isEmpty else {
      return
    }

    applying += 1
    await store.applySynced(patch)
    // Read again after the await: another copy may have gone in meanwhile.
    seen = (seen ?? held).applying(patch)
    applying -= 1

    if applying == 0, changedWhileApplying {
      changedWhileApplying = false
      await settingsDidChange()
    }
  }

  /// What the baseline writes over: the parsed section, except that a value
  /// present but unreadable to this build (a newer build's size, say) counts as
  /// held, so a launch never replaces it with the store's.
  private static func baselineHeld(_ app: JSONObject, _ current: SyncedSettings) -> SyncedSettingsPatch {
    var held = SyncedSettingsPatch(app: app)
    let present: (String) -> Bool = { app[$0] != nil && app[$0] != .null }

    if held.defaults == nil, present(UIMetaField.defaults) { held.defaults = current.defaults }
    if held.botNameOrder == nil, present(UIMetaField.botNameOrder) { held.botNameOrder = current.botNameOrder }
    if held.textSize == nil, present(UIMetaField.textSize) { held.textSize = current.textSize }
    if held.themeChoice == nil, present(UIMetaField.themeChoice) { held.themeChoice = current.themeChoice }
    if held.userThemes == nil, present(UIMetaField.themes) { held.userThemes = current.userThemes }

    return held
  }

  /// Every field as a patch, for diffing one value of the store against another.
  private static func patch(_ settings: SyncedSettings) -> SyncedSettingsPatch {
    SyncedSettingsPatch(
      defaults: settings.defaults,
      botNameOrder: settings.botNameOrder,
      textSize: settings.textSize,
      themeChoice: settings.themeChoice,
      userThemes: settings.userThemes
    )
  }

  /// Write each field of `settings` that differs from `held`; leave the rest raw.
  private static func write(_ settings: SyncedSettings, into app: inout JSONObject, over held: SyncedSettingsPatch) {
    if held.defaults != settings.defaults {
      app[UIMetaField.defaults] = [
        "level": .string(settings.defaults.level.rawValue),
        "showBotToBot": .bool(settings.defaults.showBotToBot),
        "showThinking": .bool(settings.defaults.showThinking)
      ]
    }

    if held.botNameOrder != settings.botNameOrder {
      app[UIMetaField.botNameOrder] = .string(settings.botNameOrder.rawValue)
    }

    if held.textSize != settings.textSize {
      app[UIMetaField.textSize] = .string(settings.textSize.rawValue)
    }

    if held.themeChoice != settings.themeChoice {
      app[UIMetaField.themeChoice] = settings.themeChoice.jsonValue
    }

    if held.userThemes != settings.userThemes {
      app[UIMetaField.themes] = .array(settings.userThemes.map(JSONValue.object))
    }
  }
}

/// `SettingsStore` in memory, until the native settings model exists.
public final class InMemorySettingsStore: SettingsStore {
  private let value: Mutex<SyncedSettings>

  public init(_ settings: SyncedSettings = SyncedSettings()) {
    value = Mutex(settings)
  }

  public var syncedSettings: SyncedSettings {
    get { value.withLock { $0 } }
    set { value.withLock { $0 = newValue } }
  }

  public func applySynced(_ patch: SyncedSettingsPatch) {
    value.withLock { $0 = $0.applying(patch) }
  }
}
