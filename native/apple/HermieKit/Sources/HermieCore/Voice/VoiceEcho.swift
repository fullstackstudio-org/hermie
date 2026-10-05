import Foundation

/**
 What a call said lately, to tell its own voice coming back through the microphone from the reader's.

 On a loudspeaker the echo canceller leaves some of the reply in the microphone, and the recogniser
 writes it down as if the reader had said it. What it writes is the reply's own words, mostly in order,
 now and then one misheard. So a run of words that follows a line the call said, word for word, is
 its echo. A run of two counts while the line is being said or has only just ended (that is where an
 echo is); after that only a run of three, for up to `memory` seconds.

 A recognition is cumulative: an echo heard first, and the reader's words after it. `screen` keeps
 what comes after the last echoing run, when what comes before it is mostly echo (a misheard word in
 the middle of an echo does not save it), less the echo's own last words heard split or run together;
 otherwise the reader said it all, a few of the bot's words included, and all of it is kept.
 */
struct VoiceEchoFilter: Sendable, Equatable {
  private struct Line: Sendable, Equatable {
    var words: [String]
    /// When the call stopped saying it; nil while it is said, or waits to be.
    var ended: Double?
  }

  private var lines: [Line] = []

  /// How long after it was said a line can still come back.
  static let memory = 10.0
  /// Within this after a line ended, the echo of it is still in the room: two words in a row count.
  static let close = 1.0
  /// How much of what comes before the last echoing run must echo for all of it to be echo: while the
  /// call speaks or has just stopped, and later.
  static let closeShare = 0.5
  static let laterShare = 0.75
  /// A misheard end of an echo is recognised by its letters from this many on: fewer are in every line.
  static let splitLetters = 3

  init() {}

  /// The call is about to say `text` (a piece of a reply, a "still working" line).
  mutating func said(_ text: String) {
    let words = Self.words(text)

    if !words.isEmpty {
      lines.append(Line(words: words, ended: nil))
    }
  }

  /// The call stopped speaking: whatever it was saying, or had lined up, ends now.
  mutating func stopped(at now: Double) {
    for index in lines.indices where lines[index].ended == nil {
      lines[index].ended = now
    }

    forget(at: now)
  }

  /// Nothing said on this call comes back any more.
  mutating func reset() {
    lines = []
  }

  /// What of `text` the reader said: all of it, the part after an echo, or "" when it is all the call's
  /// own voice.
  func screen(_ text: String, at now: Double) -> String {
    let heard = text.split(whereSeparator: \.isWhitespace)
    let keys = heard.map { Self.key($0) }
    let recent = lines.filter { $0.ended.map { now - $0 <= Self.memory } ?? true }

    guard !recent.isEmpty, !keys.isEmpty else {
      return text
    }

    let near = recent.contains { $0.ended.map { now - $0 <= Self.close } ?? true }
    var echo = [Bool](repeating: false, count: keys.count)

    for line in recent {
      let run = (line.ended.map { now - $0 <= Self.close } ?? true) ? 2 : 3
      Self.mark(&echo, keys: keys, against: line.words, run: run)
    }

    guard let last = echo.lastIndex(of: true) else {
      return text
    }

    // Words that are only punctuation say nothing either way.
    let counted = (0...last).filter { !keys[$0].isEmpty }
    let share = near ? Self.closeShare : Self.laterShare

    guard Double(counted.filter { echo[$0] }.count) >= share * Double(counted.count) else {
      return text
    }

    // The echo's last word or two, heard split or run together ("to day" for "today"), are still the
    // echo: letters that run on in a line the call said.
    let rest = Array(heard[(last + 1)...])
    let restKeys = Array(keys[(last + 1)...])
    let runs = recent.map { $0.words.joined() }
    var echoed = 0
    var letters = ""

    for (index, key) in restKeys.enumerated() {
      letters += key

      if letters.count >= Self.splitLetters, runs.contains(where: { $0.contains(letters) }) {
        echoed = index + 1
      }
    }

    return rest[echoed...].joined(separator: " ")
  }

  /// Mark in `echo` every run of at least `run` heard words that follows `words` word for word.
  private static func mark(_ echo: inout [Bool], keys: [String], against words: [String], run: Int) {
    for start in keys.indices where !keys[start].isEmpty {
      for origin in words.indices where words[origin] == keys[start] {
        var length = 0

        while start + length < keys.count, origin + length < words.count,
          !keys[start + length].isEmpty, keys[start + length] == words[origin + length]
        {
          length += 1
        }

        if length >= run {
          for index in start..<(start + length) {
            echo[index] = true
          }
        }
      }
    }
  }

  /// A text's words as compared: folded to lower case without accents, only letters and digits.
  static func words(_ text: String) -> [String] {
    text.split(whereSeparator: \.isWhitespace).map { key($0) }.filter { !$0.isEmpty }
  }

  private static func key(_ word: Substring) -> String {
    let folded = word.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    return String(folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
  }

  private mutating func forget(at now: Double) {
    lines.removeAll { line in line.ended.map { now - $0 > Self.memory } ?? false }
  }
}
