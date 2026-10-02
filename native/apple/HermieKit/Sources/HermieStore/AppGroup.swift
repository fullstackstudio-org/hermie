import Foundation

/**
 The shared container `group.dev.hermie.app`: where each file lives, and how to read and write one.

 The app, the widgets, the share extension and the Shortcuts actions meet here, and nothing else
 does — a widget has no gateway, a share extension has three seconds. The names are the ones the
 Expo modules and `src/features/{widgets,share,intents}` use, so the extensions and their formats
 stay the same.

 The database is never in here. It holds settings and cached chats that only the app needs, and a
 container other processes write to is the wrong place for them.

 Writes are atomic (write to a temporary file, then rename), because a reader in another process may
 open the file at any moment. Reads have a size ceiling, because every file here may have been put
 here by another process.
 */
public struct AppGroupContainer: Sendable {
  public static let identifier = "group.dev.hermie.app"

  /// `WIDGET_SNAPSHOT_FILE`.
  public static let widgetSnapshotFile = "widget-snapshot.json"
  /// The widget avatars directory: `avatars/<encodeURIComponent(bot)>.png`.
  public static let avatarsDirectory = "avatars"
  /// `SHARE_TARGETS_FILE`.
  public static let shareTargetsFile = "share-targets.json"
  /// `SHARE_OUTBOX_DIRECTORY`: one directory per share, holding `manifest.json`, `claim.json` and files.
  public static let shareOutboxDirectory = "share-outbox"
  public static let shareManifestFile = "manifest.json"
  public static let shareClaimFile = "claim.json"
  public static let shareLeaseFile = "lease.json"
  /// `INTENT_QUEUE_DIRECTORY`, with `pending/<id>.json` and `results/<id>.json`.
  public static let intentsDirectory = "intents"
  public static let intentsPendingDirectory = "pending"
  public static let intentsResultsDirectory = "results"

  /// Ceiling for a manifest, a claim or a queued request.
  public static let maxSmallFileBytes = 256 * 1024

  public let url: URL

  /// A container at a given URL; tests pass a temporary directory.
  public init(url: URL) {
    self.url = url.standardizedFileURL
  }

  /// The real container, or nil when the App Group entitlement did not make it onto the binary.
  public static func system(fileManager: FileManager = .default) -> AppGroupContainer? {
    fileManager.containerURL(forSecurityApplicationGroupIdentifier: identifier).map(AppGroupContainer.init(url:))
  }

  // MARK: Locations

  public var widgetSnapshotURL: URL { url.appendingPathComponent(Self.widgetSnapshotFile) }
  public var shareTargetsURL: URL { url.appendingPathComponent(Self.shareTargetsFile) }
  public var avatarsURL: URL { url.appendingPathComponent(Self.avatarsDirectory, isDirectory: true) }
  public var shareOutboxURL: URL { url.appendingPathComponent(Self.shareOutboxDirectory, isDirectory: true) }

  public var intentsPendingURL: URL {
    url.appendingPathComponent(Self.intentsDirectory, isDirectory: true)
      .appendingPathComponent(Self.intentsPendingDirectory, isDirectory: true)
  }

  public var intentsResultsURL: URL {
    url.appendingPathComponent(Self.intentsDirectory, isDirectory: true)
      .appendingPathComponent(Self.intentsResultsDirectory, isDirectory: true)
  }

  /// `avatars/<encodeURIComponent(bot)>.png`, relative to the container, as `widgetAvatarPath`.
  public static func avatarPath(forBot bot: String) -> String {
    "\(avatarsDirectory)/\(encodeURIComponent(bot)).png"
  }

  public func avatarURL(forBot bot: String) -> URL {
    url.appendingPathComponent(Self.avatarPath(forBot: bot))
  }

  /// One share's directory, when `id` is a single safe segment.
  public func shareEntryURL(id: String) -> URL? {
    Self.isSafeSegment(id) ? shareOutboxURL.appendingPathComponent(id, isDirectory: true) : nil
  }

  public func pendingIntentURL(id: String) -> URL? {
    Self.isSafeSegment(id) ? intentsPendingURL.appendingPathComponent("\(id).json") : nil
  }

  public func intentResultURL(id: String) -> URL? {
    Self.isSafeSegment(id) ? intentsResultsURL.appendingPathComponent("\(id).json") : nil
  }

  /**
   A path found in a file (an avatar path in the widget snapshot), resolved inside the container.

   Nil for anything that would land outside it: absolute paths, `..` that climbs out, or a symbolic
   link that points elsewhere.
   */
  public func resolve(relativePath path: String) -> URL? {
    guard !path.isEmpty, !path.hasPrefix("/") else {
      return nil
    }

    let candidate = Self.resolvingLinks(url.appendingPathComponent(path).standardizedFileURL)
    let root = Self.resolvingLinks(url).path

    guard candidate.path.hasPrefix(root + "/") else {
      return nil
    }

    return candidate
  }

  /// Symbolic links resolved through the deepest part of the path that exists; the system call
  /// leaves a path alone when its last component does not exist yet.
  private static func resolvingLinks(_ url: URL) -> URL {
    var existing = url
    var missing: [String] = []

    while !FileManager.default.fileExists(atPath: existing.path), existing.pathComponents.count > 1 {
      missing.insert(existing.lastPathComponent, at: 0)
      existing = existing.deletingLastPathComponent()
    }

    return missing.reduce(existing.resolvingSymlinksInPath()) { $0.appendingPathComponent($1) }
  }

  // MARK: Reading and writing

  /// The bytes of a file, nil when it does not exist. Throws when it is larger than `maxBytes`.
  public func read(_ fileURL: URL, maxBytes: Int = AppGroupContainer.maxSmallFileBytes) throws -> Data? {
    let manager = FileManager.default

    guard manager.fileExists(atPath: fileURL.path) else {
      return nil
    }

    let size = (try manager.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.intValue ?? 0

    guard size <= maxBytes else {
      throw AppGroupError.tooLarge(path: fileURL.lastPathComponent, bytes: size, limit: maxBytes)
    }

    return try Data(contentsOf: fileURL)
  }

  /// Replace a file atomically, creating its directory when needed.
  public func write(_ data: Data, to fileURL: URL) throws {
    try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: fileURL, options: .atomic)
  }

  /// A Codable value as JSON, written atomically.
  public func writeJSON(_ value: some Encodable, to fileURL: URL) throws {
    let encoder = JSONEncoder()

    encoder.outputFormatting = [.withoutEscapingSlashes]
    try write(try encoder.encode(value), to: fileURL)
  }

  /// A JSON file decoded, nil when absent.
  public func readJSON<T: Decodable>(
    _ type: T.Type,
    from fileURL: URL,
    maxBytes: Int = AppGroupContainer.maxSmallFileBytes
  ) throws -> T? {
    guard let data = try read(fileURL, maxBytes: maxBytes) else {
      return nil
    }

    return try JSONDecoder().decode(type, from: data)
  }

  /// Remove a file or directory inside the container. Answers whether something was removed.
  @discardableResult
  public func remove(_ fileURL: URL) -> Bool {
    guard fileURL.standardizedFileURL.path.hasPrefix(url.path + "/") else {
      return false
    }

    return (try? FileManager.default.removeItem(at: fileURL)) != nil
  }

  /// The names in a directory of the container, hidden files skipped; empty when it does not exist.
  public func contents(of directoryURL: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: directoryURL.path)) ?? [])
      .filter { !$0.hasPrefix(".") }
      .sorted()
  }

  // MARK: Helpers

  /// One path segment from the share and intent alphabet: `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$`.
  static func isSafeSegment(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    guard let first = scalars.first, (1...64).contains(scalars.count), first != "." else {
      return false
    }

    return scalars.allSatisfy { scalar in
      ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
        || scalar == "_" || scalar == "-" || scalar == "."
    }
  }

  /// JavaScript's `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` escaped.
  static func encodeURIComponent(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
  }
}

public enum AppGroupError: Error, Sendable, Equatable {
  case tooLarge(path: String, bytes: Int, limit: Int)
}
