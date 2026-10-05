import Foundation

/**
 `hermie://…`: the links the app answers, parsed and built.

 The grammar of `parseHermieLink` in `expo/hermie/src/platform/deep-link.ts`, kept exactly as
 narrow. A URL scheme is registered with the system, so any app and any web page can send one: this
 accepts `hermie://<kind>/<one segment>` and nothing else, plus the one addition below. Every link
 names something this app already made — a chat on the roster, a share or a Shortcut request this
 device wrote, a folder in the owner's list — and never carries a token or content.

 - `hermie://chat/<bot>?gateway=<key>`: the bot name is percent-decoded and refused unless it
   passes `Identifiers.isBotName` (non-empty, bounded, no slash, no control character), the same
   rule a notification's bot name is held to; `gateway` is kept only when it is sixteen lowercase
   hex digits, and every other parameter is ignored.
 - `hermie://conversation/<session>?bot=<bot>&gateway=<key>`: one conversation of a bot that is not
   its Bot Chat (a past one, a branch, a chat of the reader's own), as Spotlight opens it. The session
   id is NOT decoded and must be in its alphabet (`Identifiers.isSafeSessionId`); `bot` is held to the
   same rule as a chat link's and is required; `gateway` as above. An addition of the native apps: the
   Expo parser ignores a kind it does not know.
 - `hermie://ask/<bot>?gateway=<key>`: the same chat as `hermie://chat/…`, and the composer is to have
   the caret. What "Write to a bot" (the Action button, the Control Center control, Siri) opens; the
   bot and the gateway are held to the chat link's rules, and a link never carries words to type. An
   addition of the native apps, as `conversation` is.
 - `hermie://share/<id>`, `hermie://intent/<id>`, `hermie://folder/<id>`: the id is NOT decoded and
   must already be in its alphabet (`Identifiers`).
 - `hermie://add-gateway?url=<address>&name=<name>&auth=<kind>`: the one link that carries an address,
   the pairing offer a gateway's QR code holds (NX-14). It is an OFFER: nothing is added when it
   arrives, the app shows what it names and asks. `url` is required, must read as an `http://` or
   `https://` address with a host and no user name, password, query or fragment, and is at most
   `maxAddressLength` characters; whether the scheme is acceptable for that host is the app's rule
   (`GatewayPairingOffer`). `name` is cleaned (control characters and runs of space) and cut to
   `maxNameLength`; `auth` is kept only when it is one of `authKinds`. Every other parameter is
   dropped, so a link can carry no credential, token or header that survives parsing, and the link
   this builds has none to carry.
 - `exp+hermie://` is accepted too, the scheme a development client registers.
 - A second path segment is refused for every kind; one trailing slash is tolerated.
 */
public enum DeepLink: Sendable, Hashable {
  /// A chat on a gateway's roster. `gatewayKey` is `""` when the link named none.
  case chat(bot: String, gatewayKey: String)
  /// One of a bot's other conversations, by its stored session id. `gatewayKey` is `""` when the
  /// link named none.
  case conversation(bot: String, session: String, gatewayKey: String)
  /// A bot's chat, opened with the caret in the composer. `gatewayKey` is `""` when the link named none.
  case ask(bot: String, gatewayKey: String)
  case share(id: String)
  case intent(id: String)
  case folder(id: String)
  /// A gateway to add, offered by its QR code. `name` and `auth` are `""` when the link named none
  /// (or named something outside the rules above).
  case addGateway(url: String, name: String, auth: String)

  public static let scheme = "hermie"
  public static let developmentScheme = "exp+hermie"

  /// The kind the add-gateway link is under: `hermie://add-gateway?…`.
  public static let addGatewayKind = "add-gateway"
  /// The longest address and name an add-gateway link may carry.
  public static let maxAddressLength = 2048
  public static let maxNameLength = 64
  /// The sign-in kinds an add-gateway link may name (`GatewayAuthKind`'s spellings). A hint for the
  /// person to read; the gateway itself says how it signs in.
  public static let authKinds: Set<String> = ["native_pkce", "session_token", "cookie"]

  /// Parse a link, or nil for anything that is not exactly one of its shapes.
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
      return Self.botLink(kind: "chat", bot: bot, gatewayKey: gatewayKey)
    case let .ask(bot, gatewayKey):
      return Self.botLink(kind: "ask", bot: bot, gatewayKey: gatewayKey)
    case let .conversation(bot, session, gatewayKey):
      guard Identifiers.isBotName(bot), Identifiers.isSafeSessionId(session) else {
        return nil
      }

      let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?/"))
      let escaped = bot.addingPercentEncoding(withAllowedCharacters: allowed) ?? bot
      var link = "\(Self.scheme)://conversation/\(session)?bot=\(escaped)"

      if Identifiers.isGatewayKey(gatewayKey) {
        link += "&gateway=\(gatewayKey)"
      }

      return link
    case let .share(id):
      return Identifiers.isSafeShareId(id) ? "\(Self.scheme)://share/\(id)" : nil
    case let .intent(id):
      return Identifiers.isSafeIntentId(id) ? "\(Self.scheme)://intent/\(id)" : nil
    case let .folder(id):
      return Identifiers.isSafeFolderId(id) ? "\(Self.scheme)://folder/\(id)" : nil
    case let .addGateway(url, name, auth):
      guard let address = Self.acceptedAddress(url) else {
        return nil
      }

      var link = "\(Self.scheme)://\(Self.addGatewayKind)?url=\(Self.queryEscaped(address))"
      let cleaned = Self.cleanedName(name)

      if !cleaned.isEmpty {
        link += "&name=\(Self.queryEscaped(cleaned))"
      }

      if Self.authKinds.contains(auth) {
        link += "&auth=\(auth)"
      }

      return link
    }
  }

  /// A query value with everything but the unreserved characters escaped, so no character of an
  /// address or a name can be read as the link's own punctuation.
  private static func queryEscaped(_ text: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
  }

  /// The address as the link may carry it, or nil: `http://` or `https://`, a host, no user name or
  /// password, no query, no fragment, no white space or control character, and not too long.
  public static func acceptedAddress(_ raw: String) -> String? {
    let scalars = raw.unicodeScalars

    guard !scalars.isEmpty, scalars.count <= maxAddressLength,
      !scalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.isWhitespace })
    else {
      return nil
    }

    let lowered = raw.lowercased()
    let prefix: String

    if lowered.hasPrefix("https://") {
      prefix = "https://"
    } else if lowered.hasPrefix("http://") {
      prefix = "http://"
    } else {
      return nil
    }

    let rest = raw.dropFirst(prefix.count)

    guard !rest.contains(where: { $0 == "?" || $0 == "#" || $0 == "\\" }) else {
      return nil
    }

    let authority = rest.prefix { $0 != "/" }

    guard !authority.isEmpty, !authority.contains("@"), authority.first != ":" else {
      return nil
    }

    return raw
  }

  /// A name as it may be shown: control characters dropped, runs of white space made one space,
  /// the ends trimmed, cut to `maxNameLength`.
  public static func cleanedName(_ raw: String) -> String {
    var cleaned = ""
    var pendingSpace = false

    for scalar in raw.unicodeScalars {
      if scalar.properties.isWhitespace {
        pendingSpace = !cleaned.isEmpty
      } else if scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .format {
        continue
      } else {
        if pendingSpace {
          cleaned.append(" ")
          pendingSpace = false
        }

        cleaned.unicodeScalars.append(scalar)
      }
    }

    return String(cleaned.prefix(maxNameLength))
  }

  public var url: URL? {
    string.flatMap(URL.init(string:))
  }

  /// `hermie://<kind>/<bot>[?gateway=<key>]`, for the kinds that name a bot in their path.
  private static func botLink(kind: String, bot: String, gatewayKey: String) -> String? {
    guard !bot.isEmpty else {
      return nil
    }

    // Escaped for a path segment, slash included: a name with a slash in it then fails to parse,
    // which is the right failure for a surface that cannot report one.
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
    let path = "\(scheme)://\(kind)/\(bot.addingPercentEncoding(withAllowedCharacters: allowed) ?? bot)"

    return Identifiers.isGatewayKey(gatewayKey) ? "\(path)?gateway=\(gatewayKey)" : path
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

    // The one kind with no segment: its content is in the query.
    let addGateway = addGatewayKind.unicodeScalars

    if rest.starts(with: addGateway) {
      return parseAddGateway(rest.dropFirst(addGateway.count))
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
    case "chat", "ask":
      guard let bot = segment.removingPercentEncoding, Identifiers.isBotName(bot) else {
        return nil
      }

      return kind == "ask"
        ? .ask(bot: bot, gatewayKey: gatewayKey(in: query)) : .chat(bot: bot, gatewayKey: gatewayKey(in: query))
    case "conversation":
      guard Identifiers.isSafeSessionId(segment), let bot = value("bot", in: query)?.removingPercentEncoding,
        Identifiers.isBotName(bot)
      else {
        return nil
      }

      return .conversation(bot: bot, session: segment, gatewayKey: gatewayKey(in: query))
    default:
      return nil
    }
  }

  /// What follows `add-gateway`: `?query`, or `/?query`, then at most a fragment. Only `url`, `name`
  /// and `auth` are read; everything else is dropped.
  private static func parseAddGateway(_ tail: Substring.UnicodeScalarView) -> DeepLink? {
    var rest = tail

    if rest.first == "/" {
      rest = rest.dropFirst()
    }

    guard rest.first == "?" else {
      return nil
    }

    rest = rest.dropFirst()

    let end = rest.firstIndex(of: "#") ?? rest.endIndex
    let fragment = rest[end...]

    guard !fragment.contains(where: { ["\n", "\r", "\u{2028}", "\u{2029}"].contains($0) }) else {
      return nil
    }

    let query = String(rest[..<end])

    guard let rawAddress = value("url", in: query)?.removingPercentEncoding,
      let address = acceptedAddress(rawAddress)
    else {
      return nil
    }

    let name = value("name", in: query)?.removingPercentEncoding.map(cleanedName) ?? ""
    let auth = value("auth", in: query)?.removingPercentEncoding.flatMap { authKinds.contains($0) ? $0 : nil } ?? ""

    return .addGateway(url: address, name: name, auth: auth)
  }

  /// The `gateway` parameter, when it is a valid key. Every other parameter is ignored.
  private static func gatewayKey(in query: String) -> String {
    guard let value = value("gateway", in: query), Identifiers.isGatewayKey(value) else {
      return ""
    }

    return value
  }

  /// The first `name` parameter's raw value, still percent-encoded.
  private static func value(_ name: String, in query: String) -> String? {
    for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)

      if parts.first.map(String.init) == name, parts.count > 1 {
        return String(parts[1])
      }
    }

    return nil
  }
}
