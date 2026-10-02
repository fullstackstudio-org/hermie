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

/**
 The app's half of the Shortcuts queue: read what an App Intent asked for, and answer it.

 What `HermieIntentsModule` (`listIntents`, `completeIntent`) and the queue half of
 `intent-runner.ts` did. The App Intent wrote `intents/pending/<id>.json`, brought the app forward
 and is polling for `intents/results/<id>.json`; it gives up after `PendingIntent.budget`.

 - The answer is written first and the request removed after it, so the polling intent never sees
   its request vanish with no answer beside it.
 - A request this build cannot read is answered, not dropped: the Shortcut is still waiting.
 - A request older than the budget is answered without being run: nobody is listening, and a
   message arriving in a chat long after somebody gave up asking for it is worse than none.
 - A request the caller cannot run yet (no socket) is left pending; the next drain picks it up.
 */
public protocol IntentQueueDrainer: Sendable {
  /// Every request waiting, readable or not, oldest first (the unreadable ones last).
  func pending() -> [IntentQueueEntry]
  /// Write the answer, then remove the request. False when there was no such request.
  @discardableResult func complete(id: String, with result: IntentResult) -> Bool
  /**
   Answer every waiting request: an unreadable one with `failures.unreadable`, an expired one with
   `failures.expired`, and the rest with what `answer` returns, oldest first. `answer` returning nil
   leaves that request pending.
   */
  func drain(
    now: Date,
    failures: IntentQueueFailures,
    answer: (PendingIntent) async -> IntentResult?
  ) async
}

/// The two sentences the queue answers with by itself, already in the reader's language.
public struct IntentQueueFailures: Sendable, Equatable {
  /// For a request this build cannot read.
  public var unreadable: String
  /// For a request that waited longer than the budget.
  public var expired: String

  public init(unreadable: String, expired: String) {
    self.unreadable = unreadable
    self.expired = expired
  }
}

extension IntentQueueDrainer {
  public func drain(
    now: Date,
    failures: IntentQueueFailures,
    answer: (PendingIntent) async -> IntentResult?
  ) async {
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

      if let result = await answer(intent) {
        complete(id: intent.id, with: result)
      }
    }
  }
}

/// The queue in the App Group container.
public struct AppGroupIntentQueue: IntentQueueDrainer {
  public let container: AppGroupContainer

  /// A request is a few hundred bytes; anything larger is not one of ours.
  static let maxRequestBytes = 64 * 1024

  public init(container: AppGroupContainer) {
    self.container = container
  }

  public static func live() -> AppGroupIntentQueue? {
    AppGroupContainer.system().map(AppGroupIntentQueue.init(container:))
  }

  public func pending() -> [IntentQueueEntry] {
    var requests: [PendingIntent] = []
    var unreadable: [String] = []

    for name in container.contents(of: container.intentsPendingURL) where name.hasSuffix(".json") {
      let id = String(name.dropLast(".json".count))

      guard let url = container.pendingIntentURL(id: id) else {
        continue
      }

      // A file that is empty or too large may still be mid-write by the intent; it is skipped, not
      // answered, and the next drain looks again.
      guard let data = try? container.read(url, maxBytes: Self.maxRequestBytes), !data.isEmpty else {
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
}
