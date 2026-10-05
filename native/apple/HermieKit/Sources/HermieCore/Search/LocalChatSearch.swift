import Foundation
import HermieProtocol
import HermieStore
import HermieTranscript

/// The newest message of a local transcript that holds every word asked for.
public struct LocalChatHit: Sendable, Equatable {
  public var messageID: String
  /// The words around the match, cut and marked the way the gateway's own snippet is (`>>>` / `<<<`).
  public var snippet: String
  public var at: Double?

  public init(messageID: String, snippet: String, at: Double? = nil) {
    self.messageID = messageID
    self.snippet = snippet
    self.at = at
  }
}

/**
 Searching the transcript this device kept, the other half of "search everywhere".

 The gateway's search is the authority and the only one that sees every conversation of a bot; this
 one sees what the chat cache holds (a bot's Bot Chat, its last `ChatCacheLimits.items` items) and so
 answers when the gateway cannot: offline, signed out, a timeout. It reads the same words the same
 way (`FindInChat`: a bare term is a word prefix, a quoted one a substring, every term in one
 message), so a hit here is a row the chat itself would find, and the two halves agree about what a
 query means.

 It never reads a cache the reader switched off (`ChatCacheSwitch`): the cache is then empty and so
 is this.
 */
public enum LocalChatSearch {
  /// How many characters of context stand on each side of the match in a snippet.
  public static let radius = 40

  /// The messages of a cache snapshot that have words in them, oldest first.
  public static func messages(of snapshot: HermieTranscript.CachedTranscript) -> [CachedMessage] {
    let fallback = snapshot.updatedAt > 0 ? snapshot.updatedAt / 1000 : nil

    return snapshot.items.compactMap { item in
      let text = FindInChat.text(of: item)

      guard !text.isEmpty else {
        return nil
      }

      return CachedMessage(id: item.base.id, text: text, at: item.base.ts ?? fallback)
    }
  }

  /// A bot's cached chat as messages, or nil where nothing readable is kept.
  public static func read(cache: any ChatCaching, bot: String) async -> [CachedMessage]? {
    guard let row = try? await cache.read(bot: bot),
      let value = try? JSONValue(parsing: row.itemsJSON),
      let snapshot = try? HermieTranscript.CachedTranscript(decoding: value)
    else {
      return nil
    }

    return messages(of: snapshot)
  }

  /// The newest message that holds the query, or nil. Newest, as `FindInChat.newestMatch` has it: the
  /// one a reader means by "where did we talk about that".
  public static func hit(in messages: [CachedMessage], query: String) -> LocalChatHit? {
    let terms = FindInChat.terms(query)

    guard !terms.isEmpty,
      let message = messages.last(where: { FindInChat.matches($0.text, terms: terms) })
    else {
      return nil
    }

    return LocalChatHit(
      messageID: message.id, snippet: snippet(of: message.text, terms: terms), at: message.at)
  }

  // MARK: The snippet

  /// `text` cut to a window around the first match, whitespace collapsed, every matched run inside the
  /// window between `>>>` and `<<<`, and `...` where it was cut: the shape `snippet(messages_fts, -1,
  /// '>>>', '<<<', '...', 40)` gives, so one drawing (`MessageSnippet`) serves both.
  public static func snippet(of text: String, terms: [FindInChat.Term], radius: Int = Self.radius) -> String {
    let scalars = collapsed(text)
    let lower = scalars.map(lowered)
    let ranges = matchRanges(in: lower, terms: terms)

    guard let first = ranges.min(by: { $0.lowerBound < $1.lowerBound }) else {
      return JSSpace.string(scalars.prefix(radius * 2))
    }

    var start = max(0, first.lowerBound - radius)
    var end = min(scalars.count, first.upperBound + radius)

    // Whole words at the edges, where a space is near.
    if start > 0, let space = scalars[start..<first.lowerBound].firstIndex(of: " ") {
      start = space + 1
    }

    if end < scalars.count, let space = scalars[first.upperBound..<end].lastIndex(of: " ") {
      end = space
    }

    let inside = merged(ranges.compactMap { clip($0, to: start..<end) })
    var out = String.UnicodeScalarView()

    if start > 0 {
      out.append(contentsOf: "...".unicodeScalars)
    }

    var cursor = start

    for range in inside {
      out.append(contentsOf: scalars[cursor..<range.lowerBound])
      out.append(contentsOf: SessionSearch.matchOpen.unicodeScalars)
      out.append(contentsOf: scalars[range])
      out.append(contentsOf: SessionSearch.matchClose.unicodeScalars)
      cursor = range.upperBound
    }

    out.append(contentsOf: scalars[cursor..<end])

    if end < scalars.count {
      out.append(contentsOf: "...".unicodeScalars)
    }

    return String(out)
  }

  /// Whitespace runs as one space, the ends trimmed (the same set `\s` means).
  private static func collapsed(_ text: String) -> [Unicode.Scalar] {
    var scalars: [Unicode.Scalar] = []
    var inSpace = true

    for scalar in text.unicodeScalars {
      if JSSpace.isSpace(scalar) {
        if !inSpace {
          scalars.append(" ")
        }

        inSpace = true
      } else {
        scalars.append(scalar)
        inSpace = false
      }
    }

    if scalars.last == " " {
      scalars.removeLast()
    }

    return scalars
  }

  /// One scalar lower-cased to one scalar, so an index in the lower-cased text is an index in the text.
  private static func lowered(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
    let mapped = scalar.properties.lowercaseMapping.unicodeScalars

    return mapped.count == 1 ? mapped[mapped.startIndex] : scalar
  }

  /// Every run a term matched: the whole word for a bare term (a prefix of it), the substring for a
  /// quoted one.
  private static func matchRanges(in lower: [Unicode.Scalar], terms: [FindInChat.Term]) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    let words = wordRanges(in: lower)

    for term in terms {
      let needle = term.needle.unicodeScalars.map(lowered)

      guard !needle.isEmpty else {
        continue
      }

      if term.phrase {
        var from = 0

        while let found = find(needle, in: lower, from: from) {
          ranges.append(found..<(found + needle.count))
          from = found + needle.count
        }
      } else {
        for word in words where word.count >= needle.count && lower[word].starts(with: needle) {
          ranges.append(word)
        }
      }
    }

    return ranges
  }

  /// The runs of letters and numbers, as `FindInChat.words(of:)` reads them.
  private static func wordRanges(in lower: [Unicode.Scalar]) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    var start: Int?

    for (index, scalar) in lower.enumerated() {
      if isWordScalar(scalar) {
        start = start ?? index
      } else if let begin = start {
        ranges.append(begin..<index)
        start = nil
      }
    }

    if let begin = start {
      ranges.append(begin..<lower.count)
    }

    return ranges
  }

  private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber,
      .letterNumber, .otherNumber:
      true
    default:
      false
    }
  }

  private static func find(_ needle: [Unicode.Scalar], in haystack: [Unicode.Scalar], from: Int) -> Int? {
    guard haystack.count >= needle.count, from <= haystack.count - needle.count else {
      return nil
    }

    for index in from...(haystack.count - needle.count) where haystack[index] == needle[0] {
      if haystack[index..<(index + needle.count)].elementsEqual(needle) {
        return index
      }
    }

    return nil
  }

  private static func clip(_ range: Range<Int>, to window: Range<Int>) -> Range<Int>? {
    let lower = max(range.lowerBound, window.lowerBound)
    let upper = min(range.upperBound, window.upperBound)

    return lower < upper ? lower..<upper : nil
  }

  /// Overlapping and touching runs as one, in order.
  private static func merged(_ ranges: [Range<Int>]) -> [Range<Int>] {
    var result: [Range<Int>] = []

    for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
      if let last = result.last, range.lowerBound <= last.upperBound {
        result[result.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
      } else {
        result.append(range)
      }
    }

    return result
  }
}
