import Foundation

/**
 `share-outbox/<id>/lease.json`: "the share extension is delivering this entry right now".

 The extension writes it before it touches the network and removes it when it is done, whichever
 way it ended. The app does not deliver an entry with a fresh lease: the extension may be halfway
 through uploading it. A lease older than `lifetime` is from an extension that was killed, and is
 ignored. `lifetime` is comfortably longer than the extension's own deadline for a direct send
 (`ShareLease.attemptDeadline`), so a live attempt is never mistaken for a dead one.

 The app takes the same lease before it sends an entry itself (`take(in:now:)` on both sides: the
 file is created exclusively, so only one of them ever holds an entry), and gives it back when it
 kept the entry.

 The claim (`ShareClaim`) is the other half: written just before the message itself is submitted,
 it means "handed over, answer not seen", and it is never taken as permission to send again.
 */
public struct ShareLease: Sendable, Equatable {
  public static let supportedVersion = 1
  /// How long a direct send may take, from the lease to the last byte, before it gives up and queues.
  public static let attemptDeadline: Duration = .seconds(45)
  /// How long a lease holds the app off.
  public static let lifetime: TimeInterval = 120

  public var version: Int
  /// Unix seconds, from the extension's clock.
  public var at: Double

  public init(version: Int = ShareLease.supportedVersion, at: Double) {
    self.version = version
    self.at = at
  }

  /// A lease from a file's bytes. One that cannot be read is a lease taken now: the safe reading is
  /// "somebody may be sending this", and it expires like any other.
  public static func parse(_ data: Data, now: Date) -> ShareLease {
    guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return ShareLease(at: now.timeIntervalSince1970)
    }

    let at = ShareJSON.number(raw["at"])

    return ShareLease(at: at > 0 ? at : now.timeIntervalSince1970)
  }

  /// Whether the extension that wrote it may still be at work. A lease more than `lifetime` in the
  /// future (a clock that moved) is as stale as one that old, so no lease holds an entry for ever.
  public func isFresh(now: Date) -> Bool {
    abs(now.timeIntervalSince1970 - at) < Self.lifetime
  }

  public func encoded() -> Data {
    JSONText.object([("version", .number(Double(version))), ("at", .number(at))]).data
  }

  /// The largest lease file read when deciding whether one is fresh; anything bigger is not a lease.
  static let maxFileBytes = 4096

  /**
   Take the lease on one outbox entry (`entry` is its directory): create `lease.json` only when
   there is none, or when the one there is stale. Answers whether the caller holds the entry now.

   Both sides take it this way, the extension before a direct send and the app before it sends an
   entry itself, so whoever creates the file first holds the entry and the other one keeps off it.
   The file is created exclusively, never replaced, so a lease written a moment ago by the other
   process cannot be overwritten. A file there that cannot be read is somebody's lease taken now.
   */
  public static func take(in entry: URL, now: Date) -> Bool {
    let url = entry.appendingPathComponent(SharedContainer.shareLeaseFile)
    let data = ShareLease(at: now.timeIntervalSince1970).encoded()

    // At most once round: a stale lease is removed and the creation tried again.
    for _ in 0..<2 {
      switch createExclusively(url, data) {
      case .created:
        return true
      case .failed:
        return false
      case .exists:
        guard let existing = readExisting(url, now: now), !existing.isFresh(now: now) else {
          return false
        }

        try? FileManager.default.removeItem(at: url)
      }
    }

    return false
  }

  private enum Creation {
    case created
    case exists
    case failed
  }

  private static func createExclusively(_ url: URL, _ data: Data) -> Creation {
    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)

    guard descriptor >= 0 else {
      return errno == EEXIST ? .exists : .failed
    }

    let written = data.withUnsafeBytes { bytes in
      write(descriptor, bytes.baseAddress, bytes.count)
    }

    close(descriptor)

    // Created but not written: taken away again rather than left as a lease nobody holds.
    guard written == data.count else {
      unlink(url.path)
      return .failed
    }

    return .created
  }

  /// The lease already there, read as the app reads one (`parse`: unreadable is taken now); nil when
  /// it is not a regular file of a lease's size (never followed through a link), which counts as held.
  private static func readExisting(_ url: URL, now: Date) -> ShareLease? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber, size.intValue <= maxFileBytes,
      let data = try? Data(contentsOf: url)
    else {
      return nil
    }

    return parse(data, now: now)
  }
}
