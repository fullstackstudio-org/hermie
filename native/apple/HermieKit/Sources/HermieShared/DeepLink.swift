import Foundation

/**
 `hermie://…`: the links the app answers, parsed and built.

 The grammar of `parseHermieLink` in `expo/hermie/src/platform/deep-link.ts`, kept exactly as
 narrow. A URL scheme is registered with the system, so any app and any web page can send one: this
 accepts `hermie://<kind>/<one segment>` and nothing else. Every link names something this app
 already made — a chat on the roster, a share or a Shortcut request this device wrote, a folder in
 the owner's list — and never carries an address, a token or content.

 - `hermie://chat/<bot>?gateway=<key>`: the bot name is percent-decoded and refused when empty or
   when it contains a slash; `gateway` is kept only when it is sixteen lowercase hex digits, and
   every other parameter is ignored.
 - `hermie://share/<id>`, `hermie://intent/<id>`, `hermie://folder/<id>`: the id is NOT decoded and
   must already be in its alphabet (`Identifiers`).
 - `exp+hermie://` is accepted too, the scheme a development client registers.
 - A second path segment is refused for every kind; one trailing slash is tolerated.
 */
public enum DeepLink: Sendable, Hashable {
  /// A chat on a gateway's roster. `gatewayKey` is `""` when the link named none.
  case chat(bot: String, gatewayKey: String)
  case share(id: String)
  case intent(id: String)
  case folder(id: String)

  public static let scheme = "hermie"
  public static let developmentScheme = "exp+hermie"

  /// Parse a link, or nil for anything that is not exactly one of the four shapes.
  public init?(_ url: String?) {
    guard let url, let parsed = Self.parse(url) else {
      return nil
    }

    self = parsed
  }

  public init?(url: URL) {
    self.init(url.absoluteString)
  }

  // MARK: Building

  /// The link as text, or nil when an id is outside its alphabet or a bot name is empty.
  public var string: String? {
    switch self {
    case let .chat(bot, gatewayKey):
      guard !bot.isEmpty else {
        return nil
      }

      // Escaped for a path segment, slash included: a name with a slash in it then fails to parse,
      // which is the right failure for a surface that cannot report one.
      let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
      let path = "\(Self.scheme)://chat/\(bot.addingPercentEncoding(withAllowedCharacters: allowed) ?? bot)"

      return Identifiers.isGatewayKey(gatewayKey) ? "\(path)?gateway=\(gatewayKey)" : path
    case let .share(id):
      return Identifiers.isSafeShareId(id) ? "\(Self.scheme)://share/\(id)" : nil
    case let .intent(id):
      return Identifiers.isSafeIntentId(id) ? "\(Self.scheme)://intent/\(id)" : nil
    case let .folder(id):
      return Identifiers.isSafeFolderId(id) ? "\(Self.scheme)://folder/\(id)" : nil
    }
  }

  public var url: URL? {
    string.flatMap(URL.init(string:))
  }

  // MARK: Parsing

  /// Scalar by scalar rather than by `Character`, as the JavaScript pattern reads code units: a
  /// combining mark after a `/` must not hide the slash inside one grapheme.
  private static func parse(_ url: String) -> DeepLink? {
    var rest = Substring(url).unicodeScalars

    let development = "\(developmentScheme)://".unicodeScalars
    let plain = "\(scheme)://".unicodeScalars

    if rest.starts(with: development) {
      rest = rest.dropFirst(development.count)
    } else if rest.starts(with: plain) {
      rest = rest.dropFirst(plain.count)
    } else {
      return nil
    }

    guard let slash = rest.firstIndex(of: "/") else {
      return nil
    }

    let kind = String(rest[..<slash])

    rest = rest[rest.index(after: slash)...]

    let segmentEnd = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
    let segment = String(rest[..<segmentEnd])

    guard !segment.isEmpty else {
      return nil
    }

    rest = rest[segmentEnd...]

    if rest.first == "/" {
      rest = rest.dropFirst()
    }

    var query = ""

    if rest.first == "?" {
      let queryEnd = rest.firstIndex(of: "#") ?? rest.endIndex

      query = String(rest[rest.index(after: rest.startIndex)..<queryEnd])
      rest = rest[queryEnd...]
    }

    if !rest.isEmpty {
      // Only a fragment may follow, and (as `.` in the JavaScript pattern) not across a line break.
      guard rest.first == "#", !rest.contains(where: { ["\n", "\r", "\u{2028}", "\u{2029}"].contains($0) }) else {
        return nil
      }
    }

    switch kind {
    case "share":
      return Identifiers.isSafeShareId(segment) ? .share(id: segment) : nil
    case "intent":
      return Identifiers.isSafeIntentId(segment) ? .intent(id: segment) : nil
    case "folder":
      return Identifiers.isSafeFolderId(segment) ? .folder(id: segment) : nil
    case "chat":
      guard let bot = segment.removingPercentEncoding, !bot.isEmpty, !bot.contains("/") else {
        return nil
      }

      return .chat(bot: bot, gatewayKey: gatewayKey(in: query))
    default:
      return nil
    }
  }

  /// The `gateway` parameter, when it is a valid key. Every other parameter is ignored.
  private static func gatewayKey(in query: String) -> String {
    for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
      let parts = pair.split(separator: "=", omittingEmptySubsequences: false)
      let name = parts.first.map(String.init) ?? ""
      let value = parts.count > 1 ? String(parts[1]) : ""

      if name == "gateway", Identifiers.isGatewayKey(value) {
        return value
      }
    }

    return ""
  }
}
