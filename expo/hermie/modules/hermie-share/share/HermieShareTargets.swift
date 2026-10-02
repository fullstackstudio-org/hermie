import Foundation

/**
 Which conversation each bot IS, and in which words to report what happened.

 The third file this extension reads out of the App Group container, after the
 widget snapshot (the roster) and its own outbox. It exists because ADR-0026 lets
 this process send, and sending needs one thing the roster does not carry: the
 session to submit a prompt against.

 ## Why the session id cannot be worked out here

 `prompt.submit` addresses a session, not a profile. Finding which session is a
 bot's chat is three decisions the app makes: the canonical chat is looked up by a
 title convention over `session.list`, the reader may have switched that bot to a
 private chat of their own, and a bot with no chat yet needs one minted. The last
 is the dangerous one — the app FAILS CLOSED on a failed lookup precisely because
 a second forever-chat cannot be undone — and repeating that reasoning here, in a
 process with three seconds and a possibly stale roster, would get it wrong
 occasionally and permanently.

 So the app writes down the answer it already holds and this spells it back. A
 bot missing from this file has no target, which queues that share for the app:
 one launch of latency, never a message in the wrong conversation.

 ## Why the sentences are in here

 A share extension is a separate binary with its own bundle. It cannot reach the
 app's translations, which are a JavaScript module in a runtime that is not
 running — so the two sentences it has to be able to say travel in this file,
 already in the reader's language, and the English below is only what is drawn
 when the file is missing or was written by an older build.

 Every failure answers a default rather than throwing, for the reason the roster
 gives: there is nowhere to report an error to, and a sheet that can still queue
 is a sheet that still works.
 */
struct HermieShareTargets {
  /** `SHARE_TARGETS_FILE` in `src/features/share/targets.ts`. */
  static let fileName = "share-targets.json"

  /** `SHARE_TARGETS_VERSION`. A file from a version this build does not know is ignored. */
  static let supportedVersion = 1

  /** `SHARE_TARGET_BOT_PLACEHOLDER`: where the bot's label goes in `sent`. */
  static let botPlaceholder = "{bot}"

  /**
   The English the app would have written, for when it has written nothing.

   Not a translation gap this hides: it is the state before the app has ever run
   with this build installed, which is the same state that leaves the roster
   empty. The sheet says so in the roster's own words in that case; these are for
   the narrower case where a roster exists and this file does not.
   */
  static let fallbackSent = "Sent to \(botPlaceholder)"
  static let fallbackQueued = "Will send when Hermie opens"
  static let fallbackSending = "Sending…"

  /** `bot` → the DURABLE session id to resume. Never a runtime id. */
  let sessions: [String: String]

  /**
   Which gateway these sessions belong to, when the app knew.

   Compared with the credential's own key before anything is sent. The two
   disagree for exactly as long as it takes the app to run once after somebody
   switched gateway, and during that window a session id here names something the
   live gateway has never heard of — so the share is queued rather than sent
   somewhere it does not belong.
   */
  let gatewayKey: String?

  let sent: String
  let queued: String
  let sending: String

  /** What to draw after a successful send, with the bot's label in it. */
  func sentLine(bot: String) -> String {
    sent.replacingOccurrences(of: Self.botPlaceholder, with: bot)
  }

  /** The session to resume for this bot, or nil — which means "queue it". */
  func session(for bot: String) -> String? {
    guard let session = sessions[bot], !session.isEmpty else {
      return nil
    }

    return session
  }

  static func load() -> HermieShareTargets {
    let fallback = HermieShareTargets(
      sessions: [:],
      gatewayKey: nil,
      sent: fallbackSent,
      queued: fallbackQueued,
      sending: fallbackSending
    )

    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: HermieShareOutbox.appGroup
    ),
      let data = try? Data(contentsOf: container.appendingPathComponent(fileName)),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (root["version"] as? Int) == supportedVersion else {
      return fallback
    }

    var sessions: [String: String] = [:]

    for entry in (root["targets"] as? [[String: Any]]) ?? [] {
      guard let bot = entry["bot"] as? String, !bot.isEmpty,
        let session = entry["session"] as? String, !session.isEmpty else {
        continue
      }

      sessions[bot] = session
    }

    let copy = (root["copy"] as? [String: Any]) ?? [:]
    let key = root["gatewayKey"] as? String

    // Each sentence falls back on its own. A build of the app that adds a fourth
    // line and an extension that has not been reinstalled is an ordinary pairing,
    // and it must not cost the two lines that were already there.
    return HermieShareTargets(
      sessions: sessions,
      gatewayKey: (key?.isEmpty ?? true) ? nil : key,
      sent: nonEmpty(copy["sent"]) ?? fallbackSent,
      queued: nonEmpty(copy["queued"]) ?? fallbackQueued,
      sending: nonEmpty(copy["sending"]) ?? fallbackSending
    )
  }

  private static func nonEmpty(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else {
      return nil
    }

    return text
  }
}
