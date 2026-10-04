/// Addresses as a person types them, turned into the URLs the client dials.
///
/// The port of `packages/gateway-client/src/url.ts` (plus `originOf` from
/// `front-door.ts`). Every function answers what the TypeScript answers for the
/// vectors in `contract/gateway/vectors/url.json`, which is why the parsing
/// goes through `WHATWGURL` rather than Foundation's `URL`.
public enum GatewayAddress {
  /// Path the gateway serves its JSON-RPC WebSocket on.
  public static let webSocketPath = "/api/ws"

  /// Where a colleague's (or the reader's own) picture lives, behind the gateway's auth.
  public static let authPicturePathPrefix = "/api/auth/picture"

  /// Headers the app may not set: the transport owns them, or letting a user
  /// override them would quietly break authentication. Lowercase.
  public static let blockedHeaderNames: Set<String> = [
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-hermes-session-token"
  ]

  /// Did the user name a scheme (`scheme://`) themselves?
  ///
  /// An address typed WITHOUT one is a question the app may answer by trying
  /// https and then http (ADR-0014); one typed WITH `https://` is an
  /// instruction, never to be quietly downgraded.
  public static func hasExplicitScheme(_ raw: String) -> Bool {
    hasSchemePrefix(JSText.trim(raw))
  }

  /// `/^[a-z][a-z0-9+.-]*:\/\//i`
  private static func hasSchemePrefix(_ text: String) -> Bool {
    let scalars = Array(text.unicodeScalars)

    guard let first = scalars.first, JSText.isASCIIAlpha(first) else {
      return false
    }

    var index = 1

    while index < scalars.count,
      JSText.isASCIIAlpha(scalars[index]) || JSText.isASCIIDigit(scalars[index])
        || "+.-".unicodeScalars.contains(scalars[index])
    {
      index += 1
    }

    return index + 2 < scalars.count && scalars[index] == ":" && scalars[index + 1] == "/" && scalars[index + 2] == "/"
  }

  /// Coerce what a user typed into a base URL: no scheme → `https://`; query,
  /// fragment and trailing slashes dropped; a path prefix kept; anything but
  /// http/https a `config` error.
  public static func normalizeBaseURL(_ raw: String) throws(GatewayError) -> String {
    let url = try parseBase(raw)
    return "\(url.protocolString)//\(url.hostWithPort)\(dropTrailingSlashes(url.pathname))"
  }

  private static func parseBase(_ raw: String) throws(GatewayError) -> WHATWGURL {
    let trimmed = JSText.trim(raw)

    if trimmed.isEmpty {
      throw GatewayError(.config, "Enter a gateway address.")
    }

    let withScheme = hasSchemePrefix(trimmed) ? trimmed : "https://\(trimmed)"

    guard let url = WHATWGURL.parse(withScheme) else {
      throw GatewayError(.config, "That is not a valid address: \(trimmed)")
    }

    if url.scheme != "http", url.scheme != "https" {
      throw GatewayError(.config, "A gateway address must be http:// or https://, not \(url.protocolString)//")
    }

    if url.host?.isEmpty ?? true {
      throw GatewayError(.config, "That address has no host: \(trimmed)")
    }

    return url
  }

  /// When no scheme was typed, the `http://` twin of the normalised https URL
  /// that the probe tries after https fails to answer (`resolveGatewayAddress`
  /// in `probe.ts`); `nil` when the user named a scheme, which is never downgraded.
  public static func cleartextFallback(for raw: String) throws(GatewayError) -> String? {
    let baseURL = try normalizeBaseURL(raw)

    guard !hasExplicitScheme(raw) else {
      return nil
    }

    return "http://" + baseURL.dropFirst("https://".count)
  }

  /// `https://host/prefix` → `wss://host/prefix/api/ws` (or another socket route under the same prefix,
  /// `path`). Accepts an unnormalised base URL.
  public static func webSocketURL(for baseURL: String, path: String = webSocketPath) throws(GatewayError) -> String {
    let normalized = try normalizeBaseURL(baseURL)

    guard let url = WHATWGURL.parse(normalized) else {
      throw GatewayError(.config, "That is not a valid address: \(normalized)")
    }

    let scheme = url.scheme == "https" ? "wss:" : "ws:"

    return "\(scheme)//\(url.hostWithPort)\(dropTrailingSlashes(url.pathname))\(path)"
  }

  /// Join a path onto a base URL, keeping the base's path prefix.
  public static func apiURL(_ baseURL: String, path: String) throws(GatewayError) -> String {
    let normalized = try normalizeBaseURL(baseURL)
    let suffix = JSText.hasPrefix(path, "/") ? path : "/\(path)"

    return normalized + suffix
  }

  /// `/api/auth/picture?id=<provider:sub>`, relative; join it with `apiURL`.
  public static func authPicturePath(id: String) -> String {
    "\(authPicturePathPrefix)?id=\(JSText.encodeURIComponent(id))"
  }

  public static func isBlockedHeaderName(_ name: String) -> Bool {
    // `toLowerCase` on a name that may hold non-ASCII; Swift's full Unicode lowercasing matches it.
    blockedHeaderNames.contains(JSText.trim(name).lowercased())
  }

  /// Validate one extra header: the name must be an RFC 9110 token and not
  /// transport-owned; CR and LF are removed from the value, which is then trimmed.
  public static func normalizeHeader(name: String, value: String) throws(GatewayError) -> (name: String, value: String) {
    let trimmedName = JSText.trim(name)

    guard isToken(trimmedName) else {
      throw GatewayError(.config, "\"\(name)\" is not a valid header name.")
    }

    if isBlockedHeaderName(trimmedName) {
      throw GatewayError(.config, "Hermie sets \"\(trimmedName)\" itself; it cannot be an extra header.")
    }

    let withoutBreaks = JSText.string(value.unicodeScalars.filter { $0 != "\r" && $0 != "\n" })

    return (trimmedName, JSText.trim(withoutBreaks))
  }

  /// Validate a whole extra-header map; throws on the first offending entry.
  ///
  /// The reference walks the object in insertion order; a dictionary has none,
  /// so names are visited in sorted order. That only decides WHICH error is
  /// reported when more than one entry is bad.
  public static func normalizeHeaders(_ headers: [String: String]?) throws(GatewayError) -> [String: String] {
    guard let headers else {
      return [:]
    }

    var out: [String: String] = [:]

    for name in headers.keys.sorted() {
      let header = try normalizeHeader(name: name, value: headers[name]!)
      out[header.name] = header.value
    }

    return out
  }

  /// `/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`
  private static func isToken(_ name: String) -> Bool {
    !name.isEmpty
      && name.unicodeScalars.allSatisfy { scalar in
        JSText.isASCIIAlpha(scalar) || JSText.isASCIIDigit(scalar) || "!#$%&'*+.^_`|~-".unicodeScalars.contains(scalar)
      }
  }

  /// `https://host:port` of an address, lowercased, or `""` when `new URL` throws.
  ///
  /// A non-special scheme has an opaque origin, which serialises as `"null"` —
  /// a non-empty string, kept as the reference keeps it.
  public static func origin(of address: String) -> String {
    WHATWGURL.parse(address)?.origin.lowercased() ?? ""
  }

  private static func dropTrailingSlashes(_ path: String) -> String {
    var scalars = Substring(path).unicodeScalars

    while scalars.last == "/" {
      scalars.removeLast()
    }

    return String(scalars)
  }
}
