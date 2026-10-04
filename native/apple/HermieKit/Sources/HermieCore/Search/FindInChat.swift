import Foundation
import HermieTranscript

/// Finding the row a search hit is about, inside the chat it names (`features/search/find-in-chat.ts`).
///
/// This exists because the gateway will not say: `GET /api/sessions/search` projects no message id and
/// no message timestamp (`SessionSearch`), so a hit points at a conversation and the row has to be found
/// again on this side, from the same words the reader typed.
///
/// The rule is FTS5's, near enough to be honest about: a bare term matches a word that starts with it, a
/// quoted term matches that substring, and every term has to land in the same row. Near enough, because
/// the index is built over the JSON-encoded message and this searches the projected item, so a row the
/// gateway matched on its tool arguments will not be found here, and the caller has to cope with not
/// finding one (`ChatFindWalk`).
public enum FindInChat {
  /// How many pages of older history a search may walk back through before it says the words are not there.
  public static let pageLimit = 200

  public struct Term: Sendable, Equatable {
    public var needle: String
    public var phrase: Bool

    public init(needle: String, phrase: Bool) {
      self.needle = needle
      self.phrase = phrase
    }
  }

  /// The terms a query is made of, lower-cased; a trailing `*` is already implied.
  ///
  /// Tokens are `"[^"]*"` or a run of non-space characters, as the reference scans them, including its
  /// reading of an unterminated quote: `"fo` is one token that starts with a quote, so it is a phrase
  /// with the first and last characters cut off.
  public static func terms(_ query: String) -> [Term] {
    let scalars = Array(JSSpace.trim(query).unicodeScalars)
    var terms: [Term] = []
    var position = 0

    while position < scalars.count {
      if JSSpace.isSpace(scalars[position]) {
        position += 1
        continue
      }

      var end = position

      if scalars[position] == "\"", let closing = scalars[(position + 1)...].firstIndex(of: "\"") {
        end = closing + 1
      } else {
        while end < scalars.count, !JSSpace.isSpace(scalars[end]) {
          end += 1
        }
      }

      let token = Array(scalars[position..<end])
      position = end

      let phrase = token.first == "\""
      var inner: [Unicode.Scalar]

      if phrase {
        inner = token.count >= 2 ? Array(token[1..<(token.count - 1)]) : []
      } else {
        inner = token

        while inner.last == "*" {
          inner.removeLast()
        }
      }

      let needle = JSSpace.trim(JSSpace.string(inner)).lowercased()

      if !needle.isEmpty {
        terms.append(Term(needle: needle, phrase: phrase))
      }
    }

    return terms
  }

  /// What a reader would consider this row's words.
  public static func text(of item: TranscriptItem) -> String {
    switch item {
    case .user(let item):
      return item.text
    case .assistant(let item):
      return item.text
    case .botDmIn(let item):
      return item.text
    case .status(let item):
      return item.text
    case .botDmOut(let item):
      // The dispatch, the teammate's answer, or both: a reader searching for what was said to
      // @writer means either side of that exchange.
      return "\(item.targetHandle) \(item.message)\n\(item.reply?.text ?? "")"
    case .cronDelivery(let item):
      return "\(item.jobName)\n\(item.body)"
    case .notice(let item):
      return "\(item.title)\n\(item.body ?? "")"
    default:
      return ""
    }
  }

  /// Whether every term lands in `text`.
  public static func matches(_ text: String, terms: [Term]) -> Bool {
    guard !terms.isEmpty else {
      return false
    }

    let haystack = text.lowercased()
    let haystackWords = words(of: haystack)

    return terms.allSatisfy { term in
      term.phrase ? haystack.contains(term.needle) : haystackWords.contains { $0.hasPrefix(term.needle) }
    }
  }

  /// The runs of letters and numbers (`\p{L}`, `\p{N}`) a text is made of.
  static func words(of text: String) -> [String] {
    var words: [String] = []
    var current = String.UnicodeScalarView()

    for scalar in text.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber,
        .letterNumber, .otherNumber:
        current.append(scalar)
      default:
        if !current.isEmpty {
          words.append(String(current))
          current = String.UnicodeScalarView()
        }
      }
    }

    if !current.isEmpty {
      words.append(String(current))
    }

    return words
  }

  /// The id of the newest item that matches, or nil.
  ///
  /// Newest rather than oldest: the gateway ranked its hit by relevance and cannot tell us which row it
  /// picked, so any choice here is this client's. The newest is the one a reader means by "where did we
  /// talk about that", and it needs the least history loaded to reach.
  public static func newestMatch(in items: [VisibleItem], query: String) -> String? {
    let parsed = terms(query)

    guard !parsed.isEmpty else {
      return nil
    }

    return items.last { matches(text(of: $0.item), terms: parsed) }?.item.id
  }
}
