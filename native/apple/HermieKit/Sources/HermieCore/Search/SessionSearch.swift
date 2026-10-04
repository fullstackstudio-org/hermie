import Foundation
import HermieProtocol

/// `GET /api/sessions/search`, the gateway's full-text search over transcripts, read the way
/// `packages/gateway-client/src/session-search.ts` reads it (`contract/gateway/vectors/session-search.json`
/// holds the recorded answers, and `SessionSearchVectorTests` replays them).
///
/// Three facts about that route decide everything built on it, and each is the opposite of what the
/// name suggests:
///
/// 1. **It is scoped to one profile.** A profile's sessions live in its own `state.db`, so searching a
///    roster is one request per bot (`MessageSearchModel`).
/// 2. **It answers at most one hit per conversation**, collapsed onto the compression lineage root with
///    the best-ranked snippet. "Every message that matches" cannot be built on it.
/// 3. **A hit does not name a message.** No row id and no message timestamp: all a tap can open is the
///    conversation, and finding the row inside it is the client's own problem (`FindInChat`).
///
/// `limit` is clamped to 1…100 server-side; a blank `q` answers `{"results": []}` without touching the
/// database, so a blank query never leaves the device.

/// One conversation that matched.
public struct SessionSearchHit: Sendable, Equatable {
  /// The lineage TIP: the session id that is live today.
  public var sessionID: String
  /// The compression root the tip was found from, when the gateway names one.
  public var lineageRoot: String?
  /// The gateway's snippet, markers (`>>>` / `<<<`) and all. See `SessionSearch.snippetSegments`.
  public var snippet: String
  public var role: String?
  public var title: String?
  /// Seconds since the epoch: `last_active`, else `started_at`, else the hit's own session stamp.
  public var at: Double?
  public var messageCount: Double?
  public var archived: Bool

  public init(
    sessionID: String,
    lineageRoot: String? = nil,
    snippet: String = "",
    role: String? = nil,
    title: String? = nil,
    at: Double? = nil,
    messageCount: Double? = nil,
    archived: Bool = false
  ) {
    self.sessionID = sessionID
    self.lineageRoot = lineageRoot
    self.snippet = snippet
    self.role = role
    self.title = title
    self.at = at
    self.messageCount = messageCount
    self.archived = archived
  }

  /// The camel-cased object the TypeScript reference returns, with absent fields left out.
  var jsonValue: JSONValue {
    var object: JSONObject = [
      "sessionId": .string(sessionID),
      "snippet": .string(snippet),
      "archived": .bool(archived)
    ]

    if let lineageRoot { object["lineageRoot"] = .string(lineageRoot) }
    if let role { object["role"] = .string(role) }
    if let title { object["title"] = .string(title) }
    if let at { object["at"] = .number(at) }
    if let messageCount { object["messageCount"] = .number(messageCount) }

    return .object(object)
  }
}

/// One run of a snippet: plain text, or what the gateway's index matched.
public struct SnippetSegment: Sendable, Equatable {
  public var text: String
  public var match: Bool

  public init(text: String, match: Bool) {
    self.text = text
    self.match = match
  }
}

public enum SessionSearch {
  /// The server's own clamp on `limit`, mirrored so a caller can stay inside it.
  public static let limitCap = 100

  /// What `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)` wraps a match in.
  public static let matchOpen = ">>>"
  public static let matchClose = "<<<"

  // MARK: The request

  /// The path and query of one search, or `nil` for a blank query (which never leaves the device).
  /// Percent-encoded with the unreserved set only, so a `*` or a quote in what was typed reaches the
  /// gateway as typed.
  public static func path(query: String, profile: String?, limit: Int?) -> String? {
    let trimmed = JSSpace.trim(query)

    guard !trimmed.isEmpty else {
      return nil
    }

    let clamped = max(1, min(limit ?? 20, limitCap))
    var path = "\(RESTPath.sessionSearch)?q=\(encode(trimmed))&limit=\(clamped)"

    if let profile, !profile.isEmpty {
      path += "&profile=\(encode(profile))"
    }

    return path
  }

  /// ASCII letters and digits and `-._~`: everything else is percent-encoded, non-ASCII included.
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  private static func encode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  // MARK: The answer

  /// One `results` row. A row that names no session is dropped rather than repaired: every caller's
  /// next move is to address that session.
  public static func hit(of row: JSONValue) -> SessionSearchHit? {
    guard case .object(let source) = row else {
      return nil
    }

    guard let sessionID = nonBlank(source["session_id"]) ?? nonBlank(source["id"]) else {
      return nil
    }

    let at = finite(source["last_active"]) ?? finite(source["started_at"]) ?? finite(source["session_started"])

    return SessionSearchHit(
      sessionID: sessionID,
      lineageRoot: nonBlank(source["lineage_root"]),
      snippet: source["snippet"]?.stringValue ?? "",
      role: nonBlank(source["role"]),
      title: nonBlank(source["title"]),
      at: at,
      messageCount: finite(source["message_count"]),
      archived: source["archived"] == .bool(true)
    )
  }

  /// Every readable row of a `{ results: [...] }` body, in order, duplicates kept.
  public static func parse(_ body: JSONValue?) -> [SessionSearchHit] {
    guard let rows = body?["results"]?.arrayValue else {
      return []
    }

    return rows.compactMap(hit(of:))
  }

  /// A string that is not blank; the value keeps its original (untrimmed) text.
  private static func nonBlank(_ value: JSONValue?) -> String? {
    guard let text = value?.stringValue, !JSSpace.trim(text).isEmpty else {
      return nil
    }

    return text
  }

  private static func finite(_ value: JSONValue?) -> Double? {
    guard let number = value?.doubleValue, number.isFinite else {
      return nil
    }

    return number
  }

  // MARK: The snippet

  /// Split a snippet into plain and matched runs.
  ///
  /// `>>>` and `<<<` are ordinary characters a message may legitimately contain (a shell redirect, a
  /// diff conflict marker), so an unpaired opener is text, not the start of a highlight that runs to
  /// the end of the line. The first opener pairs with the first closer after it.
  public static func snippetSegments(_ snippet: String) -> [SnippetSegment] {
    let open = Array(matchOpen.unicodeScalars)
    let close = Array(matchClose.unicodeScalars)
    let scalars = Array(snippet.unicodeScalars)
    var segments: [SnippetSegment] = []
    var plain: [Unicode.Scalar] = []
    var position = 0

    func flush() {
      if !plain.isEmpty {
        segments.append(SnippetSegment(text: JSSpace.string(plain), match: false))
        plain = []
      }
    }

    while position < scalars.count {
      guard let opening = find(open, in: scalars, from: position),
        let closing = find(close, in: scalars, from: opening + open.count)
      else {
        plain.append(contentsOf: scalars[position...])
        break
      }

      plain.append(contentsOf: scalars[position..<opening])
      flush()
      segments.append(SnippetSegment(text: JSSpace.string(scalars[(opening + open.count)..<closing]), match: true))
      position = closing + close.count
    }

    flush()

    return segments
  }

  /// The snippet tidied for display, WITH its markers.
  ///
  /// Two cosmetic passes, both there because of what the index holds: the FTS row is the JSON-encoded
  /// message, so a window into it routinely opens or closes mid-structure. Whitespace is collapsed
  /// (a snippet can span a fenced code block), and a run of JSON punctuation is trimmed off each end
  /// only, never from the middle, where it may be the message's own text. The markers survive: the
  /// highlight is the gateway's account of what was matched, and a client cannot re-derive it.
  public static func tidySnippet(_ snippet: String) -> String {
    // `\s+` -> " ", then trim.
    var collapsed: [Unicode.Scalar] = []
    var inSpace = false

    for scalar in snippet.unicodeScalars {
      if JSSpace.isSpace(scalar) {
        if !inSpace {
          collapsed.append(" ")
        }

        inSpace = true
      } else {
        collapsed.append(scalar)
        inSpace = false
      }
    }

    var scalars = Array(JSSpace.trim(JSSpace.string(collapsed)).unicodeScalars)

    // `^[{}[\]",:\\]+\s*`
    var start = 0

    while start < scalars.count, isJSONPunctuation(scalars[start]) {
      start += 1
    }

    if start > 0 {
      while start < scalars.count, JSSpace.isSpace(scalars[start]) {
        start += 1
      }

      scalars.removeFirst(start)
    }

    // `\s*[{}[\]",:\\]+$`
    var end = scalars.count

    while end > 0, isJSONPunctuation(scalars[end - 1]) {
      end -= 1
    }

    if end < scalars.count {
      while end > 0, JSSpace.isSpace(scalars[end - 1]) {
        end -= 1
      }

      scalars.removeSubrange(end...)
    }

    return JSSpace.string(scalars)
  }

  /// The same text with the markers taken out: a snippet as one line of prose.
  public static func plainSnippet(_ snippet: String) -> String {
    snippetSegments(tidySnippet(snippet)).map(\.text).joined()
  }

  private static func isJSONPunctuation(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "{", "}", "[", "]", "\"", ",", ":", "\\": true
    default: false
    }
  }

  /// The first index at or after `from` where `needle` starts, comparing scalars exactly.
  private static func find(_ needle: [Unicode.Scalar], in haystack: [Unicode.Scalar], from: Int) -> Int? {
    guard !needle.isEmpty, haystack.count >= needle.count, from <= haystack.count - needle.count else {
      return nil
    }

    for index in from...(haystack.count - needle.count) where haystack[index] == needle[0] {
      if haystack[index..<(index + needle.count)].elementsEqual(needle) {
        return index
      }
    }

    return nil
  }
}

/// JavaScript's `\s` and `String.prototype.trim` set: ECMAScript WhiteSpace and LineTerminator.
/// Foundation's `.whitespacesAndNewlines` differs at the edges (it has U+0085 and U+180E and leaves out
/// U+FEFF), so the set is written out.
enum JSSpace {
  static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
      0xFEFF:
      true
    default:
      false
    }
  }

  static func trim(_ value: String) -> String {
    let scalars = Array(value.unicodeScalars)
    var start = 0
    var end = scalars.count

    while start < end, isSpace(scalars[start]) {
      start += 1
    }

    while end > start, isSpace(scalars[end - 1]) {
      end -= 1
    }

    return string(scalars[start..<end])
  }

  static func string<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars)
    return String(view)
  }
}
