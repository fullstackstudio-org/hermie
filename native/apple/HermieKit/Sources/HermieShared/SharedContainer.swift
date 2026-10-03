import Foundation

/**
 The App Group every Hermie binary shares, and the names of what lives in it.

 Spelled once for the extensions, which link this module and not `HermieStore`. The app reaches the
 same container through `HermieStore.AppGroupContainer`, whose constants a test holds equal to these:
 two binaries that disagree about a group name share nothing, and the failure is a widget that is
 permanently empty rather than an error anybody sees.
 */
public enum SharedContainer {
  /// The App Group of a release build (`group.$(HERMIE_BUNDLE_ID)` with the release root).
  public static let releaseAppGroup = "group.dev.hermie.app"

  /// The Info.plist key every Hermie binary carries its App Group in.
  public static let appGroupInfoKey = "HermieAppGroup"

  /// The App Group identifier, as this binary's entitlements name it: read from its Info.plist,
  /// so a Debug build (`group.dev.hermie.app.dev`) never opens a release build's container. The
  /// release group when the key is missing (a test bundle, a tool).
  public static let appGroup: String = appGroup(in: .main)

  /// The App Group a bundle's Info.plist names, or the release group.
  public static func appGroup(in bundle: Bundle) -> String {
    guard let value = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
      value.hasPrefix("group."), !value.contains("$(")
    else {
      return releaseAppGroup
    }

    return value
  }

  /// `WIDGET_SNAPSHOT_FILE`: the roster the widgets, the share sheet and the Shortcuts read.
  public static let widgetSnapshotFile = "widget-snapshot.json"
  /// `SHARE_TARGETS_FILE`.
  public static let shareTargetsFile = "share-targets.json"
  /// `SHARE_OUTBOX_DIRECTORY`.
  public static let shareOutboxDirectory = "share-outbox"
  /// `SHARE_MANIFEST_FILE`.
  public static let shareManifestFile = "manifest.json"
  /// `SHARE_CLAIM_FILE`.
  public static let shareClaimFile = "claim.json"
  /// The share extension's "delivering this now" marker (`ShareLease`).
  public static let shareLeaseFile = "lease.json"
  /// `INTENT_QUEUE_DIRECTORY`, with `pending/` and `results/` inside.
  public static let intentsDirectory = "intents"
  public static let intentsPendingDirectory = "pending"
  public static let intentsResultsDirectory = "results"

  /// The container, or nil when the App Group entitlement did not make it onto this binary.
  public static func url(fileManager: FileManager = .default) -> URL? {
    fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
  }

  /**
   A path found in a file (an avatar path in the widget snapshot), resolved inside `container`.

   Nil for anything that would land outside it: an absolute path, or `..` that climbs out. The
   path came out of the snapshot already escaped, so it is appended rather than parsed.
   */
  public static func resolve(_ path: String?, in container: URL) -> URL? {
    guard let path, !path.isEmpty, !path.hasPrefix("/") else {
      return nil
    }

    let root = container.standardizedFileURL.path
    let url = container.appendingPathComponent(path).standardizedFileURL

    guard url.path.hasPrefix(root + "/") else {
      return nil
    }

    return url
  }
}
