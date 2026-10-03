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

/// What a drain did with one entry, the handler's decision included.
public enum ShareDrainOutcome: Sendable, Equatable {
  /// Handed to the handler, which decided this.
  case handled(ShareDrainDecision)
  /// The share extension is delivering it right now (a fresh lease): left alone.
  case leased
  /// Written less than `AppGroupShareOutbox.leaseGrace` ago with no lease yet: the extension is
  /// about to lease it for its own send. Left for a drain after the grace.
  case settling
  /// It belongs to another configured gateway: left for when that gateway is active.
  case otherGateway
  /// Its gateway no longer exists (or it predates gateway keys and more than one is configured): removed.
  case purged
  /// Its manifest cannot be read (too large, not JSON, another version, not a regular file): removed.
  case unreadable
}

/**
 The app's half of the share outbox: read what the share extension left, hand each share over, and
 remove the ones that are done.

 Which chat a share goes to, and whether a claimed share is sent again, are the handler's
 decisions; this reads, routes, hands over and removes. The rules that keep a share from being lost
 or sent twice:

 - A directory without a manifest is skipped: the extension may still be writing it. A manifest
   that is there and cannot be read is reported and removed, never skipped for ever.
 - An entry with a fresh lease is the extension's, mid-delivery: it is not handed over. One with no
   lease that was written less than `leaseGrace` ago is not handed over either: the extension leases
   it right after writing it. Before the handler runs, the app takes the lease itself
   (`ShareLease.take`, created exclusively), so the extension never sends what the app is sending,
   and gives it back when the handler keeps the entry.
 - An entry is handed over only for the active gateway (`GatewayScope`); another configured
   gateway's waits, and one whose gateway is gone is purged.
 - An entry is removed only after the handler says it was delivered or never will be.
 - The claim and the lease are reported on the share, never listed as its files, and only regular
   files are listed: never a symbolic link.
 - Nothing happens while the app lock is on (`SystemSurfaceLock`), and two drains never run at
   once: a second one asks the running one to go round again.
 */
public protocol ShareOutboxDrainer: Sendable {
  /// Every readable share, oldest first, and the ids of the entries whose manifest cannot be read.
  func scan(now: Date) -> (shares: [PendingShare], unreadable: [String])
  /// Remove one entry and everything in it. False when there was no such entry.
  @discardableResult func remove(id: String) -> Bool
  /**
   Hand every share for the active gateway to `handle`, oldest first, one at a time, and remove the
   ones it delivered or discarded. Answers what happened to each entry; empty while locked, and for
   a call that only asked a running drain to go round again.
   */
  @discardableResult
  func drain(
    gateways: GatewayScope,
    now: Date,
    _ handle: (PendingShare) async -> ShareDrainDecision
  ) async -> [String: ShareDrainOutcome]
  /// Remove every entry recorded for `gatewayKey`: the gateway was signed out of or removed.
  @discardableResult func purge(gatewayKey: String) -> Int
  /// Remove every entry: the last gateway is gone.
  @discardableResult func purgeAll() -> Int
}

/// The outbox in the App Group container.
public struct AppGroupShareOutbox: ShareOutboxDrainer {
  public let container: AppGroupContainer
  private let isLocked: @Sendable () -> Bool

  /// `isLocked` defaults to `SystemSurfaceLock`, which is locked until the app installs its lock state.
  public init(container: AppGroupContainer, isLocked: @escaping @Sendable () -> Bool = { SystemSurfaceLock.isLocked }) {
    self.container = container
    self.isLocked = isLocked
  }

  /// How long a share with no lease is left to the extension, in seconds (`createdAt` is whole
  /// seconds, so this is at least one second of real time).
  public static let leaseGrace: TimeInterval = 2

  /// The real container, or nil when the App Group entitlement is missing.
  public static func live() -> AppGroupShareOutbox? {
    AppGroupContainer.system().map { AppGroupShareOutbox(container: $0) }
  }

  public func pending() -> [PendingShare] {
    scan(now: Date()).shares
  }

  public func scan(now: Date) -> (shares: [PendingShare], unreadable: [String]) {
    let manager = FileManager.default
    var shares: [PendingShare] = []
    var unreadable: [String] = []

    for id in container.contents(of: container.shareOutboxURL) {
      guard let directory = container.shareEntryURL(id: id) else {
        // A name outside the share alphabet is not something the extension writes.
        unreadable.append(id)
        continue
      }

      switch Self.fileType(at: directory) {
      case .typeDirectory:
        break
      case .none:
        continue
      default:
        unreadable.append(id)
        continue
      }

      let manifestURL = directory.appendingPathComponent(AppGroupContainer.shareManifestFile)

      switch Self.fileType(at: manifestURL) {
      case .none:
        // Still being written.
        continue
      case .typeRegular:
        break
      default:
        unreadable.append(id)
        continue
      }

      var files: [String: URL] = [:]
      var claim: Data?
      var lease: Data?

      for name in (try? manager.contentsOfDirectory(atPath: directory.path)) ?? [] {
        let url = directory.appendingPathComponent(name)
        let regular = Self.fileType(at: url) == .typeRegular

        switch name {
        case AppGroupContainer.shareManifestFile:
          continue
        case AppGroupContainer.shareClaimFile:
          // Read with the manifest's ceiling, and never through a link. One that cannot be read
          // is still a claim.
          claim = (regular ? try? container.read(url, maxBytes: AppGroupContainer.maxSmallFileBytes) : nil) ?? Data()
        case AppGroupContainer.shareLeaseFile:
          lease = (regular ? try? container.read(url, maxBytes: AppGroupContainer.maxSmallFileBytes) : nil) ?? Data()
        default:
          if regular {
            files[name] = url
          }
        }
      }

      guard let manifest = try? container.read(manifestURL, maxBytes: ShareManifest.maxBytes),
        let share = PendingShare.parse(id: id, manifest: manifest, claim: claim, lease: lease, files: files, now: now)
      else {
        unreadable.append(id)
        continue
      }

      shares.append(share)
    }

    return (PendingShare.sorted(shares), unreadable)
  }

  @discardableResult
  public func remove(id: String) -> Bool {
    // Matched against the outbox's own listing, so an id with a separator in it matches nothing. A
    // listed name outside the share alphabet is removed too: it is not something the extension wrote.
    guard container.contents(of: container.shareOutboxURL).contains(id) else {
      return false
    }

    return container.remove(container.shareOutboxURL.appendingPathComponent(id))
  }

  @discardableResult
  public func drain(
    gateways: GatewayScope,
    now: Date = Date(),
    _ handle: (PendingShare) async -> ShareDrainDecision
  ) async -> [String: ShareDrainOutcome] {
    guard !isLocked() else {
      return [:]
    }

    var outcomes: [String: ShareDrainOutcome] = [:]

    _ = await DrainGate.gate(for: container.shareOutboxURL).run {
      let (shares, unreadable) = scan(now: now)

      for id in unreadable {
        remove(id: id)
        outcomes[id] = .unreadable
      }

      for share in shares {
        if let lease = share.lease, lease.isFresh(now: now) {
          outcomes[share.id] = .leased
          continue
        }

        // Written a moment ago and not leased yet: the extension is about to lease it for its own
        // direct send. Left for the drain after the grace.
        if share.lease == nil, abs(now.timeIntervalSince1970 - share.createdAt) < Self.leaseGrace {
          outcomes[share.id] = .settling
          continue
        }

        // Known gateways only: before the app knows its gateways it must not purge anything.
        guard !gateways.known.isEmpty else {
          continue
        }

        switch gateways.route(share.gatewayKey) {
        case .wait:
          outcomes[share.id] = .otherGateway
          continue
        case .purge:
          remove(id: share.id)
          outcomes[share.id] = .purged
          continue
        case .deliver:
          break
        }

        // Locked while the previous share was being sent: stop here, and leave the rest.
        guard !isLocked() else {
          break
        }

        // The app's own lease before the handler may send it, created exclusively: an extension
        // that leased it since the scan holds it, and one that comes later keeps off it.
        guard let entry = container.shareEntryURL(id: share.id), ShareLease.take(in: entry, now: now) else {
          outcomes[share.id] = .leased
          continue
        }

        let decision = await handle(share)

        outcomes[share.id] = .handled(decision)

        if decision != .keep {
          remove(id: share.id)
        } else {
          container.remove(entry.appendingPathComponent(AppGroupContainer.shareLeaseFile))
        }
      }
    }

    return outcomes
  }

  @discardableResult
  public func purge(gatewayKey: String) -> Int {
    scan(now: Date()).shares.filter { $0.gatewayKey == gatewayKey }.reduce(0) { count, share in
      count + (remove(id: share.id) ? 1 : 0)
    }
  }

  @discardableResult
  public func purgeAll() -> Int {
    container.contents(of: container.shareOutboxURL).reduce(0) { count, id in
      count + (remove(id: id) ? 1 : 0)
    }
  }

  /// The type of what is at `url`, without following a symbolic link; nil when nothing is there.
  static func fileType(at url: URL) -> FileAttributeType? {
    (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType
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

  /// Remove the file when it is `gatewayKey`'s (or names no gateway). Answers whether it went.
  @discardableResult
  public func purge(gatewayKey: String) -> Bool {
    guard let data = try? container.read(container.shareTargetsURL),
      let targets = ShareTargets.parse(data), targets.gatewayKey == nil || targets.gatewayKey == gatewayKey else {
      return false
    }

    return container.remove(container.shareTargetsURL)
  }

  /// Remove the file.
  @discardableResult
  public func purgeAll() -> Bool {
    container.remove(container.shareTargetsURL)
  }
}
