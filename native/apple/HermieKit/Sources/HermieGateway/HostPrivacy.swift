/// Is the host the user gave us one where a cleartext path stays inside a
/// network somebody controls? (ADR-0014; the port of `host-privacy.ts`.)
///
/// This picks a TONE, never whether a connection is allowed. Nothing here
/// resolves a name: a `.ts.net` suffix is read as the intent it states, and a
/// host that lies about itself buys a friendlier sentence and no access.
public enum HostPrivacy: String, Sendable, Equatable, CaseIterable {
  /// `127.0.0.0/8`, `::1`, `localhost` — the gateway is on this machine.
  case loopback
  /// RFC 1918, or an IPv6 unique local address (`fc00::/7`).
  case `private`
  /// `169.254.0.0/16` or `fe80::/10`.
  case linkLocal = "link_local"
  /// `100.64.0.0/10` — shared address space, and the range Tailscale allots from.
  case cgnat
  /// A `.ts.net` MagicDNS name, or Tailscale's own `fd7a:115c:a1e0::/48`.
  case tailnet
  /// A `.local` or `.internal` name, or a name with no dots: resolvable on one network only.
  case localName = "local_name"
  /// Anything else.
  case `public`
}

public struct HostClassification: Sendable, Equatable {
  /// The bare host: lowercased, no port, no brackets, no trailing dot.
  public var host: String
  public var privacy: HostPrivacy

  /// True for everything but `public`.
  public var isPrivate: Bool { privacy != .public }

  public init(host: String, privacy: HostPrivacy) {
    self.host = host
    self.privacy = privacy
  }

  /// Classify whatever the user typed: a full URL, an authority with a port, or a bare host.
  public static func of(_ address: String) -> HostClassification {
    let host = host(ofAddress: address)
    let privacy = classifyIPv4(host) ?? classifyIPv6(host) ?? classifyName(host)

    return HostClassification(host: host, privacy: privacy)
  }

  /// True when this address is reached in the clear over a network anyone can be on.
  public static func isExposedCleartext(_ baseURL: String) -> Bool {
    JSText.hasPrefix(JSText.trim(baseURL).lowercased(), "http://") && !of(baseURL).isPrivate
  }

  /// Split a host out of a URL, an authority, or a bare host.
  ///
  /// Deliberately the reference's string surgery, not a URL parse: the
  /// authority ends at the first `/`, `?` or `#`, the credentials cut is the
  /// LAST `@` inside it (an `@` in the path never names the host), two colons
  /// or more without brackets mean the whole string is an IPv6 literal, and
  /// lowercasing is Unicode-aware (`İ` becomes `i` + U+0307).
  public static func host(ofAddress address: String) -> String {
    // Every ASCII tab and newline goes first, as the URL parser removes them before it reads anything.
    var rest = Array(JSText.trim(address).unicodeScalars.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" })

    if let schemeEnd = firstIndex(of: Array("://".unicodeScalars), in: rest) {
      rest = Array(rest[(schemeEnd + 3)...])
    }

    // `\` ends the authority like `/`: the URL standard reads it as `/` for http, https, ws and wss.
    if let end = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" || $0 == "\\" }) {
      rest = Array(rest[..<end])
    }

    if let at = rest.lastIndex(of: "@") {
      rest = Array(rest[(at + 1)...])
    }

    if rest.first == "[" {
      if let close = rest.firstIndex(of: "]") {
        rest = Array(rest[1..<close])
      } else {
        rest = Array(rest[1...])
      }
    } else if rest.filter({ $0 == ":" }).count == 1, let colon = rest.firstIndex(of: ":") {
      rest = Array(rest[..<colon])
    }

    // A fully qualified name may end in the root dot; `a.ts.net.` is `a.ts.net`.
    while rest.last == "." {
      rest.removeLast()
    }

    return JSText.string(rest).lowercased()
  }

  private static func firstIndex(of needle: [Unicode.Scalar], in haystack: [Unicode.Scalar]) -> Int? {
    guard haystack.count >= needle.count else {
      return nil
    }

    for start in 0...(haystack.count - needle.count) where Array(haystack[start..<(start + needle.count)]) == needle {
      return start
    }

    return nil
  }

  /// `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/`, each octet read as decimal (`010` is 10).
  private static func ipv4Octets(_ text: String) -> [Int]? {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)

    guard parts.count == 4 else {
      return nil
    }

    var octets: [Int] = []

    for part in parts {
      guard (1...3).contains(part.unicodeScalars.count), part.unicodeScalars.allSatisfy(JSText.isASCIIDigit) else {
        return nil
      }

      octets.append(Int(part)!)
    }

    return octets
  }

  private static func classifyIPv4(_ host: String) -> HostPrivacy? {
    guard let octets = ipv4Octets(host), octets.allSatisfy({ $0 <= 255 }) else {
      return nil
    }

    return classifyOctets(octets)
  }

  private static func classifyOctets(_ octets: [Int]) -> HostPrivacy {
    let first = octets[0]
    let second = octets[1]

    if first == 127 {
      return .loopback
    }

    if first == 10 || (first == 192 && second == 168) || (first == 172 && (16...31).contains(second)) {
      return .private
    }

    if first == 169 && second == 254 {
      return .linkLocal
    }

    // Tailscale hands every node an address out of the CGNAT block.
    if first == 100 && (64...127).contains(second) {
      return .cgnat
    }

    return .public
  }

  /// The reference's own IPv6 reading (not the URL parser's): eight hextets
  /// from `::`-split halves, a trailing dotted quad as two hextets, `nil` for
  /// anything else (a zone id included).
  private static func hextets(_ host: String) -> [Int]? {
    guard host.unicodeScalars.contains(":") else {
      return nil
    }

    let halves = host.components(separatedByString: "::")

    guard halves.count <= 2 else {
      return nil
    }

    func parse(_ part: String) -> [Int]? {
      if part.isEmpty {
        return []
      }

      var out: [Int] = []

      for group in part.split(separator: ":", omittingEmptySubsequences: false).map(String.init) {
        if let octets = ipv4Octets(group) {
          guard octets.allSatisfy({ $0 <= 255 }) else {
            return nil
          }

          out.append(octets[0] << 8 | octets[1])
          out.append(octets[2] << 8 | octets[3])
          continue
        }

        let isHex = (1...4).contains(group.unicodeScalars.count)
          && group.unicodeScalars.allSatisfy { JSText.isASCIIDigit($0) || ("a"..."f").contains($0) }

        guard isHex else {
          return nil
        }

        out.append(Int(group, radix: 16)!)
      }

      return out
    }

    guard let left = parse(halves[0]) else {
      return nil
    }

    guard halves.count == 2 else {
      return left.count == 8 ? left : nil
    }

    guard let right = parse(halves[1]) else {
      return nil
    }

    let gap = 8 - left.count - right.count

    guard gap >= 1 else {
      return nil
    }

    return left + Array(repeating: 0, count: gap) + right
  }

  private static func classifyIPv6(_ host: String) -> HostPrivacy? {
    guard let groups = hextets(host) else {
      return nil
    }

    // An IPv4-mapped address reaches the same machine its IPv4 address does.
    if groups[0..<5].allSatisfy({ $0 == 0 }), groups[5] == 0xFFFF {
      let octets = [groups[6] >> 8, groups[6] & 0xFF, groups[7] >> 8, groups[7] & 0xFF]
      return classifyOctets(octets)
    }

    if groups.allSatisfy({ $0 == 0 }) {
      return .public
    }

    if groups[0..<7].allSatisfy({ $0 == 0 }), groups[7] == 1 {
      return .loopback
    }

    if groups[0] & 0xFFC0 == 0xFE80 {
      return .linkLocal
    }

    // Tailscale's IPv6 range, a /48 inside the ULA space.
    if groups[0] == 0xFD7A, groups[1] == 0x115C, groups[2] == 0xA1E0 {
      return .tailnet
    }

    if groups[0] & 0xFE00 == 0xFC00 {
      return .private
    }

    return .public
  }

  private static func classifyName(_ host: String) -> HostPrivacy {
    // A colon that survived the IPv6 reading is a malformed literal; unreadable reads public.
    if host.unicodeScalars.contains(":") {
      return .public
    }

    if JSText.same(host, "localhost") || JSText.hasSuffix(host, ".localhost") {
      return .loopback
    }

    if JSText.hasSuffix(host, ".ts.net") {
      return .tailnet
    }

    // `.internal` is reserved for private use and never delegated, like `.local`.
    if JSText.hasSuffix(host, ".local") || JSText.same(host, "internal") || JSText.hasSuffix(host, ".internal") {
      return .localName
    }

    if !host.isEmpty, !host.unicodeScalars.contains(".") {
      return .localName
    }

    return .public
  }
}

extension String {
  /// `String.prototype.split` with a string separator, over Unicode scalars.
  fileprivate func components(separatedByString separator: String) -> [String] {
    let scalars = Array(unicodeScalars)
    let needle = Array(separator.unicodeScalars)
    var parts: [String] = []
    var start = 0
    var index = 0

    while index + needle.count <= scalars.count {
      if Array(scalars[index..<(index + needle.count)]) == needle {
        parts.append(JSText.string(scalars[start..<index]))
        index += needle.count
        start = index
      } else {
        index += 1
      }
    }

    parts.append(JSText.string(scalars[start...]))
    return parts
  }
}
