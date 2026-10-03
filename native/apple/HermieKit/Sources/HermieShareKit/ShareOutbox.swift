import Foundation
import HermieShared

/**
 The share extension's side of the outbox: write one share where the app will find it, mark it
 while the extension delivers it, and remove it once it has gone.

 The reading side is the app's (`ShareOutboxDrainer`); the format is `ShareManifest`,
 `ShareClaim` and `ShareLease` in `HermieShared`.

 ## Everything is written before anything is named

 An entry is a directory holding the copied files and a `manifest.json`. The manifest is written
 LAST and atomically: the app skips a directory with no manifest in it, so an extension killed
 between copying a photograph and writing the manifest leaves something inert rather than something
 that claims to have files it does not have.

 ## Only regular files, only safe names, never a manifest the app would refuse

 A shared file is copied only when it is a regular file (never a symbolic link, which could name a
 file in this process's own container), under a name `ShareItem.isSafeFileName` accepts. Shared
 text or a URL longer than `ShareManifest.inlineTextLimit` is written into the entry as a text file
 instead of inline, so the manifest stays far below `ShareManifest.maxBytes`, the limit the app
 reads with.
 */
public struct ShareOutbox: Sendable {
  /// `<container>/share-outbox`.
  public let directory: URL

  public init(container: URL) {
    directory = container.appendingPathComponent(SharedContainer.shareOutboxDirectory, isDirectory: true)
  }

  /// The real container's outbox, or nil when the App Group entitlement is missing.
  public static func system() -> ShareOutbox? {
    SharedContainer.url().map(ShareOutbox.init(container:))
  }

  /// What one loaded attachment is, before it has a home.
  public enum Payload: Sendable, Equatable {
    /// A regular file already copied somewhere this process owns.
    case file(url: URL, name: String, isImage: Bool)
    case url(String)
    case text(String)

    public var isImage: Bool {
      if case .file(_, _, true) = self {
        return true
      }

      return false
    }
  }

  // MARK: Names

  /// A share id: hex from a UUID, which satisfies `Identifiers.isSafeShareId` by construction.
  public static func newIdentifier() -> String {
    UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  }

  /**
   The one-segment file name rule, applied: anything outside `[A-Za-z0-9._-]` becomes `-`, runs
   are collapsed, leading dots and dashes go, and an empty result is `attachment`.
   */
  public static func safeFileName(_ name: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    let mapped = String(String(name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }).prefix(120))
    var collapsed = ""
    var previousWasDash = false

    for character in mapped {
      if character == "-" {
        if previousWasDash {
          continue
        }

        previousWasDash = true
      } else {
        previousWasDash = false
      }

      collapsed.append(character)
    }

    let trimmed = collapsed.drop { $0 == "." || $0 == "-" }

    return trimmed.isEmpty ? "attachment" : String(trimmed)
  }

  /// A hint for the manifest and an upload's part, never more: the gateway sniffs the bytes.
  public static func mimeType(for url: URL) -> String {
    let byExtension: [String: String] = [
      "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "heic": "image/heic", "gif": "image/gif",
      "webp": "image/webp", "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown",
      "json": "application/json", "csv": "text/csv", "zip": "application/zip", "mp4": "video/mp4",
      "mov": "video/quicktime"
    ]

    return byExtension[url.pathExtension.lowercased()] ?? PendingShare.fallbackMimeType
  }

  /// Whether `url` is a regular file, judged without following a symbolic link.
  public static func isRegularFile(_ url: URL) -> Bool {
    let type = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType

    return type == .typeRegular
  }

  // MARK: Staging

  /**
   Copy a shared file into `staging` (this process's temporary directory, which the system sweeps),
   or nil when it is not a regular file or cannot be copied.

   `NSItemProvider` hands over a URL that is valid only inside its completion handler, so the copy
   happens there, before anything returns.
   */
  public static func stage(_ url: URL, name: String, isImage: Bool, in staging: URL) -> Payload? {
    guard isRegularFile(url) else {
      return nil
    }

    let destination = staging.appendingPathComponent(UUID().uuidString, isDirectory: true)
      .appendingPathComponent(safeFileName(name))

    do {
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: url, to: destination)
    } catch {
      return nil
    }

    return .file(url: destination, name: destination.lastPathComponent, isImage: isImage)
  }

  /**
   A payload as it is kept: text or a URL longer than `ShareManifest.inlineTextLimit` becomes a
   text file in `staging`, so nothing is cut and the manifest stays small. Files and short text
   pass through.
   */
  public static func normalise(_ payload: Payload, staging: URL) -> Payload? {
    switch payload {
    case .file:
      return payload
    case let .url(text), let .text(text):
      guard text.utf8.count > ShareManifest.inlineTextLimit else {
        return payload
      }

      let destination = staging.appendingPathComponent(UUID().uuidString, isDirectory: true)
        .appendingPathComponent("shared-text.txt")

      do {
        try FileManager.default.createDirectory(
          at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: destination, options: .atomic)
      } catch {
        return nil
      }

      return .file(url: destination, name: destination.lastPathComponent, isImage: false)
    }
  }

  // MARK: Writing

  /**
   Write one entry and answer its id, or nil when there is nowhere to write.

   `bot` is the profile name (the handle, never the label) and `gatewayKey` the gateway of the
   roster it was picked from. Files are copied, not moved: the staged copies are still read by a
   direct send after this returns. One file that cannot be copied is one attachment fewer, not a
   share that fails.
   */
  public func write(
    bot: String?,
    gatewayKey: String?,
    note: String,
    payloads: [Payload],
    now: Date = Date()
  ) -> String? {
    let identifier = Self.newIdentifier()
    let entry = directory.appendingPathComponent(identifier, isDirectory: true)
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent(
      "share-\(identifier)", isDirectory: true)

    defer { try? FileManager.default.removeItem(at: staging) }

    guard (try? FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)) != nil else {
      return nil
    }

    var items: [ShareItem] = []
    var used = Set<String>()

    for original in payloads.prefix(ShareManifest.itemLimit) {
      guard let payload = Self.normalise(original, staging: staging) else {
        continue
      }

      switch payload {
      case let .file(url, name, isImage):
        let safe = Self.uniqueName(Self.safeFileName(name.isEmpty ? url.lastPathComponent : name), taken: &used)
        let destination = entry.appendingPathComponent(safe)

        guard Self.isRegularFile(url), (try? FileManager.default.copyItem(at: url, to: destination)) != nil else {
          continue
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: destination.path))?[.size] as? NSNumber

        items.append(
          ShareItem(
            kind: isImage ? .image : .file, path: safe, filename: safe, size: size?.intValue ?? 0,
            mimeType: Self.mimeType(for: destination)
          ))
      case let .url(value):
        items.append(ShareItem(kind: .url, text: value))
      case let .text(value):
        items.append(ShareItem(kind: .text, text: value))
      }
    }

    let manifest = ShareManifest(
      id: identifier,
      bot: bot.flatMap { $0.isEmpty ? nil : $0 },
      gatewayKey: gatewayKey.flatMap { Identifiers.isGatewayKey($0) ? $0 : nil },
      note: String(decoding: Array(note.utf16.prefix(ShareManifest.noteLimit)), as: UTF16.self),
      createdAt: now.timeIntervalSince1970.rounded(.down),
      items: items
    )
    let data = manifest.encoded()

    // LAST, and atomic: a directory without a manifest is skipped by the app.
    guard data.count <= ShareManifest.maxBytes,
      (try? data.write(to: entry.appendingPathComponent(SharedContainer.shareManifestFile), options: .atomic))
        != nil else {
      try? FileManager.default.removeItem(at: entry)

      return nil
    }

    return identifier
  }

  // MARK: The attempt

  /// Whether the entry is still in the outbox, i.e. the app has not taken it.
  public func exists(entry: String) -> Bool {
    guard let directory = entryURL(entry) else {
      return false
    }

    return FileManager.default.fileExists(atPath: directory.appendingPathComponent(SharedContainer.shareManifestFile).path)
  }

  /**
   Mark the entry as being delivered by this process, before anything touches the network. False
   when the entry is gone (the app has it), when the app holds a fresh lease on it (it is sending
   the entry itself), or when the mark could not be written; either way the caller does not attempt
   the delivery. The lease is created, never replaced (`ShareLease.take`).
   */
  public func lease(entry: String, now: Date = Date()) -> Bool {
    guard exists(entry: entry), let directory = entryURL(entry) else {
      return false
    }

    return ShareLease.take(in: directory, now: now)
  }

  /// Take the mark away, so the app delivers the entry now rather than after the lease runs out.
  public func releaseLease(entry: String) {
    guard let directory = entryURL(entry) else {
      return
    }

    try? FileManager.default.removeItem(at: directory.appendingPathComponent(SharedContainer.shareLeaseFile))
  }

  /**
   Mark the entry as handed over, immediately before the message is submitted, and answer whether
   it may be submitted.

   False when the entry is no longer in the outbox — the app has taken it and is delivering it
   itself — so the extension must not send it too. When the claim cannot be written the answer is
   still true: the gap fails towards "sent twice, visibly", which is better than not sending.
   */
  public func claim(entry: String, bot: String, now: Date = Date()) -> Bool {
    guard exists(entry: entry), let directory = entryURL(entry) else {
      return false
    }

    let data = ShareClaim(bot: bot, at: now.timeIntervalSince1970.rounded(.down)).encoded()

    try? data.write(to: directory.appendingPathComponent(SharedContainer.shareClaimFile), options: .atomic)

    return true
  }

  /// Delete one entry and everything in it.
  public func remove(entry: String) {
    guard let directory = entryURL(entry) else {
      return
    }

    try? FileManager.default.removeItem(at: directory)
  }

  /// One entry's directory, matched against the outbox's own listing rather than joined onto it.
  private func entryURL(_ entry: String) -> URL? {
    guard Identifiers.isSafeShareId(entry),
      let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path), names.contains(entry) else {
      return nil
    }

    return directory.appendingPathComponent(entry, isDirectory: true)
  }

  /// Two photographs called `IMG_0001.jpg` are two different files.
  private static func uniqueName(_ name: String, taken: inout Set<String>) -> String {
    if taken.insert(name).inserted {
      return name
    }

    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var index = 2

    while true {
      let candidate = ext.isEmpty ? "\(base)-\(index)" : "\(base)-\(index).\(ext)"

      if taken.insert(candidate).inserted {
        return candidate
      }

      index += 1
    }
  }
}
