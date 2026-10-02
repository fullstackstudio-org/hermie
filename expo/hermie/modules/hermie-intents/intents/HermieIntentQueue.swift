import Foundation

/**
 The Swift half of the Shortcuts queue: write a request, wait for an answer.

 The producing side of the format `src/features/intents/queue.ts` parses, and
 the consuming side of the one it writes. There is no shared code between them
 and there cannot be — one is Swift in an App Intent, the other is TypeScript
 behind a socket — so the format is the contract, it is versioned, and both
 sides spell the directory names out loud.

 ## Polling, and why that is not as bad as it sounds

 `perform()` runs in the app's own process (`openAppWhenRun`), which means the
 file it is waiting for is written by JavaScript a few metres away in the same
 sandbox. There is no notification mechanism between the two — an Expo module is
 called FROM JavaScript and nothing calls into JavaScript from an arbitrary
 Swift stack frame — so the wait is a poll on a short interval against a local
 file, which costs a stat every quarter second for at most the budget.

 ## The budget is one number and it lives on both sides

 `budget` here and `INTENT_BUDGET_MS` there. A requester that gives up before
 the answerer does leaves a result nobody reads; the reverse leaves Shortcuts
 spinning over an app that has already finished.
 */
enum HermieIntentQueue {
  /** Must match `HermieIntentsModule.appGroup` and the app's entitlements. */
  static let appGroup = "group.dev.hermie.app"

  /** Also spelled in `queue.ts` as `INTENT_QUEUE_DIRECTORY`. */
  static let directoryName = "intents"

  /** `INTENT_QUEUE_VERSION`. Bumped on both sides or neither. */
  static let version = 1

  /** `INTENT_BUDGET_MS`, in seconds. See the note above. */
  static let budget: TimeInterval = 45

  /** How often the result directory is looked at while waiting. */
  private static let pollInterval: TimeInterval = 0.25

  enum Kind: String {
    case ask
    case send
  }

  /** What came back. `reply` is empty for `send`, which returns nothing. */
  struct Answer {
    let reply: String
  }

  enum Failure: Error {
    /** No App Group container — the entitlement did not reach the signed app. */
    case unavailable
    /** The budget ran out with no result file. */
    case timedOut
    /** The app answered, and said no. The string is meant to be shown. */
    case refused(String)
  }

  /**
   Write a request and answer its id.

   The id is hex from a `UUID` rather than the UUID's own string, because it is
   a file name AND a URL path component and the fewer characters that mean
   anything the better. It satisfies `isSafeIntentId` on the other side by
   construction, which is what lets the deep-link parser refuse anything else
   outright rather than trying to interpret it.

   Written `.atomic`: the app may list the directory at any moment, and a
   request read halfway through a write parses as nothing — which the runner
   would answer with "Hermie could not read that request", for a request that
   was perfectly fine a millisecond later.
   */
  static func enqueue(kind: Kind, bot: String, text: String) throws -> String {
    guard let pending = directory("pending") else {
      throw Failure.unavailable
    }

    let identifier = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let request: [String: Any] = [
      "version": version,
      "id": identifier,
      "kind": kind.rawValue,
      "bot": bot,
      "text": text,
      // MILLISECONDS, because that is what the other side compares against the
      // budget directly. The share manifest uses seconds; the two are different
      // formats and neither is the other's default.
      "createdAt": Int(Date().timeIntervalSince1970 * 1000)
    ]

    guard let data = try? JSONSerialization.data(withJSONObject: request, options: []) else {
      throw Failure.unavailable
    }

    do {
      try data.write(to: pending.appendingPathComponent("\(identifier).json"), options: .atomic)
    } catch {
      throw Failure.unavailable
    }

    return identifier
  }

  /**
   Wait for the app to answer, and read what it said.

   The result file is DELETED as it is read. Nothing else sweeps that directory,
   and a Shortcut that is never run again would otherwise leave its answer there
   for good.

   A timeout is not the same as a refusal and is kept apart: "the app took too
   long" is something the person can act on by using "Send to" instead, and
   "the bot is not on this gateway" is something they act on by fixing the
   Shortcut.
   */
  static func awaitResult(id: String) async throws -> Answer {
    guard let results = directory("results") else {
      throw Failure.unavailable
    }

    let file = results.appendingPathComponent("\(id).json")
    let deadline = Date().addingTimeInterval(budget)

    while Date() < deadline {
      if let data = try? Data(contentsOf: file),
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        try? FileManager.default.removeItem(at: file)

        if (root["ok"] as? Bool) == true {
          return Answer(reply: (root["reply"] as? String) ?? "")
        }

        throw Failure.refused((root["error"] as? String) ?? "Hermie could not do that.")
      }

      try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
    }

    throw Failure.timedOut
  }

  /** The link that tells the app to look now rather than at the next foreground. */
  static func deepLink(for id: String) -> URL? {
    URL(string: "hermie://intent/\(id)")
  }

  private static func directory(_ name: String) -> URL? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }

    let url = container
      .appendingPathComponent(directoryName, isDirectory: true)
      .appendingPathComponent(name, isDirectory: true)

    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)

    return url
  }
}
