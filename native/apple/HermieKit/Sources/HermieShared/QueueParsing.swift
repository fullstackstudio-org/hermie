import Foundation

/**
 The tolerant readers and the writers of `share-targets.json` and the Shortcuts queue, as
 `src/features/share/targets.ts` and `src/features/intents/queue.ts` read and write them. The
 app writes these files and the extensions read them, or the other way round, so each format is
 spelled here once for both.
 */
extension ShareTargets {
  /// `SHARE_TARGETS_LIMIT`.
  public static let limit = 24

  /**
   `buildShareTargets`: one target per bot, the first session each bot is given, at most `limit`,
   and the clock floored to seconds. A bot with no name or no session is skipped.
   */
  public static func build(
    bots: [(name: String, session: String)],
    copy: Copy,
    gatewayKey: String?,
    now: Date
  ) -> ShareTargets {
    var targets: [Target] = []
    var seen = Set<String>()

    for bot in bots where !bot.name.isEmpty && !bot.session.isEmpty && !seen.contains(bot.name) {
      guard targets.count < limit else {
        break
      }

      seen.insert(bot.name)
      targets.append(Target(bot: bot.name, session: bot.session))
    }

    return ShareTargets(
      generatedAt: now.timeIntervalSince1970.rounded(.down),
      gatewayKey: gatewayKey.flatMap { $0.isEmpty ? nil : $0 },
      copy: copy,
      targets: targets
    )
  }

  /**
   Read the file as tolerantly as `parseShareTargets`: nil only for another version or bytes that
   are not a JSON object. A target without a bot or a session is dropped on its own, and a
   sentence that is missing is empty — the reader decides what an empty sentence falls back to.
   */
  public static func parse(_ data: Data) -> ShareTargets? {
    guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      ShareJSON.number(raw["version"]) == Double(supportedVersion) else {
      return nil
    }

    let copy = raw["copy"] as? [String: Any] ?? [:]
    let gatewayKey = ShareJSON.string(raw["gatewayKey"])
    let targets = ((raw["targets"] as? [Any]) ?? []).compactMap { entry -> Target? in
      let fields = entry as? [String: Any] ?? [:]
      let bot = ShareJSON.string(fields["bot"])
      let session = ShareJSON.string(fields["session"])

      return bot.isEmpty || session.isEmpty ? nil : Target(bot: bot, session: session)
    }

    return ShareTargets(
      generatedAt: ShareJSON.number(raw["generatedAt"]),
      gatewayKey: gatewayKey.isEmpty ? nil : gatewayKey,
      copy: Copy(
        sent: ShareJSON.string(copy["sent"]),
        queued: ShareJSON.string(copy["queued"]),
        sending: ShareJSON.string(copy["sending"])
      ),
      targets: Array(targets.prefix(limit))
    )
  }

  /// The session to resume for `bot`, or nil — which means "queue it".
  public func session(for bot: String) -> String? {
    targets.first { $0.bot == bot && !$0.session.isEmpty }?.session
  }

  /// The file's bytes, as `serialiseShareTargets` writes them.
  public func encoded() -> Data {
    jsonText.data
  }
}

extension PendingIntent {
  /**
   `parsePendingIntent`: nil for another version, an id outside the alphabet, an unknown kind, no
   bot, or text that is only whitespace. A missing time is zero.
   */
  public static func parse(_ data: Data) -> PendingIntent? {
    guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      ShareJSON.number(raw["version"]) == Double(supportedVersion) else {
      return nil
    }

    let id = ShareJSON.string(raw["id"])
    let bot = ShareJSON.string(raw["bot"])
    let text = ShareJSON.string(raw["text"])

    guard Identifiers.isSafeIntentId(id), let kind = Kind(rawValue: ShareJSON.string(raw["kind"])), !bot.isEmpty,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }

    return PendingIntent(id: id, kind: kind, bot: bot, text: text, createdAt: ShareJSON.number(raw["createdAt"]))
  }

  /// `isExpired`: older than the budget by `now`.
  public func isExpired(now: Date) -> Bool {
    now.timeIntervalSince1970 * 1000 - createdAt > Double(PendingIntent.budget.components.seconds) * 1000
  }

  /// `sortIntents`: oldest first, then by id.
  public static func sorted(_ intents: [PendingIntent]) -> [PendingIntent] {
    intents.sorted { left, right in
      left.createdAt != right.createdAt ? left.createdAt < right.createdAt : left.id < right.id
    }
  }

  /// The request's bytes: compact, the time in whole milliseconds as `Date.now()` gives it.
  public func encoded() -> Data {
    jsonText.data
  }
}

extension IntentResult {
  /// The answer's bytes as `intentReply` / `intentFailure` write them: compact, an absent field left out.
  public func encoded() -> Data {
    jsonText.data
  }
}
