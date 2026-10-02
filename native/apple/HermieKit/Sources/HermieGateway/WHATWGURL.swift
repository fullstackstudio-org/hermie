import Foundation

/// The part of the WHATWG URL parser (what `new URL(input)` runs in every
/// JavaScript engine) that the gateway client's answers depend on.
///
/// The TypeScript reference reads hosts, ports, paths and origins off `new
/// URL`, and Foundation's `URL`/`URLComponents` (RFC 3986 with Apple's
/// extensions) answer differently on exactly the inputs a person types into an
/// address field. Each divergence this file bridges, with the vector that
/// proves it:
///
/// - **Leading and trailing C0 controls and spaces are stripped, and every tab,
///   LF and CR inside is removed** before parsing (`https://exam\nple.com` is
///   `example.com`). Foundation rejects the newline.
/// - **Slashes after a special scheme are optional and `\` counts as one**
///   (`https:example.com`, `https:///example.com`, `http:\\example.com` all
///   reach `example.com`). Foundation reads a path or an empty host.
/// - **Default ports are dropped** (`:443` on https/wss, `:80` on http/ws, `:21`
///   on ftp). Foundation keeps them.
/// - **A port above 65535 is a parse failure**, as is a non-digit port.
/// - **Hosts are percent-decoded, lowercased and run through IDNA** (`bücher`
///   becomes `xn--bcher-kva`); a forbidden code point such as a space fails.
///   Foundation's handling of non-ASCII hosts varies by OS release.
/// - **A host that ends in a number is an IPv4 address**, with hex (`0x7f`),
///   octal (`010`) and shorthand (`127.1`, `2130706433`) parts expanded to a
///   dotted quad. Foundation leaves the text alone.
/// - **IPv6 literals are re-serialised** in compressed lowercase form
///   (`[FD7A:115C:A1E0::1]` → `[fd7a:115c:a1e0::1]`).
/// - **A trailing dot on a domain is kept** (`example.com.`).
/// - **Paths are percent-encoded with the path set and dot segments resolved**
///   (`/a b` → `/a%20b`, `/ü` → `/%C3%BC`, `/a/./b/../c` → `/a/c`); existing
///   escapes such as `%7E` and `%2F` are kept as written.
/// - **Userinfo is parsed and dropped from host and origin**, with the LAST `@`
///   of the authority deciding where the host starts.
/// - **Non-special schemes (`mailto:`, `about:`, `foo://`) parse** and have an
///   opaque origin, serialised `"null"`; a `blob:` URL has the origin of the
///   URL inside it; `file:` is opaque.
///
/// Not reproduced, because no caller can reach it: the full UTS #46 mapping
/// table (the port lowercases and NFC-normalises a label before Punycode, which
/// is what UTS #46 does for every letter a person types), Windows drive-letter
/// quirks of `file:` paths, and parsing relative to a base URL.
struct WHATWGURL: Sendable, Equatable {
  /// Lowercased, without the colon.
  var scheme: String
  /// The serialised host (IPv6 in brackets), or `nil` for a URL with no authority.
  var host: String?
  /// `nil` when absent or equal to the scheme's default.
  var port: Int?
  /// `url.pathname`.
  var pathname: String
  /// The percent-encoded query without its `?`, or `nil` when there is none.
  var query: String?

  var isSpecial: Bool { Self.defaultPorts.keys.contains(scheme) }

  /// `url.protocol`.
  var protocolString: String { "\(scheme):" }

  /// `url.host`: hostname plus a non-default port.
  var hostWithPort: String {
    guard let host else {
      return ""
    }

    return port.map { "\(host):\($0)" } ?? host
  }

  /// `url.origin`.
  var origin: String {
    switch scheme {
    case "http", "https", "ws", "wss", "ftp":
      return "\(scheme)://\(hostWithPort)"
    case "blob":
      // The origin of the URL the blob was made for, when that is http(s).
      guard let inner = WHATWGURL.parse(pathname), inner.scheme == "http" || inner.scheme == "https" else {
        return "null"
      }

      return inner.origin
    default:
      return "null"
    }
  }

  /// `file` is special too, but has no default port.
  private static let defaultPorts: [String: Int?] = [
    "ftp": 21, "file": nil, "http": 80, "https": 443, "ws": 80, "wss": 443
  ]

  // MARK: - Parsing

  /// `new URL(input)` with no base; `nil` where it throws.
  static func parse(_ input: String) -> WHATWGURL? {
    // Strip leading/trailing C0 control or space, then every ASCII tab or newline.
    let trimmed = JSText.strip(input) { $0.value <= 0x20 }
    let scalars = Array(trimmed.unicodeScalars.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" })

    guard let first = scalars.first, JSText.isASCIIAlpha(first) else {
      return nil
    }

    var index = 1

    while index < scalars.count,
      JSText.isASCIIAlpha(scalars[index]) || JSText.isASCIIDigit(scalars[index]) || "+-.".unicodeScalars.contains(scalars[index])
    {
      index += 1
    }

    guard index < scalars.count, scalars[index] == ":" else {
      return nil
    }

    let scheme = JSText.asciiLowercased(JSText.string(scalars[..<index]))
    let rest = Array(scalars[(index + 1)...])

    if scheme == "file" {
      return parseFile(rest)
    }

    if defaultPorts[scheme] != nil {
      return parseSpecial(scheme: scheme, rest)
    }

    return parseNonSpecial(scheme: scheme, rest)
  }

  private static func isSlash(_ scalar: Unicode.Scalar, special: Bool) -> Bool {
    scalar == "/" || (special && scalar == "\\")
  }

  /// http, https, ws, wss, ftp: any run of `/` and `\` after the colon is skipped.
  private static func parseSpecial(scheme: String, _ rest: [Unicode.Scalar]) -> WHATWGURL? {
    var index = 0

    while index < rest.count, isSlash(rest[index], special: true) {
      index += 1
    }

    guard let authority = parseAuthority(rest, from: &index, special: true, scheme: scheme) else {
      return nil
    }

    guard !authority.host.isEmpty else {
      return nil
    }

    let tail = parsePathQuery(rest, from: index, special: true, hasAuthority: true)

    return WHATWGURL(
      scheme: scheme,
      host: authority.host,
      port: authority.port,
      pathname: tail.pathname,
      query: tail.query
    )
  }

  /// `file:` always has an opaque origin. Its host is parsed like any special
  /// host, so a forbidden code point still fails.
  private static func parseFile(_ rest: [Unicode.Scalar]) -> WHATWGURL? {
    var index = 0
    var host: String?

    if rest.count >= 2, isSlash(rest[0], special: true), isSlash(rest[1], special: true) {
      index = 2
      var end = index

      while end < rest.count, !isSlash(rest[end], special: true), rest[end] != "?", rest[end] != "#" {
        end += 1
      }

      let raw = JSText.string(rest[index..<end])

      if raw.isEmpty {
        host = ""
      } else {
        guard let parsed = parseHost(raw, special: true) else {
          return nil
        }

        host = parsed == "localhost" ? "" : parsed
      }

      index = end
    }

    let tail = parsePathQuery(rest, from: index, special: true, hasAuthority: true)

    return WHATWGURL(scheme: "file", host: host, port: nil, pathname: tail.pathname, query: tail.query)
  }

  /// Any other scheme: an authority only after `//`, else a path, else an opaque path.
  private static func parseNonSpecial(scheme: String, _ rest: [Unicode.Scalar]) -> WHATWGURL? {
    if rest.count >= 2, rest[0] == "/", rest[1] == "/" {
      var index = 2

      guard let authority = parseAuthority(rest, from: &index, special: false, scheme: scheme) else {
        return nil
      }

      let tail = parsePathQuery(rest, from: index, special: false, hasAuthority: true)

      return WHATWGURL(
        scheme: scheme,
        host: authority.host,
        port: authority.port,
        pathname: tail.pathname,
        query: tail.query
      )
    }

    if rest.first == "/" {
      let tail = parsePathQuery(rest, from: 0, special: false, hasAuthority: false)

      return WHATWGURL(scheme: scheme, host: nil, port: nil, pathname: tail.pathname, query: tail.query)
    }

    // Opaque path: everything up to `?` or `#`, C0-control percent-encoded.
    var index = 0
    var path = ""

    while index < rest.count, rest[index] != "?", rest[index] != "#" {
      append(rest[index], encodingIf: isC0ControlSet, to: &path)
      index += 1
    }

    return WHATWGURL(scheme: scheme, host: nil, port: nil, pathname: path, query: parseQuery(rest, from: index, special: false))
  }

  private struct Authority {
    var host: String
    var port: Int?
  }

  /// The authority, host and port states. Leaves `index` on the delimiter that ended it.
  private static func parseAuthority(
    _ rest: [Unicode.Scalar],
    from index: inout Int,
    special: Bool,
    scheme: String
  ) -> Authority? {
    var end = index

    while end < rest.count, !isSlash(rest[end], special: special), rest[end] != "?", rest[end] != "#" {
      end += 1
    }

    var hostStart = index

    // Credentials end at the LAST `@`; they never reach host or origin.
    if let at = rest[index..<end].lastIndex(of: "@") {
      hostStart = at + 1

      if hostStart == end {
        return nil
      }
    }

    // Host, then an optional port after the first `:` outside brackets.
    var insideBrackets = false
    var colon: Int?

    for position in hostStart..<end {
      let scalar = rest[position]

      if scalar == "[" {
        insideBrackets = true
      } else if scalar == "]" {
        insideBrackets = false
      } else if scalar == ":", !insideBrackets {
        colon = position
        break
      }
    }

    let hostEnd = colon ?? end
    let rawHost = JSText.string(rest[hostStart..<hostEnd])

    if colon != nil, rawHost.isEmpty {
      return nil
    }

    let host: String

    if rawHost.isEmpty {
      if special {
        return nil
      }

      host = ""
    } else {
      guard let parsed = parseHost(rawHost, special: special) else {
        return nil
      }

      host = parsed
    }

    var port: Int?

    if let colon {
      let digits = rest[(colon + 1)..<end]

      guard digits.allSatisfy(JSText.isASCIIDigit) else {
        return nil
      }

      if !digits.isEmpty {
        var value = 0

        for digit in digits {
          value = value * 10 + Int(digit.value - 0x30)

          if value > 65_535 {
            return nil
          }
        }

        port = defaultPorts[scheme].flatMap { $0 } == value ? nil : value
      }
    }

    index = end

    return Authority(host: host, port: port)
  }

  /// Path, query; the fragment is cut and dropped (nothing here reads it).
  private static func parsePathQuery(
    _ rest: [Unicode.Scalar],
    from start: Int,
    special: Bool,
    hasAuthority: Bool
  ) -> (pathname: String, query: String?) {
    var index = start
    var segments: [String] = []
    var buffer = ""
    var sawAnyPath = false

    // Path start state: one leading slash belongs to the path, not a segment.
    if index < rest.count, isSlash(rest[index], special: special) {
      index += 1
      sawAnyPath = true
    } else if special {
      sawAnyPath = true
    } else if index < rest.count, rest[index] != "?", rest[index] != "#" {
      sawAnyPath = true
    }

    if sawAnyPath {
      while true {
        let atEnd = index >= rest.count || rest[index] == "?" || rest[index] == "#"
        let scalar: Unicode.Scalar? = atEnd ? nil : rest[index]

        if atEnd || isSlash(scalar!, special: special) {
          let continues = !atEnd

          if isDoubleDot(buffer) {
            if !segments.isEmpty {
              segments.removeLast()
            }

            if !continues {
              segments.append("")
            }
          } else if isSingleDot(buffer), !continues {
            segments.append("")
          } else if !isSingleDot(buffer) {
            segments.append(buffer)
          }

          buffer = ""

          if atEnd {
            break
          }
        } else {
          append(scalar!, encodingIf: isPathSet, to: &buffer)
        }

        index += 1
      }
    }

    let pathname = segments.map { "/" + $0 }.joined()

    return (pathname, parseQuery(rest, from: index, special: special))
  }

  private static func parseQuery(_ rest: [Unicode.Scalar], from start: Int, special: Bool) -> String? {
    guard start < rest.count, rest[start] == "?" else {
      return nil
    }

    var query = ""
    var index = start + 1

    while index < rest.count, rest[index] != "#" {
      append(rest[index], encodingIf: special ? isSpecialQuerySet : isQuerySet, to: &query)
      index += 1
    }

    return query
  }

  private static func isSingleDot(_ segment: String) -> Bool {
    segment == "." || JSText.asciiLowercased(segment) == "%2e"
  }

  private static func isDoubleDot(_ segment: String) -> Bool {
    switch JSText.asciiLowercased(segment) {
    case "..", ".%2e", "%2e.", "%2e%2e": true
    default: false
    }
  }

  // MARK: - Percent-encode sets

  private static func isC0ControlSet(_ scalar: Unicode.Scalar) -> Bool {
    scalar.value < 0x20 || scalar.value > 0x7E
  }

  private static func isQuerySet(_ scalar: Unicode.Scalar) -> Bool {
    isC0ControlSet(scalar) || " \"#<>".unicodeScalars.contains(scalar)
  }

  private static func isSpecialQuerySet(_ scalar: Unicode.Scalar) -> Bool {
    isQuerySet(scalar) || scalar == "'"
  }

  private static func isPathSet(_ scalar: Unicode.Scalar) -> Bool {
    isQuerySet(scalar) || "?`{}".unicodeScalars.contains(scalar)
  }

  private static func append(_ scalar: Unicode.Scalar, encodingIf inSet: (Unicode.Scalar) -> Bool, to out: inout String) {
    guard inSet(scalar) else {
      out.unicodeScalars.append(scalar)
      return
    }

    for byte in String(scalar).utf8 {
      JSText.percentEscape(byte, into: &out)
    }
  }

  // MARK: - Hosts

  /// Forbidden host code points: may never appear in any host.
  private static func isForbiddenHost(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x00, 0x09, 0x0A, 0x0D, 0x20, 0x23, 0x2F, 0x3A, 0x3C, 0x3E, 0x3F, 0x40, 0x5B, 0x5C, 0x5D, 0x5E, 0x7C:
      true
    default:
      false
    }
  }

  /// Forbidden domain code points: the host set plus C0 controls, `%` and DEL.
  private static func isForbiddenDomain(_ scalar: Unicode.Scalar) -> Bool {
    isForbiddenHost(scalar) || scalar.value <= 0x1F || scalar == "%" || scalar.value == 0x7F
  }

  /// The host parser; `nil` where it fails.
  static func parseHost(_ input: String, special: Bool) -> String? {
    let scalars = Array(input.unicodeScalars)

    if scalars.first == "[" {
      guard scalars.last == "]", scalars.count >= 2,
        let address = parseIPv6(Array(scalars[1..<(scalars.count - 1)]))
      else {
        return nil
      }

      return "[\(serializeIPv6(address))]"
    }

    if !special {
      // Opaque host: no forbidden host code point (but `%` is allowed), C0-control encoded.
      guard !scalars.contains(where: isForbiddenHost) else {
        return nil
      }

      var out = ""

      for scalar in scalars {
        append(scalar, encodingIf: isC0ControlSet, to: &out)
      }

      return out
    }

    let domain = String(decoding: JSText.percentDecode(Array(input.utf8)), as: UTF8.self)

    guard let ascii = domainToASCII(domain), !ascii.isEmpty,
      !ascii.unicodeScalars.contains(where: isForbiddenDomain)
    else {
      return nil
    }

    if endsInANumber(ascii) {
      return parseIPv4(ascii).map(serializeIPv4)
    }

    return ascii
  }

  /// UTS #46 ToASCII as the URL standard calls it, reduced to what an address
  /// field can produce: full stops normalised, each label lowercased and
  /// NFC-composed, and a non-ASCII label Punycode-encoded behind `xn--`.
  private static func domainToASCII(_ domain: String) -> String? {
    let dots: Set<UInt32> = [0x3002, 0xFF0E, 0xFF61]
    let unified = JSText.string(domain.unicodeScalars.map { dots.contains($0.value) ? "." : $0 })

    if unified.unicodeScalars.allSatisfy(\.isASCII) {
      return JSText.asciiLowercased(unified)
    }

    var labels: [String] = []

    for label in unified.split(separator: ".", omittingEmptySubsequences: false) {
      let mapped = String(label).lowercased().precomposedStringWithCanonicalMapping

      if mapped.unicodeScalars.allSatisfy(\.isASCII) {
        labels.append(mapped)
      } else {
        guard let encoded = Punycode.encode(mapped) else {
          return nil
        }

        labels.append("xn--" + encoded)
      }
    }

    return labels.joined(separator: ".")
  }

  /// The last label (ignoring one trailing empty label) is all digits, or a `0x` hex number.
  private static func endsInANumber(_ host: String) -> Bool {
    var parts = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)

    if parts.last == "" {
      if parts.count == 1 {
        return false
      }

      parts.removeLast()
    }

    guard let last = parts.last, !last.isEmpty else {
      return false
    }

    if last.unicodeScalars.allSatisfy(JSText.isASCIIDigit) {
      return true
    }

    return parseIPv4Number(last) != nil
  }

  private static func parseIPv4Number(_ input: String) -> UInt64? {
    guard !input.isEmpty else {
      return nil
    }

    var text = Substring(input)
    var radix: UInt64 = 10

    if text.count >= 2, text.hasPrefix("0x") || text.hasPrefix("0X") {
      text = text.dropFirst(2)
      radix = 16
    } else if text.count >= 2, text.hasPrefix("0") {
      text = text.dropFirst()
      radix = 8
    }

    if text.isEmpty {
      return 0
    }

    var value: UInt64 = 0

    for scalar in text.unicodeScalars {
      let digit: UInt64

      switch scalar.value {
      case 0x30...0x39: digit = UInt64(scalar.value - 0x30)
      case 0x41...0x46: digit = UInt64(scalar.value - 0x41 + 10)
      case 0x61...0x66: digit = UInt64(scalar.value - 0x61 + 10)
      default: return nil
      }

      guard digit < radix else {
        return nil
      }

      // Anything past 2^40 fails the range checks below anyway; saturate rather than overflow.
      value = min(value * radix + digit, 1 << 40)
    }

    return value
  }

  private static func parseIPv4(_ input: String) -> UInt32? {
    var parts = input.split(separator: ".", omittingEmptySubsequences: false).map(String.init)

    if parts.last == "", parts.count > 1 {
      parts.removeLast()
    }

    guard parts.count <= 4 else {
      return nil
    }

    var numbers: [UInt64] = []

    for part in parts {
      guard let number = parseIPv4Number(part) else {
        return nil
      }

      numbers.append(number)
    }

    guard numbers.dropLast().allSatisfy({ $0 <= 255 }), let last = numbers.last else {
      return nil
    }

    guard last < (UInt64(1) << (8 * UInt64(5 - numbers.count))) else {
      return nil
    }

    var address = last

    for (index, number) in numbers.dropLast().enumerated() {
      address += number << (8 * UInt64(3 - index))
    }

    return UInt32(address)
  }

  private static func serializeIPv4(_ address: UInt32) -> String {
    [24, 16, 8, 0].map { String((address >> UInt32($0)) & 0xFF) }.joined(separator: ".")
  }

  /// The IPv6 parser, step for step.
  static func parseIPv6(_ input: [Unicode.Scalar]) -> [UInt16]? {
    var address = [UInt16](repeating: 0, count: 8)
    var pieceIndex = 0
    var compress: Int?
    var pointer = 0

    func at(_ offset: Int) -> Unicode.Scalar? {
      pointer + offset < input.count ? input[pointer + offset] : nil
    }

    if at(0) == ":" {
      guard at(1) == ":" else {
        return nil
      }

      pointer += 2
      pieceIndex += 1
      compress = pieceIndex
    }

    while let scalar = at(0) {
      guard pieceIndex != 8 else {
        return nil
      }

      if scalar == ":" {
        guard compress == nil else {
          return nil
        }

        pointer += 1
        pieceIndex += 1
        compress = pieceIndex
        continue
      }

      var value: UInt32 = 0
      var length = 0

      while length < 4, let digit = at(0), JSText.isASCIIHexDigit(digit) {
        value = value * 16 + UInt32(JSText.hexValue(UInt8(digit.value))!)
        pointer += 1
        length += 1
      }

      if at(0) == "." {
        guard length != 0, pieceIndex <= 6 else {
          return nil
        }

        pointer -= length
        var numbersSeen = 0

        while at(0) != nil {
          var piece: UInt32?

          if numbersSeen > 0 {
            guard at(0) == ".", numbersSeen < 4 else {
              return nil
            }

            pointer += 1
          }

          guard let digit = at(0), JSText.isASCIIDigit(digit) else {
            return nil
          }

          while let digit = at(0), JSText.isASCIIDigit(digit) {
            let number = digit.value - 0x30

            if let current = piece {
              guard current != 0 else {
                return nil
              }

              piece = current * 10 + number
            } else {
              piece = number
            }

            guard piece! <= 255 else {
              return nil
            }

            pointer += 1
          }

          address[pieceIndex] = address[pieceIndex] &* 0x100 &+ UInt16(piece!)
          numbersSeen += 1

          if numbersSeen == 2 || numbersSeen == 4 {
            pieceIndex += 1
          }
        }

        guard numbersSeen == 4 else {
          return nil
        }

        break
      } else if at(0) == ":" {
        pointer += 1

        guard at(0) != nil else {
          return nil
        }
      } else if at(0) != nil {
        return nil
      }

      address[pieceIndex] = UInt16(value)
      pieceIndex += 1
    }

    if let compress {
      var swaps = pieceIndex - compress
      pieceIndex = 7

      while pieceIndex != 0, swaps > 0 {
        address.swapAt(pieceIndex, compress + swaps - 1)
        pieceIndex -= 1
        swaps -= 1
      }
    } else if pieceIndex != 8 {
      return nil
    }

    return address
  }

  /// Lowercase hex, the first longest run of two or more zero pieces as `::`.
  static func serializeIPv6(_ address: [UInt16]) -> String {
    var bestStart: Int?
    var bestLength = 1
    var index = 0

    while index < 8 {
      if address[index] == 0 {
        var end = index

        while end < 8, address[end] == 0 {
          end += 1
        }

        if end - index > bestLength {
          bestStart = index
          bestLength = end - index
        }

        index = end
      } else {
        index += 1
      }
    }

    var out = ""
    var ignoreZero = false

    for (position, piece) in address.enumerated() {
      if ignoreZero, piece == 0 {
        continue
      }

      ignoreZero = false

      if bestStart == position {
        out += position == 0 ? "::" : ":"
        ignoreZero = true
        continue
      }

      out += String(piece, radix: 16)

      if position != 7 {
        out += ":"
      }
    }

    return out
  }
}
