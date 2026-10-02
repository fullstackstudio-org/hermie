import Foundation
import HermieProtocol

/// ADR-0016's keys and the pure functions over one section, ported from
/// `packages/gateway-client/src/ui-meta.ts` (vectors: `contract/gateway/vectors/ui-meta.json`).
///
/// `ui_meta` is a free-form object on a profile row with a revision counter per
/// TOP-LEVEL KEY, and `profiles.configure` is a per-key compare-and-swap over it.
/// So a write names only the keys it changes (the `hermes-bots` marker belongs
/// to another tool), a section is replaced whole, and the last writer wins per
/// section, guarded by the revision.
public enum UIMeta {
  /// That bot's profile: everything about one conversation (`archived`, `colour`).
  public static let botKey = "hermie"

  /// The anonymous app-wide key on the default profile: the LEGACY key. Read once
  /// to seed a person who has no key of their own, and otherwise only written as
  /// the push home on a gateway whose notifier cannot read a per-person key.
  public static let legacyAppKey = "hermie-app"

  /// The marker another tool owns. Named so a test can say it is still there.
  public static let botMarkerKey = "hermes-bots"

  /// The gateway plugin's advert. Read-only here: nothing in this client writes it.
  public static let pluginKey = "hermie-plugin"

  /// The plugin capability that says the notifier reads `hermie-app:<user_id>`.
  public static let perUserCapability = "ui_meta.per_user"

  /// Schema version of the per-bot section. A writer never lowers it.
  public static let botSectionVersion = 1

  /// Schema version of the app-wide section. Adding a field NEVER bumps it
  /// (ADR-0016, amendment of 2026-09-22): a reader that meets a greater `v`
  /// re-seeds the section from its own copy, so a bump would hand every older
  /// build the power to delete the arrangement.
  public static let appSectionVersion = 1

  /// When the app-wide section was last CHOSEN, in seconds.
  public static let appUpdatedAt = "updatedAt"

  /// The two maps keyed by device and by person that the app section carries and
  /// that are never inherited from the anonymous section.
  public static let pushField = "push"
  public static let contextField = "context"

  /// One person's app-wide key: `hermie-app:<user_id>`, with `owner` on a gateway
  /// that has no accounts.
  public static func appKey(for userID: String) -> String {
    "\(legacyAppKey):\(userID)"
  }

  /// When this section was last chosen, or `0` when it does not say.
  ///
  /// Zero is "undated", the lowest possible answer: a section written by a build
  /// that predates the field loses to one that carries a date.
  public static func appStamp(of section: JSONObject?) -> Double {
    guard case .number(let raw)? = section?[appUpdatedAt], raw.isFinite, raw > 0 else {
      return 0
    }

    return raw.rounded(.down)
  }

  /// What a person's brand-new key inherits from the anonymous one: everything
  /// but `push` and `context`, which are maps keyed by device and by person and
  /// on a shared gateway hold everybody's rows mixed together.
  public static func inheritedFromLegacy(_ legacy: JSONObject) -> JSONObject {
    var copy = legacy
    copy["v"] = .number(Double(appSectionVersion))
    copy.removeValue(forKey: pushField)
    copy.removeValue(forKey: contextField)
    return copy
  }

  /// `bag[key]`, untouched, when it is an object whose `v` is a number with
  /// `0 < v <= known`; otherwise `nil`. A `v` this build does not know is `nil`
  /// on purpose: a newer build's shape is not something to guess at.
  public static func readSection(_ bag: JSONValue?, key: String, known: Double) -> JSONObject? {
    guard case .object(let object)? = bag, case .object(let section)? = object[key] else {
      return nil
    }

    let version: Double = if case .number(let number)? = section["v"] { number } else { 0 }

    return version > 0 && version <= known ? section : nil
  }
}

/// The plugin advert, as far as the sync needs it: which row carries a valid
/// one and which capabilities it lists.
///
/// The full advert (`pluginAdvertOf` in `packages/gateway-client/src/plugin.ts`)
/// belongs to the plugin port; this is the subset that decides where the push
/// rows live, and it carries the advert raw so that port can read the rest.
public enum UIMetaPlugin {
  /// The plugin contract version this build reads (`PLUGIN_CONTRACT_VERSION`).
  public static let contractVersion: Double = 1

  /// A valid advert: an object whose `v` is an integer in `1...contractVersion`.
  public static func advert(_ value: JSONValue?) -> JSONObject? {
    guard case .object(let object)? = value, case .number(let version)? = object["v"],
      version == version.rounded(), version >= 1, version <= contractVersion
    else {
      return nil
    }

    return object
  }

  /// The advert off a roster: every profile is looked at, the default one wins,
  /// otherwise the first row that carries a valid one.
  public static func advert(in rows: [JSONValue]) -> JSONObject? {
    var found: JSONObject?

    for row in rows {
      guard let advert = advert(row["ui_meta"]?[UIMeta.pluginKey]) else {
        continue
      }

      if row["is_default"] == .bool(true) {
        return advert
      }

      found = found ?? advert
    }

    return found
  }

  /// Does this advert list `capability`? No advert never does.
  public static func hasCapability(_ advert: JSONObject?, _ capability: String) -> Bool {
    advert?["capabilities"]?.arrayValue?.contains(.string(capability)) == true
  }
}
