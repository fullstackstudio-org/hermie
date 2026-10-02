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
 - A request older than the budget is answered without being run.
 - A request for another configured gateway waits (and expires if that gateway does not become
   active in time); one whose gateway is gone is answered with `failures.gatewayGone`.
 - A request the handler cannot run yet (no socket) is left pending; the next drain picks it up.
 - Answers nobody collected (older than twice the budget) are swept.
 - Two drains never run at once: a second one asks the running one to go round again.
 */
public protocol IntentQueueDrainer: Sendable {
  /// Every request waiting, readable or not, oldest first (the unreadable ones last).
  func pending() -> [IntentQueueEntry]
  /// Write the answer, then remove the request. False when there was no such request.
  @discardableResult func complete(id: String, with result: IntentResult) -> Bool
  /// Answer what can be answered; see the type's documentation. `answer` returning nil leaves a request pending.
  func drain(
    now: Date,
    gateways: GatewayScope,
    failures: IntentQueueFailures,
    answer: (PendingIntent) async -> IntentResult?
  ) async
  /// Remove every request recorded for `gatewayKey`.
  @discardableResult func purge(gatewayKey: String) -> Int
  /// Remove every request and every answer.
  @discardableResult func purgeAll() -> Int
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
    guard container.contents(of: container.intentsPendingURL).contains("\(id).json"),
      let request = container.pendingIntentURL(id: id),
      let destination = container.intentResultURL(id: id),
      (try? container.write(result.encoded(), to: destination)) != nil else {
      return false
    }

    container.remove(request)

    return true
  }

  public func drain(
    now: Date = Date(),
    gateways: GatewayScope,
    failures: IntentQueueFailures,
    answer: (PendingIntent) async -> IntentResult?
  ) async {
    guard !isLocked() else {
      return
    }

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
        if intent.isExpired(now: now) {
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

        if let result = await answer(intent) {
          complete(id: intent.id, with: result)
        }
      }
    }
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

  /// Answers nobody collected: older than twice the budget, the intent that waited for them is gone.
  private func sweepResults(now: Date) {
    let limit = Double(PendingIntent.budget.components.seconds) * 2

    for name in container.contents(of: container.intentsResultsURL) {
      let url = container.intentsResultsURL.appendingPathComponent(name)
      let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date

      if let modified, now.timeIntervalSince(modified) > limit {
        container.remove(url)
      }
    }
  }
}
