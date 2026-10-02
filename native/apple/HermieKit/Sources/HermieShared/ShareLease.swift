import Foundation

/**
 `share-outbox/<id>/lease.json`: "the share extension is delivering this entry right now".

 The extension writes it before it touches the network and removes it when it is done, whichever
 way it ended. The app does not deliver an entry with a fresh lease: the extension may be halfway
 through uploading it. A lease older than `lifetime` is from an extension that was killed, and is
 ignored. `lifetime` is comfortably longer than the extension's own deadline for a direct send
 (`ShareLease.attemptDeadline`), so a live attempt is never mistaken for a dead one.

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
}
