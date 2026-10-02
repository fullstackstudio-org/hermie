import Foundation
import HermieShared

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

 The app writes the three sentences it wants said into this file, already in the
 reader's language, so the sheet says them in the app's words. The extension's
 own strings (`Localizable.strings`) are only what is drawn when the file is
 missing or was written by an older build.

 Every failure answers a default rather than throwing, for the reason the roster
 gives: there is nowhere to report an error to, and a sheet that can still queue
 is a sheet that still works.
 */
struct HermieShareTargets: Sendable {
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

  /**
   The sentences drawn when the app has written none: the state before the app has
   ever run with this build installed.
   */
  static var fallbackSent: String { String(localized: "Sent to \(ShareTargets.botPlaceholder)") }
  static var fallbackQueued: String { String(localized: "Will send when Hermie opens") }
  static var fallbackSending: String { String(localized: "Sending…") }

  /** What to draw after a successful send, with the bot's label in it. */
  func sentLine(bot: String) -> String {
    sent.replacingOccurrences(of: ShareTargets.botPlaceholder, with: bot)
  }

  /** The session to resume for this bot, or nil — which means "queue it". */
  func session(for bot: String) -> String? {
    guard let session = sessions[bot], !session.isEmpty else {
      return nil
    }

    return session
  }

  static func load() -> HermieShareTargets {
    guard let container = SharedContainer.url(),
      let data = try? Data(contentsOf: container.appendingPathComponent(SharedContainer.shareTargetsFile)),
      let file = ShareTargets.parse(data) else {
      return HermieShareTargets(
        sessions: [:], gatewayKey: nil, sent: fallbackSent, queued: fallbackQueued, sending: fallbackSending)
    }

    var sessions: [String: String] = [:]

    // The first session a bot is given wins, as the app wrote them.
    for target in file.targets where sessions[target.bot] == nil {
      sessions[target.bot] = target.session
    }

    // Each sentence falls back on its own. A build of the app that adds a fourth
    // line and an extension that has not been reinstalled is an ordinary pairing,
    // and it must not cost the lines that were already there.
    return HermieShareTargets(
      sessions: sessions,
      gatewayKey: file.gatewayKey,
      sent: file.copy.sent.isEmpty ? fallbackSent : file.copy.sent,
      queued: file.copy.queued.isEmpty ? fallbackQueued : file.copy.queued,
      sending: file.copy.sending.isEmpty ? fallbackSending : file.copy.sending
    )
  }
}
