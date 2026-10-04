import HermieProtocol

// The unread rules (`selectors.ts`): what counts as a message, how many arrived
// past a watermark, where the watermark has to go, and the badge's label.

/// The badge caps here; a number wider than the dot it replaces reads as noise.
/// `UNREAD_BADGE_CAP`.
public let unreadBadgeCap = 99

/// How many messages arrived in this chat since the user last looked at it.
///
/// Only what a reader would call "a message" counts: the bot's own replies to
/// them. Tool rows, notices, the user's own turns and bot-to-bot traffic are not
/// unread mail, and counting them would make a badge that never settles.
///
/// `since` is the watermark the roster keeps (unix seconds). A chat the app has
/// not loaded has nothing to count, which is why the list still falls back to a
/// dot rather than showing a confident zero.
public func unreadCountSince(_ state: ChatState, _ since: Double) -> Int {
  var count = 0

  for id in state.order {
    if let item = state.items[id], countsAsMessage(item), (item.ts ?? 0) > since {
      count += 1
    }
  }

  return count
}

/// Is this row a message, for the purposes of a badge?
///
/// One predicate rather than two copies of the same list: `unreadCountSince`
/// counts what is past the watermark and `lastMessageAt` says where the watermark
/// has to go to leave nothing behind it. If the two ever disagreed about what a
/// message is, a chat the reader is looking at would count one for ever.
func countsAsMessage(_ item: TranscriptItem) -> Bool {
  /*
    Bot-to-bot traffic is NOT mail, so it never moves a badge.

    The owner's rule, in his words: *bot-to-bot must also not bump the
    notification badge.* `bot_dm_in` used to count — it is a message, and it is
    even addressed to this bot — but a badge answers one question, "is there
    something here for ME", and two agents working out a delivery between
    themselves is not. A bot that dispatches to a teammate every few seconds
    produced a chat list that was permanently shouting about work nobody had to
    look at, and a reader who opened it found nothing they had to do.

    `bot_dm_out` and `subagent_group` never counted, and this is where that
    stays written down: the three kinds are one rule, not one rule and two
    accidents of an `if` that happened to exclude them.

    It is only the COUNT. The rows are still in the transcript, still drawn, and
    `hasOpenRequest` is untouched: a question a teammate's work raised still asks
    for the reader, because somebody asked THEM.
  */
  guard case .assistant(let assistant) = item else {
    return false
  }

  // An empty or interim bubble is the turn in progress, not a message.
  return !assistant.interim && (!JS.trimsToEmpty(assistant.text) || !(assistant.outbox ?? []).isEmpty)
}

/// When the newest message in this chat arrived, in unix seconds, or 0.
///
/// Read backwards, because the answer is almost always the last row and walking
/// a whole transcript for it on every delta is a cost a long chat would feel.
///
/// What it is FOR: a chat that is open and scrolled to the bottom is read, and
/// "read" has to be written as a watermark the unread count will then find
/// nothing past. Writing `now` alone is not enough — a gateway whose clock runs
/// ahead stamps a message in the reader's future, and the badge comes back.
public func lastMessageAt(_ state: ChatState) -> Double {
  for id in state.order.reversed() {
    if let item = state.items[id], countsAsMessage(item) {
      return item.ts ?? 0
    }
  }

  return 0
}

/// `3`, `99+` — the badge label, or an empty string when nothing is unread.
public func unreadBadgeLabel(_ count: Int) -> String {
  if count <= 0 {
    return ""
  }

  return count > unreadBadgeCap ? "\(unreadBadgeCap)+" : String(count)
}
