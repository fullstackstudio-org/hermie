import Foundation
import HermieProtocol

/// Whether the device's settings are reaching a gateway.
///
/// `local` is a mode, not an error: a gateway too old to carry `ui_meta`, or one
/// that refuses the write, leaves the settings on the device (ADR-0012), and the
/// next reconcile tries again.
public enum UIMetaMode: String, Sendable, Hashable {
  case synced
  case local
}

/// What the plugin advert said, on a snapshot.
public enum UIMetaAdvert: Sendable, Hashable {
  /// The snapshot was not read off a roster (the device produced it).
  case unread
  /// The roster carried no valid advert: the plugin is not there.
  case absent
  /// The advert, raw.
  case advert(JSONObject)
}

/// The two kinds of section, as the gateway holds them or as the device does
/// (`UiMetaSnapshot`).
public struct UIMetaSnapshot: Sendable, Hashable {
  /// The app-wide section (`hermie-app:<user_id>`), or `nil` when there is none.
  public var app: JSONObject?
  /// Bot name to its `hermie` section. A bot with no section is absent.
  public var bots: [String: JSONObject]
  public var plugin: UIMetaAdvert
  /// The gateway's own app section, UNMERGED, even when `app` is the local copy.
  /// The maps keyed by device or person are always read from here: the entry
  /// another device wrote is not a rival version of ours, it is somebody else's.
  public var remote: JSONObject?
  /// The gateway's own copy of whichever section holds the push rows: `remote`,
  /// or the bare `hermie-app` on a gateway whose notifier cannot read the
  /// per-person key yet.
  public var pushHome: JSONObject?
  /// True on the one pull where this person had no key and the anonymous one
  /// existed, so `app` is that section read through `UIMeta.inheritedFromLegacy`.
  public var migrated: Bool

  public init(
    app: JSONObject? = nil,
    bots: [String: JSONObject] = [:],
    plugin: UIMetaAdvert = .unread,
    remote: JSONObject? = nil,
    pushHome: JSONObject? = nil,
    migrated: Bool = false
  ) {
    self.app = app
    self.bots = bots
    self.plugin = plugin
    self.remote = remote
    self.pushHome = pushHome
    self.migrated = migrated
  }
}

/// One `profiles.configure`: a profile and the keys of it that go out together.
///
/// One request per PROFILE rather than per section: the default profile is also
/// a bot, and `hermie` and `hermie-app:<user>` are independent inside one
/// request, which is one compare-and-swap where two would be two round trips.
public struct UIMetaWrite: Sendable, Hashable {
  public var profile: String
  public var keys: [String]
  /// The epoch the write was taken out under (`UIMetaState.epoch`).
  public var epoch: UInt64
  /// The marks its sections carried when an attempt was stamped.
  public var appMark: UInt64 = 0
  public var botMark: UInt64 = 0

  public init(profile: String, keys: [String], epoch: UInt64 = 0) {
    self.profile = profile
    self.keys = keys
    self.epoch = epoch
  }
}
