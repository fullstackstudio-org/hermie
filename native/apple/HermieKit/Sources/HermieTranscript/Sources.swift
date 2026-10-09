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
// - `url` is `http` or `https` with a host and no user info, at most 2048 characters, no white space and no
//   control or format character. The gateway stores the scheme and the host in lower case ASCII (punycode for
//   a name that is not), so an upper case or Unicode host is not an entry. The reader takes the address as it
//   comes and never normalises it. Anything else is not an entry (a `javascript:` or `file:` address, a login
//   in the address, a host-less `https:///path`, a port past 65535).
// - `title` is at most 160 characters (code points, as the schema counts them) and may be empty. It is text,
//   never markup.
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
      guard let parsed = JS.parseJSON(text) else { return [] }
      return parseAll(fromMetadata: parsed)
    default:
      return []
    }
  }

  /// The schema's `url` (`contract/sources/schema.json`), written out by hand because its pattern is ECMAScript's
  /// (its `\s` is not Foundation's): the scheme and the host in lower case ASCII, an IPv6 address in brackets,
  /// an optional port of one to five digits, then a path, query and fragment with no white space, no control
  /// character and none of the invisible format characters the schema lists. On top of the pattern, the
  /// contract's prose: no character of category `Cf` anywhere, and a port of at most 65535. (A lone surrogate
  /// cannot be in a Swift string.) At most 2048 characters, counted as code points.
  static func isValidURL(_ url: String) -> Bool {
    let scalars = Array(url.unicodeScalars)
    guard !scalars.isEmpty, scalars.count <= maximumURLLength else { return false }
    guard !scalars.contains(where: { $0.properties.generalCategory == .format }) else { return false }

    var index = 0
    func take(_ text: String) -> Bool {
      let wanted = Array(text.unicodeScalars)
      guard scalars.count >= index + wanted.count, Array(scalars[index..<index + wanted.count]) == wanted else {
        return false
      }
      index += wanted.count
      return true
    }

    guard take("http") else { return false }
    _ = take("s")
    guard take("://") else { return false }

    // The host: dot separated labels of `[a-z0-9-]`, or an IPv6 address of `[0-9a-f:.]` in brackets.
    if index < scalars.count, scalars[index] == "[" {
      index += 1
      let start = index
      while index < scalars.count, isIPv6Character(scalars[index]) { index += 1 }
      guard index > start, index < scalars.count, scalars[index] == "]" else { return false }
      index += 1
    } else {
      var labelLength = 0
      let hostStart = index
      while index < scalars.count {
        let scalar = scalars[index]
        if isHostCharacter(scalar) {
          labelLength += 1
        } else if scalar == ".", labelLength > 0 {
          labelLength = 0
        } else {
          break
        }
        index += 1
      }
      // A label may not be empty: nothing at all, or a dot with nothing after it.
      guard labelLength > 0 else { return false }
      guard !isNonCanonicalNumericHost(Array(scalars[hostStart..<index])) else { return false }
    }

    if index < scalars.count, scalars[index] == ":" {
      index += 1
      let start = index
      var port = 0
      while index < scalars.count, (0x30...0x39).contains(scalars[index].value) {
        port = port * 10 + Int(scalars[index].value - 0x30)
        index += 1
        if index - start > 5 { return false }
      }
      guard index > start, port <= 65_535 else { return false }
    }

    guard index < scalars.count else { return true }
    guard scalars[index] == "/" || scalars[index] == "?" || scalars[index] == "#" else { return false }
    return scalars[index...].allSatisfy { !isExcludedInTail($0) }
  }

  /// A host whose last label reads as a number to a URL parser (all digits, or `0x` and hex digits: `127.1`,
  /// `0x7f`, `2130706433`) is only a host when it is the canonical dotted quad: four decimal parts of 0 to 255
  /// with no leading zero. `127.1`, `0x7f.1`, `0177.0.0.1`, `127.000.0.1` and `a.123` are not entries.
  private static func isNonCanonicalNumericHost(_ host: [Unicode.Scalar]) -> Bool {
    let labels = host.split(separator: ".", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
    guard let last = labels.last else { return false }

    let isDigits = !last.isEmpty && last.utf8.allSatisfy { (0x30...0x39).contains($0) }
    let isHex = last.hasPrefix("0x") && last.dropFirst(2).utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    guard isDigits || isHex else { return false }

    guard labels.count == 4 else { return true }
    return !labels.allSatisfy { label in
      guard !label.isEmpty, label.utf8.allSatisfy({ (0x30...0x39).contains($0) }), label.count <= 3 else { return false }
      return (label == "0" || !label.hasPrefix("0")) && Int(label)! <= 255
    }
  }

  private static func isHostCharacter(_ scalar: Unicode.Scalar) -> Bool {
    (0x61...0x7A).contains(scalar.value) || (0x30...0x39).contains(scalar.value) || scalar == "-"
  }

  private static func isIPv6Character(_ scalar: Unicode.Scalar) -> Bool {
    (0x30...0x39).contains(scalar.value) || (0x61...0x66).contains(scalar.value) || scalar == ":" || scalar == "."
  }

  /// What the schema's pattern refuses after the host: `\s`, C0 and C1 controls, and the invisible characters it
  /// lists.
  private static func isExcludedInTail(_ scalar: Unicode.Scalar) -> Bool {
    let value = scalar.value
    if value <= 0x1F || (0x7F...0x9F).contains(value) { return true }
    if value <= 0xFFFF, JS.isWhitespace(UInt16(value)) { return true }

    switch value {
    case 0x00AD, 0x0600...0x0605, 0x061C, 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x180E, 0x200B...0x200F,
      0x202A...0x202E, 0x2060...0x2064, 0x2066...0x206F, 0xFEFF, 0xFFF9...0xFFFB:
      return true
    default:
      return false
    }
  }

  // MARK: Showing

  /// The host of `url` exactly as the gateway sent it (lower case ASCII, punycode for an international name), without
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
