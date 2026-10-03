import Foundation
import HermieShared
import HermieStore

/// One file in `intents/pending/`.
public enum IntentQueueEntry: Sendable, Equatable {
  case request(PendingIntent)
  /// A request this build cannot read (a newer writer, a broken file), named by its file.
  case unreadable(id: String)

  public var id: String {
    switch self {
    case let .request(intent): intent.id
    case let .unreadable(id): id
    }
  }
}

/// The sentences the queue answers with by itself, already in the reader's language.
public struct IntentQueueFailures: Sendable, Equatable {
  /// For a request this build cannot read.
  public var unreadable: String
  /// For a request that waited longer than the budget.
  public var expired: String
  /// For a request whose gateway is no longer configured.
  public var gatewayGone: String

  public init(unreadable: String, expired: String, gatewayGone: String) {
    self.unreadable = unreadable
    self.expired = expired
    self.gatewayGone = gatewayGone
  }
}

/// What the handler did with one request (`IntentQueueDrainer.drain`).
public enum IntentHandling: Sendable, Equatable {
  /// Answered now: the answer is written and the request removed.
  case answered(IntentResult)
  /// Not runnable yet (no socket): left pending for the next drain.
  case later
  /// Started, and answered by the handler itself through `complete(id:with:)` once it is done (an
  /// "Ask" waiting for its reply). The request stays taken meanwhile, so no drain runs it again, and
  /// the drain goes on to the next one.
  case started
}

/**
 The app's half of the Shortcuts queue: read what an App Intent asked for, and answer it.

 The App Intent wrote `intents/pending/<id>.json`, brought the app forward and is polling for
 `intents/results/<id>.json`; it gives up after `PendingIntent.budget`.

 - **Nothing is run while the app lock is on** (`SystemSurfaceLock`, locked until the app installs
   its lock state). A Shortcut's `perform()` runs inside the app behind the privacy cover; answering
   it while locked would send a prompt, or speak a bot's reply, without the lock ever being passed.
   The request stays pending, the Shortcut keeps waiting, and the drain after the unlock answers it.
 - The answer is written first and the request removed after it, so the polling intent never sees
   its request vanish with no answer beside it.
 - A request this build cannot read is answered, not dropped: the Shortcut is still waiting.
 - A request older than the budget is answered without being run. Each one is judged against the
   clock when its turn comes, not when the drain started: a request that ran out of time while an
   earlier one was being handled has already been given up on by its Shortcut.
 - A request is taken (`<id>.taken`) before it is handed over, so it is run at most once: a handler
   that answers later (`IntentHandling.started`) keeps it taken, one that cannot run it yet gives
   it back. A taken request whose answer never came (the app was killed meanwhile) is swept with
   the answers nobody collected.
 - A request for another configured gateway waits (and expires if that gateway does not become
   active in time); one whose gateway is gone is answered with `failures.gatewayGone`.
 - A request the handler cannot run yet (no socket) is left pending; the next drain picks it up.
 - Answers nobody collected (older than twice the budget) are swept.
 - Two drains never run at once: a second one asks the running one to go round again.
 */
public protocol IntentQueueDrainer: Sendable {
  /// Every request waiting, readable or not, oldest first (the unreadable ones last).
  func pending() -> [IntentQueueEntry]
  /// Write the answer, then remove the request (pending or taken). False when there was no such request.
  @discardableResult func complete(id: String, with result: IntentResult) -> Bool
  /// Answer what can be answered; see the type's documentation and `IntentHandling`.
  func drain(
    now: Date,
    gateways: GatewayScope,
    failures: IntentQueueFailures,
    handle: (PendingIntent) async -> IntentHandling
  ) async
  /// Remove every request recorded for `gatewayKey`.
  @discardableResult func purge(gatewayKey: String) -> Int
  /// Remove every request and every answer.
  @discardableResult func purgeAll() -> Int
}

extension IntentQueueDrainer {
  /// A drain whose handler answers on the spot: nil leaves a request pending.
  public func drain(
    now: Date = Date(),
    gateways: GatewayScope,
    failures: IntentQueueFailures,
    answer: (PendingIntent) async -> IntentResult?
  ) async {
    await drain(now: now, gateways: gateways, failures: failures) { intent -> IntentHandling in
      await answer(intent).map(IntentHandling.answered) ?? .later
    }
  }
}

/// The queue in the App Group container.
public struct AppGroupIntentQueue: IntentQueueDrainer {
  public let container: AppGroupContainer
  private let isLocked: @Sendable () -> Bool

  /// `isLocked` defaults to `SystemSurfaceLock`, which is locked until the app installs its lock state.
  public init(container: AppGroupContainer, isLocked: @escaping @Sendable () -> Bool = { SystemSurfaceLock.isLocked }) {
    self.container = container
    self.isLocked = isLocked
  }

  public static func live() -> AppGroupIntentQueue? {
    AppGroupContainer.system().map { AppGroupIntentQueue(container: $0) }
  }

  public func pending() -> [IntentQueueEntry] {
    var requests: [PendingIntent] = []
    var unreadable: [String] = []

    for name in container.contents(of: container.intentsPendingURL) where name.hasSuffix(".json") {
      let id = String(name.dropLast(".json".count))

      guard let url = container.pendingIntentURL(id: id) else {
        continue
      }

      // A file that is empty may still be mid-write by the intent; it is skipped, and the next drain
      // looks again. One that is too large, or is not a regular file, is not one of ours.
      guard AppGroupShareOutbox.fileType(at: url) == .typeRegular,
        let data = try? container.read(url, maxBytes: PendingIntent.maxFileBytes) else {
        unreadable.append(id)
        continue
      }

      guard !data.isEmpty else {
        continue
      }

      if let intent = PendingIntent.parse(data), intent.id == id {
        requests.append(intent)
      } else {
        unreadable.append(id)
      }
    }

    return PendingIntent.sorted(requests).map(IntentQueueEntry.request) + unreadable.map(IntentQueueEntry.unreadable)
  }

  @discardableResult
  public func complete(id: String, with result: IntentResult) -> Bool {
    let names = container.contents(of: container.intentsPendingURL)

    guard let pending = container.pendingIntentURL(id: id),
      let request = [pending, Self.taken(pending)].first(where: { names.contains($0.lastPathComponent) }),
      let destination = container.intentResultURL(id: id),
      (try? container.write(result.encoded(), to: destination)) != nil else {
      return false
    }

    container.remove(request)

    return true
  }

  /// Where a request waits while it is being run: `<id>.taken`, which `pending()` does not list.
  static func taken(_ pending: URL) -> URL {
    pending.deletingPathExtension().appendingPathExtension("taken")
  }

  /// Take a request before it is run. False when it is gone (purged meanwhile) or cannot be moved.
  private func take(_ id: String) -> Bool {
    guard let pending = container.pendingIntentURL(id: id) else {
      return false
    }

    return (try? FileManager.default.moveItem(at: pending, to: Self.taken(pending))) != nil
  }

  /// Give back a request that could not be run yet.
  private func giveBack(_ id: String) {
    guard let pending = container.pendingIntentURL(id: id) else {
      return
    }

    try? FileManager.default.moveItem(at: Self.taken(pending), to: pending)
  }

  public func drain(
    now: Date = Date(),
    gateways: GatewayScope,
    failures: IntentQueueFailures,
    handle: (PendingIntent) async -> IntentHandling
  ) async {
    guard !isLocked() else {
      return
    }

    // `now` is the drain's start; a request is judged by how much later its turn comes.
    let started = ContinuousClock.now
    let current = { now.addingTimeInterval(Self.seconds(ContinuousClock.now - started)) }

    _ = await DrainGate.gate(for: container.intentsPendingURL).run {
      sweepResults(now: now)

      var requests: [PendingIntent] = []

      for entry in pending() {
        switch entry {
        case let .unreadable(id):
          complete(id: id, with: .failure(id: id, failures.unreadable))
        case let .request(intent):
          requests.append(intent)
        }
      }

      for intent in PendingIntent.sorted(requests) {
        if intent.isExpired(now: current()) {
          complete(id: intent.id, with: .failure(id: intent.id, failures.expired))
          continue
        }

        // Before the app knows its gateways, nothing is decided about any of them.
        guard !gateways.known.isEmpty else {
          continue
        }

        switch gateways.route(intent.gatewayKey) {
        case .wait:
          continue
        case .purge:
          complete(id: intent.id, with: .failure(id: intent.id, failures.gatewayGone))
          continue
        case .deliver:
          break
        }

        guard !isLocked() else {
          break
        }

        guard take(intent.id) else {
          continue
        }

        switch await handle(intent) {
        case .answered(let result):
          complete(id: intent.id, with: result)
        case .later:
          giveBack(intent.id)
        case .started:
          break
        }
      }
    }
  }

  static func seconds(_ duration: Duration) -> TimeInterval {
    Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
  }

  @discardableResult
  public func purge(gatewayKey: String) -> Int {
    pending().reduce(0) { count, entry in
      guard case let .request(intent) = entry, intent.gatewayKey == gatewayKey,
        let url = container.pendingIntentURL(id: intent.id) else {
        return count
      }

      return count + (container.remove(url) ? 1 : 0)
    }
  }

  @discardableResult
  public func purgeAll() -> Int {
    var removed = 0

    for directory in [container.intentsPendingURL, container.intentsResultsURL] {
      for name in container.contents(of: directory) where container.remove(directory.appendingPathComponent(name)) {
        removed += 1
      }
    }

    return removed
  }

  /// Answers nobody collected, and requests taken and never answered (the app was killed while it
  /// ran them): older than twice the budget, the intent that waited for them is gone.
  private func sweepResults(now: Date) {
    let limit = Double(PendingIntent.budget.components.seconds) * 2
    let results = container.contents(of: container.intentsResultsURL).map {
      container.intentsResultsURL.appendingPathComponent($0)
    }
    let taken = container.contents(of: container.intentsPendingURL).filter { $0.hasSuffix(".taken") }.map {
      container.intentsPendingURL.appendingPathComponent($0)
    }

    for url in results + taken {
      let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date

      if let modified, now.timeIntervalSince(modified) > limit {
        container.remove(url)
      }
    }
  }
}
