import Foundation
import HermieShared

/**
 The App Intent's half of the Shortcuts queue: write a request, wait for an answer.

 The producing side of the format the app's `IntentQueueDrainer` reads, and the consuming side of
 the answers it writes. The format is `PendingIntent` / `IntentResult` in `HermieShared`; the
 directory names are spelled once, in `SharedContainer`.

 ## Polling, and why that is not as bad as it sounds

 `perform()` runs in the app's own process (`openAppWhenRun`), which means the file it is waiting
 for is written by the app's session layer a few metres away in the same sandbox. The intent is
 written to work whether or not anything in the app calls back into it, so the wait is a poll on a
 short interval against a local file, which costs a stat every quarter second for at most the
 budget.

 ## The budget is one number and it lives on both sides

 `PendingIntent.budget` is what the app answers within. A requester that gives up before the
 answerer does leaves a result nobody reads; the reverse leaves Shortcuts spinning over an app that
 has already finished.
 */
enum HermieIntentQueue {
  /** How often the result directory is looked at while waiting. */
  private static let pollInterval: Duration = .milliseconds(250)

  typealias Kind = PendingIntent.Kind

  /** What came back. `reply` is empty for `send`, which returns nothing. */
  struct Answer: Sendable {
    let reply: String
  }

  enum Failure: Error, Sendable {
    /** No App Group container — the entitlement did not reach the signed app. */
    case unavailable
    /** The prompt is longer than `PendingIntent.textLimit`. */
    case tooLong
    /** The Shortcut was cancelled while it waited. */
    case cancelled
    /** The budget ran out with no result file. */
    case timedOut
    /** The app answered, and said no. The string is meant to be shown. */
    case refused(String)
  }

  /**
   Write a request and answer its id.

   The id is hex from a `UUID` rather than the UUID's own string, because it is a file name AND a
   URL path component and the fewer characters that mean anything the better. It satisfies
   `isSafeIntentId` on the other side by construction, which is what lets the deep-link parser
   refuse anything else outright rather than trying to interpret it.

   Written atomically: the app may list the directory at any moment, and a request read halfway
   through a write parses as nothing — which the app would answer with "could not read that
   request", for a request that was perfectly fine a millisecond later.
   */
  static func enqueue(kind: Kind, bot: String, gatewayKey: String?, text: String) throws(Failure) -> String {
    // Refused here, with a sentence, rather than written and then refused by the app's reader.
    guard text.utf16.count <= PendingIntent.textLimit else {
      throw .tooLong
    }

    guard let pending = directory(SharedContainer.intentsPendingDirectory) else {
      throw .unavailable
    }

    let identifier = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    // MILLISECONDS, because that is what the app compares against the budget directly. The share
    // manifest uses seconds; the two are different formats and neither is the other's default.
    // The gateway of the roster the bot was picked from: the app runs the request only on that
    // gateway, never on another one's bot of the same name.
    let request = PendingIntent(
      id: identifier, kind: kind, bot: bot, text: text, createdAt: (Date().timeIntervalSince1970 * 1000).rounded(.down),
      gatewayKey: gatewayKey
    )

    do {
      try request.encoded().write(to: pending.appendingPathComponent("\(identifier).json"), options: .atomic)
    } catch {
      throw .unavailable
    }

    return identifier
  }

  /**
   Wait for the app to answer, and read what it said.

   The result file is DELETED as it is read. Nothing else sweeps that directory, and a Shortcut
   that is never run again would otherwise leave its answer there for good.

   A timeout is not the same as a refusal and is kept apart: "the app took too long" is something
   the person can act on by using "Send to" instead, and "the bot is not on this gateway" is
   something they act on by fixing the Shortcut.
   */
  static func awaitResult(id: String) async throws(Failure) -> Answer {
    guard let results = directory(SharedContainer.intentsResultsDirectory) else {
      throw .unavailable
    }

    let file = results.appendingPathComponent("\(id).json")
    let deadline = ContinuousClock.now + PendingIntent.budget

    while ContinuousClock.now < deadline {
      if Task.isCancelled {
        throw .cancelled
      }

      if let data = try? Data(contentsOf: file),
        let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        try? FileManager.default.removeItem(at: file)

        if (root["ok"] as? Bool) == true {
          return Answer(reply: (root["reply"] as? String) ?? "")
        }

        throw .refused((root["error"] as? String) ?? String(localized: "Hermie could not do that."))
      }

      try? await Task.sleep(for: pollInterval)
    }

    throw .timedOut
  }

  /** The link that tells the app to look now rather than at the next foreground. */
  static func deepLink(for id: String) -> URL? {
    DeepLink.intent(id: id).url
  }

  private static func directory(_ name: String) -> URL? {
    guard let container = SharedContainer.url() else {
      return nil
    }

    let url = container
      .appendingPathComponent(SharedContainer.intentsDirectory, isDirectory: true)
      .appendingPathComponent(name, isDirectory: true)

    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)

    return url
  }
}
