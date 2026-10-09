import Foundation
import HermieProtocol

// The pages a reply used: `sources` on a `message.complete` and `display_metadata.sources` on a history row.
//
// The contract is `contract/sources/` (the gateway fork's `contract/sources/`, copied byte for byte): one
// entry is `{url, title, via}`, nothing else. The gateway builds the list from the results of the turn's
// own web tools, never from the model's text, and a page can claim any title; so a client reads an entry as
// strictly as the schema says and shows the domain beside the title (`ReplySource.domain`). This is the
// strict reader of one: what does not satisfy the schema is dropped, never repaired, and the rest is kept.
//
// - `url` is `http` or `https` with a host and no user info, at most 2048 characters and no white space, as
//   the tool returned it. Anything else is not an entry (a `javascript:` or `file:` address, a login in the
//   address, a host-less `https:///path`).
// - `title` is at most 160 characters and may be empty. It is text, never markup.
// - `via` is `read` or `found`. A value a newer gateway may add is not an entry: a source this client could
//   not place in a section would be listed under the wrong heading.
// - A key the schema does not have drops the entry (`additionalProperties: false`).
// - The list is capped at 24 entries and holds each `url` once (the first stays), whatever the gateway sent.
// - Absent, not a list, or no entry that fits is no sources. The model keeps `nil` for none, never `[]`.
//
// A client never loads anything for an entry (no favicon, no preview, no request to the page or to a third
// party) and opens its URL only on the person's own tap.

/// How a reply used a page.
public enum ReplySourceVia: String, Sendable, Hashable, CaseIterable {
  /// `web_extract` fetched the page.
  case read
  /// `web_search` returned the result.
  case found
}

/// One page a reply used.
public struct ReplySource: TranscriptJSONCodable, Hashable, Sendable, Identifiable {
  public var url: String
  /// What the page called itself. May be empty. Plain text.
  public var title: String
  public var via: ReplySourceVia

  public var id: String { url }

  public init(url: String, title: String, via: ReplySourceVia) {
    self.url = url
    self.title = title
    self.via = via
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    guard let parsed = Self.parse(json) else {
      throw TranscriptDecodingError(path: path, message: "expected a source")
    }
    self = parsed
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("url", url)
    writer.set("title", title)
    writer.set("via", via.rawValue)
    return writer.json
  }

  // MARK: Reading

  /// `maxItems` of the schema: the most sources one reply keeps.
  public static let maximumCount = 24
  public static let maximumURLLength = 2048
  public static let maximumTitleLength = 160

  private static let keys: Set<String> = ["url", "title", "via"]

  /// One entry as the wire carries it, or `nil` when it is not one.
  public static func parse(_ value: JSONValue) -> ReplySource? {
    guard case .object(let object) = value, object.keys.allSatisfy(keys.contains),
      case .string(let url)? = object["url"], isValidURL(url),
      case .string(let title)? = object["title"], title.unicodeScalars.count <= maximumTitleLength,
      case .string(let via)? = object["via"], let kind = ReplySourceVia(rawValue: via)
    else {
      return nil
    }

    return ReplySource(url: url, title: title, via: kind)
  }

  /// The `sources` of a frame or of a row's metadata: the valid entries, in order, each address once, at
  /// most 24. Anything else (absent, not a list, `[]`, nothing valid) is no sources.
  public static func parseAll(_ value: JSONValue?) -> [ReplySource] {
    guard case .array(let entries)? = value else { return [] }
    var seen = Set<String>()
    var kept: [ReplySource] = []

    for entry in entries {
      guard let source = parse(entry), seen.insert(source.url).inserted else { continue }
      kept.append(source)
      if kept.count == maximumCount { break }
    }

    return kept
  }

  /// The `sources` out of a history row's `display_metadata` (an object, or the JSON text of one).
  public static func parseAll(fromMetadata metadata: JSONValue?) -> [ReplySource] {
    switch metadata {
    case .object(let object)?:
      return parseAll(object["sources"])
    case .string(let text)?:
      guard let parsed = JS.parseJSON(text), case .object = parsed else { return [] }
      return parseAll(fromMetadata: parsed)
    default:
      return []
    }
  }

  /// The schema's `url`: `^[Hh][Tt][Tt][Pp][Ss]?://[^\s@/?#]+(?:[/?#][^\s]*)?$`, at most 2048 characters. Written
  /// out by hand because the pattern is ECMAScript's, whose `\s` is not Foundation's.
  static func isValidURL(_ url: String) -> Bool {
    let scalars = Array(url.unicodeScalars)
    guard !scalars.isEmpty, scalars.count <= maximumURLLength else { return false }

    let head = prefixLength(scalars)
    guard head > 0 else { return false }

    var index = head
    // The authority: one or more characters that are not white space, `@`, `/`, `?` or `#`.
    while index < scalars.count, !"/?#@".unicodeScalars.contains(scalars[index]), !isSpace(scalars[index]) {
      index += 1
    }
    guard index > head else { return false }
    guard index < scalars.count else { return true }

    // What follows starts at `/`, `?` or `#`, and holds no white space. A `@` here is part of a path.
    guard "/?#".unicodeScalars.contains(scalars[index]) else { return false }
    return scalars[index...].allSatisfy { !isSpace($0) }
  }

  /// The length of `http://` or `https://` (any case) at the start, or 0.
  private static func prefixLength(_ scalars: [Unicode.Scalar]) -> Int {
    for scheme in ["http://", "https://"] {
      let wanted = Array(scheme.unicodeScalars)
      guard scalars.count > wanted.count else { continue }
      let matches = zip(scalars, wanted).allSatisfy { Self.lower($0) == $1 }
      if matches { return wanted.count }
    }
    return 0
  }

  private static func lower(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
    (0x41...0x5A).contains(scalar.value) ? Unicode.Scalar(scalar.value + 0x20)! : scalar
  }

  private static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
    scalar.value <= 0xFFFF && JS.isWhitespace(UInt16(scalar.value))
  }

  // MARK: Showing

  /// The host of `url` exactly as the gateway sent it (it is ASCII, punycode for an international name), without
  /// the port: the part of a source that is always shown beside its title, so a title can never pass for the
  /// destination. Nothing is lowered, shortened or prettified. A bracketed IPv6 address keeps its brackets.
  /// Empty only for a value that is not an entry's address.
  public var domain: String {
    Self.domain(of: url)
  }

  public static func domain(of url: String) -> String {
    guard isValidURL(url), let separator = url.range(of: "://") else { return "" }

    let rest = url[separator.upperBound...]
    let authority = rest.prefix { !"/?#".contains($0) }
    var host = String(authority)

    if host.hasPrefix("[") {
      if let close = host.firstIndex(of: "]") {
        host = String(host[...close])
      }
    } else if let colon = host.lastIndex(of: ":"), host[host.index(after: colon)...].allSatisfy(\.isNumber) {
      host = String(host[..<colon])
    }

    return host
  }

  /// The domain as it is compared and coloured: lower case, without a leading `www.`, so `www.example.org`
  /// and `example.org` are one site. Never shown.
  public static func siteKey(of domain: String) -> String {
    let lowered = domain.lowercased()
    return lowered.hasPrefix("www.") && lowered.count > 4 ? String(lowered.dropFirst(4)) : lowered
  }

  /// The letter a source's monogram shows: the first letter or digit of its domain (past a leading `www.`),
  /// upper case; `#` when it has none.
  public var monogram: Character {
    Self.monogram(of: domain)
  }

  public static func monogram(of domain: String) -> Character {
    siteKey(of: domain).first { $0.isLetter || $0.isNumber }.map { Character($0.uppercased()) } ?? "#"
  }

  /// A hue in `0..<1` that is the same for the same domain on every launch and device (a hash of the domain's
  /// bytes; Swift's `hashValue` is seeded per process), so a source keeps its colour.
  public var hue: Double {
    Self.hue(of: domain)
  }

  public static func hue(of domain: String) -> Double {
    // FNV-1a, 32 bits.
    var hash: UInt32 = 2_166_136_261
    for byte in siteKey(of: domain).utf8 {
      hash = (hash ^ UInt32(byte)) &* 16_777_619
    }
    return Double(hash % 360) / 360
  }
}

extension ReplySource: JSONField {}
