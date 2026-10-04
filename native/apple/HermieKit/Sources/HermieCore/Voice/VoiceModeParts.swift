import Foundation
import HermieMarkdown

/**
 A reply that is still being written, cut into pieces that can be said now.

 Voice mode reads a reply while it streams, so the first sentence is heard while the bot is still
 writing the third. What may be read is only what will not change: a piece of Markdown that a later
 delta cannot reinterpret. So a cut is made only

 - at the end of a finished line that is not inside a code fence (a fence still open is a block whose
   summary, "a code block of 4 lines", is not known yet), or
 - inside the line still arriving, just after a sentence ends (`.`, `!`, `?` or `…` after a letter or
   a closing quote, then a space), and only where the emphasis and code spans before it are closed: a
   cut inside `**…**` would leave the asterisks to be read out.

 What is cut is flattened for speech (`MarkdownSpeech`: code blocks read as their shape, links as their
 label) and handed over once. When the reply is finished, everything left goes.
 */
public struct SpokenReplyCutter: Sendable, Equatable {
  /// How much of the reply's Markdown has been handed over, in characters.
  public private(set) var consumed = 0

  public init() {}

  /// The words that can be said now, flattened for speech, or nil when nothing new can be. `finished`
  /// hands over the rest whatever it ends in.
  public mutating func take(_ markdown: String, finished: Bool, codeBlock: (Int) -> String) -> String? {
    guard markdown.count > consumed else {
      return nil
    }

    let rest = markdown.dropFirst(consumed)
    let cut = finished ? rest.endIndex : Self.safeCut(in: rest)

    guard cut > rest.startIndex else {
      return nil
    }

    let piece = rest[rest.startIndex..<cut]
    consumed += piece.count

    let words = MarkdownSpeech.text(String(piece), codeBlock: codeBlock)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return words.isEmpty ? nil : words
  }

  /// Everything there is now counts as handed over: what is said from here on is only what arrives
  /// later (a reply that was cut off, or put aside for a request).
  public mutating func skip(_ markdown: String) {
    consumed = max(consumed, markdown.count)
  }

  /// The furthest point of `text` (which starts outside a fence) that a later delta cannot change.
  static func safeCut(in text: Substring) -> Substring.Index {
    var safe = text.startIndex
    var fenced = false
    var lineStart = text.startIndex

    while lineStart < text.endIndex {
      guard let newline = text[lineStart...].firstIndex(of: "\n") else {
        // The line still arriving: a sentence end in it, outside a fence.
        if !fenced, let sentence = sentenceEnd(in: text[lineStart...]) {
          safe = sentence
        }

        break
      }

      let line = text[lineStart..<newline]
      let trimmed = line.drop { $0 == " " || $0 == "\t" }

      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        fenced.toggle()
      }

      lineStart = text.index(after: newline)

      if !fenced {
        safe = lineStart
      }
    }

    return safe
  }

  /// Just after the last sentence end in `line` that is followed by a space and has its code spans and
  /// emphasis closed before it, or nil.
  static func sentenceEnd(in line: Substring) -> Substring.Index? {
    var found: Substring.Index?
    var ticks = 0
    var stars = 0
    var previous: Character?
    var index = line.startIndex

    while index < line.endIndex {
      let character = line[index]
      let next = line.index(after: index)

      switch character {
      case "`": ticks += 1
      // A run of asterisks (`**`) is one delimiter: it opens or closes.
      case "*" where previous != "*": stars += 1
      case "*": break
      case ".", "!", "?", "…":
        if next < line.endIndex, line[next] == " ", ticks % 2 == 0, stars % 2 == 0,
          let previous, previous.isLetter || previous == "\"" || previous == "”" || previous == ")"
        {
          found = line.index(after: next)
        }
      default:
        break
      }

      previous = character
      index = next
    }

    return found
  }
}

/// What a bot is doing while it does not talk, as far as a filler line is concerned.
public enum VoiceFillerKind: String, Sendable, CaseIterable {
  /// Searching the web, or looking something up.
  case search
  /// Reading a file, a page, a document.
  case reading
  /// Running a command, code, a tool that does something.
  case working
  /// Anything else, or nothing named.
  case generic

  /// The kind for a tool's name (`web_search`, `read_file`, `terminal`, …).
  public static func of(tool name: String?) -> VoiceFillerKind {
    guard let name = name?.lowercased(), !name.isEmpty else {
      return .generic
    }

    func has(_ words: [String]) -> Bool { words.contains { name.contains($0) } }

    if has(["search", "web", "browse", "google", "lookup", "find"]) {
      return .search
    }

    if has(["read", "file", "fetch", "open", "page", "document", "memory", "recall"]) {
      return .reading
    }

    if has(["terminal", "shell", "bash", "exec", "run", "code", "python", "command", "write", "edit"]) {
      return .working
    }

    return .generic
  }
}

/// A short line voice mode says by itself: its kind, and which of that kind's lines.
public struct VoiceFiller: Sendable, Equatable {
  public var kind: VoiceFillerKind
  public var variant: Int

  public init(kind: VoiceFillerKind, variant: Int) {
    self.kind = kind
    self.variant = variant
  }
}

/**
 When voice mode says something itself so the line is never silent without a reason.

 A bot that is running tools can be quiet for half a minute, and on a call half a minute of nothing
 sounds like a dropped line. So while the bot works and nothing has been said for `quiet` seconds, a
 short line ("One moment…", "Let me look that up…") is said, fitting the tool that runs. Never more
 than one every `spacing` seconds, not when the bot said a line of its own within that time (the gateway
 asks it to announce its tools, and two announcements are one too many), and never the same line
 twice in a row.

 Times are seconds on any clock that does not jump; the model passes its own.
 */
public struct VoiceFillerPolicy: Sendable, Equatable {
  public var quiet: Double
  public var spacing: Double
  /// How many lines each kind has.
  public var variants: [VoiceFillerKind: Int]

  private var lastSpeech: Double?
  private var lastFiller: Double?
  private var lastBotLine: Double?
  private var tool: String?
  private var said: VoiceFiller?

  public init(quiet: Double = 3, spacing: Double = 12, variants: [VoiceFillerKind: Int] = [:]) {
    self.quiet = quiet
    self.spacing = spacing
    self.variants = variants
  }

  /// A turn of ours began at `now`: the quiet is counted from here.
  public mutating func began(at now: Double) {
    lastSpeech = now
    tool = nil
  }

  /// The bot's own words were said (started) at `now`.
  public mutating func botSpoke(at now: Double) {
    lastSpeech = now
    lastBotLine = now
  }

  /// A tool started; its name chooses the next line.
  public mutating func toolStarted(_ name: String) {
    tool = name
  }

  /// Whether a line is due at `now`, while the bot works.
  public func due(at now: Double) -> Bool {
    // A timer set for the moment it is due may land a hair before it.
    let slack = 0.001

    guard let lastSpeech, now - lastSpeech >= quiet - slack else {
      return false
    }

    if let lastFiller, now - lastFiller < spacing - slack {
      return false
    }

    if let lastBotLine, now - lastBotLine < spacing - slack {
      return false
    }

    return true
  }

  /// How long from `now` until a line could next be due (for the model's timer); at least a tenth of
  /// a second.
  public func wait(from now: Double) -> Double {
    let quietEnds = (lastSpeech ?? now) + quiet
    let fillerEnds = (lastFiller ?? -Double.infinity) + spacing
    let botEnds = (lastBotLine ?? -Double.infinity) + spacing
    return max(0.1, max(quietEnds, fillerEnds, botEnds) - now)
  }

  /// The line to say at `now`, recorded as said.
  public mutating func next(at now: Double) -> VoiceFiller {
    let kind = VoiceFillerKind.of(tool: tool)
    let count = max(1, variants[kind] ?? 1)
    var variant = Int(now.rounded(.down)) % count

    if let said, said.kind == kind, said.variant == variant {
      variant = (variant + 1) % count
    }

    let filler = VoiceFiller(kind: kind, variant: variant)
    said = filler
    lastFiller = now
    lastSpeech = now
    return filler
  }
}

/**
 The last few things said on the call, for `voice_context`: the reader's words and what was read of the
 bot's replies, plain text, oldest first, newest last, never more than `limit` characters. A reply
 that was cut off is recorded as far as it was heard, which is what the reader knows of it.
 */
public struct VoiceContextLog: Sendable, Equatable {
  public enum Speaker: String, Sendable {
    case user = "User"
    case assistant = "Assistant"
  }

  public struct Entry: Sendable, Equatable {
    public var speaker: Speaker
    public var text: String
  }

  public var limit: Int
  public var keep: Int
  public private(set) var entries: [Entry] = []

  public init(limit: Int = 6000, keep: Int = 8) {
    self.limit = limit
    self.keep = keep
  }

  public mutating func add(_ speaker: Speaker, _ text: String) {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !words.isEmpty else {
      return
    }

    entries.append(Entry(speaker: speaker, text: words))

    if entries.count > keep {
      entries.removeFirst(entries.count - keep)
    }
  }

  /// The log as one text, newest last, cut from the front to `limit` characters; nil when empty.
  public func rendered() -> String? {
    var lines: [String] = []
    var length = 0

    for entry in entries.reversed() {
      let line = "\(entry.speaker.rawValue): \(entry.text)"
      let added = line.count + (lines.isEmpty ? 0 : 1)

      if length + added > limit {
        let room = limit - length - (lines.isEmpty ? 0 : 1)

        if lines.isEmpty, room > 0 {
          // One entry longer than the whole budget: its end is the part that matters.
          lines.insert(String(line.suffix(room)), at: 0)
        }

        break
      }

      lines.insert(line, at: 0)
      length += added
    }

    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }
}
