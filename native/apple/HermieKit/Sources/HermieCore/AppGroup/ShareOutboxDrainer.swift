import Foundation
import HermieShared
import HermieStore

/// What the app did with one share it was handed.
public enum ShareDrainDecision: Sendable, Equatable {
  /// Sent: the entry and its files are removed.
  case delivered
  /// Will never be sendable (its files were reclaimed, its bot is gone and the person said so): removed.
  case discard
  /// Not now (no session yet, a claim waiting for the person's answer): left exactly as it is.
  case keep
}

/**
 The app's half of the share outbox: read what the share extension left, hand each share over, and
 remove the ones that are done.

 What `HermieShareModule` (`listShares`, `clearShare`) and the outbox half of `share-delivery.ts`
 did. Which share goes where, and whether a claimed share is sent again, are the caller's decisions
 (the closure's): this only reads, hands over and removes.

 The rules that keep a share from being lost:

 - a directory without a readable manifest is skipped, never deleted — it may be an entry the
   extension is still writing, or one a newer build wrote;
 - an entry is removed only after the closure says it was delivered or will never be;
 - the claim file is reported as the share's `claim`, never listed as one of its files.
 */
public protocol ShareOutboxDrainer: Sendable {
  /// Every readable share, oldest first.
  func pending() -> [PendingShare]
  /// Remove one entry and everything in it. False when there was no such entry.
  @discardableResult func remove(id: String) -> Bool
  /**
   Hand every pending share to `handle`, oldest first, one at a time, and remove the ones it
   delivered or discarded. Answers what was decided for each id.
   */
  @discardableResult
  func drain(_ handle: (PendingShare) async -> ShareDrainDecision) async -> [String: ShareDrainDecision]
}

extension ShareOutboxDrainer {
  @discardableResult
  public func drain(_ handle: (PendingShare) async -> ShareDrainDecision) async -> [String: ShareDrainDecision] {
    var decisions: [String: ShareDrainDecision] = [:]

    for share in pending() {
      let decision = await handle(share)

      decisions[share.id] = decision

      if decision != .keep {
        remove(id: share.id)
      }
    }

    return decisions
  }
}

/// The outbox in the App Group container.
public struct AppGroupShareOutbox: ShareOutboxDrainer {
  public let container: AppGroupContainer

  public init(container: AppGroupContainer) {
    self.container = container
  }

  /// The real container, or nil when the App Group entitlement is missing.
  public static func live() -> AppGroupShareOutbox? {
    AppGroupContainer.system().map(AppGroupShareOutbox.init(container:))
  }

  public func pending() -> [PendingShare] {
    let manager = FileManager.default
    var shares: [PendingShare] = []

    for id in container.contents(of: container.shareOutboxURL) {
      guard let directory = container.shareEntryURL(id: id),
        (try? directory.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
        let manifest = try? container.read(directory.appendingPathComponent(AppGroupContainer.shareManifestFile)),
        !manifest.isEmpty else {
        continue
      }

      var files: [String: URL] = [:]
      var claim: Data?

      for name in (try? manager.contentsOfDirectory(atPath: directory.path)) ?? [] {
        switch name {
        case AppGroupContainer.shareManifestFile:
          continue
        case AppGroupContainer.shareClaimFile:
          // Read with the manifest's ceiling. One that cannot be read is still a claim.
          claim = (try? container.read(directory.appendingPathComponent(name))) ?? Data()
        default:
          files[name] = directory.appendingPathComponent(name)
        }
      }

      if let share = PendingShare.parse(id: id, manifest: manifest, claim: claim, files: files) {
        shares.append(share)
      }
    }

    return PendingShare.sorted(shares)
  }

  @discardableResult
  public func remove(id: String) -> Bool {
    // Matched against the outbox's own listing, so an id with a separator in it matches nothing.
    guard container.contents(of: container.shareOutboxURL).contains(id),
      let directory = container.shareEntryURL(id: id) else {
      return false
    }

    return container.remove(directory)
  }
}

/// Writes `share-targets.json`, which tells the share extension which session each bot is.
public struct ShareTargetsWriter: Sendable {
  public let container: AppGroupContainer

  public init(container: AppGroupContainer) {
    self.container = container
  }

  public static func live() -> ShareTargetsWriter? {
    AppGroupContainer.system().map(ShareTargetsWriter.init(container:))
  }

  /// Replace the file atomically. Answers whether it now holds `targets`.
  @discardableResult
  public func write(_ targets: ShareTargets) -> Bool {
    (try? container.write(targets.encoded(), to: container.shareTargetsURL)) != nil
  }
}
