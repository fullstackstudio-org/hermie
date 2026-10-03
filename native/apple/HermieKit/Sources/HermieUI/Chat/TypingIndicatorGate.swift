import Foundation
import HermieTranscript

/// When the typing row (`TranscriptRow.Content.typingIndicator`) is on screen, as two small pure
/// pieces: whether the bot is working with nothing visible yet (`TypingIndicator.wanted`), and the
/// debounce between that and the row (`TypingIndicatorGate`). `ChatFeed` runs them; neither knows
/// about a screen or a clock, so the tests drive both with plain values.
enum TypingIndicator {
  /// The bot is working and no reply bubble is writing words yet.
  ///
  /// - Working, thinking, a tool (at quiet the running call is a hidden stand-in row, so this is the
  ///   only sign of it) and a delegation all want the dots.
  /// - Typing does not: words are arriving, or the reply so far is on screen as a bubble. The
  ///   header says the same, from the same `TurnActivity`.
  /// - Waiting does not: the turn is blocked on a person, and a card on screen says so.
  /// - Idle does not: nothing runs.
  ///
  /// A tool call announced while the reply is still streaming words (the activity names the tool,
  /// the bubble is still growing) is the one case the activity alone gets wrong, so the newest
  /// assistant row is looked at as well.
  static func wanted(activity: TurnActivity, items: [VisibleItem]) -> Bool {
    switch activity {
    case .idle, .waiting, .typing:
      return false
    case .working, .thinking, .tool, .delegating:
      return !replyIsWritingWords(items)
    }
  }

  /// The newest assistant row on screen has words and is still being written.
  static func replyIsWritingWords(_ items: [VisibleItem]) -> Bool {
    for entry in items.reversed() {
      switch entry.item {
      case .assistant(let assistant):
        guard entry.presentation == .full || entry.presentation == .collapsed else { continue }
        return assistant.streaming && assistant.error == nil && assistant.text.contains { !$0.isWhitespace }
      case .user:
        // Everything before the reader's own turn is an earlier turn's.
        return false
      default:
        continue
      }
    }
    return false
  }
}

/// The debounce between "the bot is working" and the row: it appears only once the bot has been
/// working, with nothing on screen, for `showDelay`, and goes the moment it is not.
///
/// The row appearing is what could flicker: a reply's words, a tool and a thought follow each other
/// within frames, and a bubble that came and went in 50 ms would be worse than none. Going is not
/// debounced, because what it goes for is on screen in the same frame (the reply's first words, the
/// finished reply), and a dots bubble under a finished answer for another 150 ms is the bug.
///
/// A value type with no clock: `update` takes the time it is told at, and `showDeadline` is when
/// the caller has to call it again if nothing else arrives before then.
struct TypingIndicatorGate: Equatable {
  /// How long the bot must have been working, with nothing on screen, before the dots show.
  static let showDelay: TimeInterval = 0.15

  /// The row is on screen.
  private(set) var visible = false
  /// When the current stretch of wanting began; `nil` while not wanted.
  private var wantedSince: TimeInterval?

  /// The bot's state at `now`. Returns whether the row appeared or went because of it.
  @discardableResult
  mutating func update(wanted: Bool, now: TimeInterval) -> Bool {
    let before = visible

    guard wanted else {
      wantedSince = nil
      visible = false
      return before != visible
    }

    if visible {
      return false
    }

    let since = wantedSince ?? now
    wantedSince = since

    if now - since >= Self.showDelay {
      visible = true
    }

    return before != visible
  }

  /// When the row will show if the state stays as it is: `nil` when it already shows or nothing is
  /// wanted.
  var showDeadline: TimeInterval? {
    guard !visible, let wantedSince else { return nil }
    return wantedSince + Self.showDelay
  }
}
