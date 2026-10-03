import CryptoKit
import Foundation

// The client half of `contract/confirm-passkey/README.md`: base64url (§2), the base URL (§3), the
// text digest (§4), the challenge (§5), the user handle (§6) and enrolment codes (§7). Every
// function here answers what `vectors.json` says, byte for byte.

/// Base64url without padding (contract §2), strict on the way in.
public enum Base64URL {
  public static func encode(_ bytes: [UInt8]) -> String {
    Base64.encodeURL(bytes)
  }

  public static func encode(_ data: Data) -> String {
    Base64.encodeURL(Array(data))
  }

  /// The bytes, or `nil` for padding, a character outside the alphabet, an impossible length, or
  /// non-canonical trailing bits (re-encoding must give the input back).
  public static func decode(_ text: String) -> [UInt8]? {
    let scalars = text.unicodeScalars

    guard scalars.count % 4 != 1, scalars.allSatisfy(isAlphabet) else {
      return nil
    }

    var standard = String(String.UnicodeScalarView(scalars.map { $0 == "-" ? "+" : $0 == "_" ? "/" : $0 }))
    standard += String(repeating: "=", count: (4 - scalars.count % 4) % 4)

    guard let data = Data(base64Encoded: standard), encode(data) == text else {
      return nil
    }

    return Array(data)
  }

  private static func isAlphabet(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "A"..."Z", "a"..."z", "0"..."9", "-", "_": true
    default: false
    }
  }
}

/// A gateway's base URL (contract §3): `scheme://host[:port]` plus the normalised path prefix.
/// Every side must compute the same string from what it dialed, or every answer is refused.
public enum PasskeyBaseURL {
  /// The input is not an http(s) base URL.
  public struct Invalid: Error, Sendable, Equatable {
    public let reason: String
  }

  /// The serialised base URL of `input`. The host goes through the WHATWG parser (A-labels,
  /// IPv6 compressed and lower case, default port dropped); the path is read from the RAW input,
  /// because that parser would resolve `/a/../b` before it could be refused.
  public static func serialise(_ input: String) throws(Invalid) -> String {
    guard let parts = split(input) else {
      throw Invalid(reason: "not an http(s) URL with a host")
    }

    let origin = try origin(scheme: parts.scheme, authority: parts.authority)
    let segments = try pathSegments(parts.path)

    return segments.isEmpty ? origin : origin + "/" + segments.joined(separator: "/")
  }

  /// The web origin of a serialised base URL (its path prefix dropped).
  public static func origin(of baseURL: String) -> String {
    GatewayAddress.origin(of: baseURL)
  }

  /// `^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)`.
  private static func split(_ input: String) -> (scheme: String, authority: String, path: String)? {
    guard let separator = input.range(of: "://") else {
      return nil
    }

    let scheme = input[..<separator.lowerBound]
    let rest = input[separator.upperBound...]

    guard let first = scheme.unicodeScalars.first, JSText.isASCIIAlpha(first),
      scheme.unicodeScalars.allSatisfy({ JSText.isASCIIAlpha($0) || JSText.isASCIIDigit($0) || "+.-".unicodeScalars.contains($0) })
    else {
      return nil
    }

    let authorityEnd = rest.firstIndex { "/?#".contains($0) } ?? rest.endIndex
    let tail = rest[authorityEnd...]
    let pathEnd = tail.firstIndex { "?#".contains($0) } ?? tail.endIndex

    return (scheme.lowercased(), String(rest[..<authorityEnd]), String(tail[..<pathEnd]))
  }

  private static func origin(scheme: String, authority: String) throws(Invalid) -> String {
    guard scheme == "http" || scheme == "https", !authority.isEmpty,
      let url = WHATWGURL.parse("\(scheme)://\(authority)"), let host = url.host, !host.isEmpty, host != "[]"
    else {
      throw Invalid(reason: "not an http(s) URL with a host")
    }

    if !host.hasPrefix("["), host.split(separator: ".", omittingEmptySubsequences: false).contains(where: \.isEmpty) {
      throw Invalid(reason: "empty host label")
    }

    return "\(scheme)://\(url.hostWithPort)"
  }

  private static func pathSegments(_ raw: String) throws(Invalid) -> [String] {
    var path = Substring(raw)

    while path.hasSuffix("/") {
      path.removeLast()
    }

    guard !path.isEmpty else {
      return []
    }

    let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()

    guard segments.allSatisfy(isSegment) else {
      throw Invalid(reason: "path prefix")
    }

    return segments.map(upperCasingPercentTriplets)
  }

  /// A non-empty RFC 3986 segment of `pchar`s that is not `.` or `..`.
  private static func isSegment(_ segment: Substring) -> Bool {
    guard !segment.isEmpty, segment != ".", segment != ".." else {
      return false
    }

    let bytes = Array(segment.utf8)
    var index = 0

    while index < bytes.count {
      if bytes[index] == UInt8(ascii: "%") {
        guard index + 2 < bytes.count, isHex(bytes[index + 1]), isHex(bytes[index + 2]) else {
          return false
        }

        index += 3
      } else {
        guard isPChar(bytes[index]) else {
          return false
        }

        index += 1
      }
    }

    return true
  }

  private static func isHex(_ byte: UInt8) -> Bool {
    (0x30...0x39).contains(byte) || (0x41...0x46).contains(byte) || (0x61...0x66).contains(byte)
  }

  private static func isPChar(_ byte: UInt8) -> Bool {
    let unreservedOrSub = Array("._~!$&'()*+,;=:@-".utf8)
    return (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
      || unreservedOrSub.contains(byte)
  }

  private static func upperCasingPercentTriplets(_ segment: Substring) -> String {
    var out = ""
    var pending = 0

    for character in segment {
      if character == "%" {
        pending = 2
        out.append(character)
      } else if pending > 0 {
        pending -= 1
        out.append(contentsOf: character.uppercased())
      } else {
        out.append(character)
      }
    }

    return out
  }
}

/// Why the challenge commits to what it commits to (contract §5).
public enum PasskeyPurpose: String, Sendable, Hashable, CaseIterable {
  case confirm, register, invite, revoke
}

/// What a passkey ceremony is about, as the app SHOWS it: the text of a confirmation, and the base
/// URL of the gateway the app dialed.
///
/// The challenge is computed from this value and nothing else of its kind, and the confirm sheet
/// renders this value and nothing else (plan P3, contract §4): a signature over text T exists only
/// if the app showed T. Title, summary and detail are kept exactly as the gateway sent them, with
/// no trimming, normalisation or newline conversion; the detail is shown with its whitespace
/// preserved (monospaced, never re-wrapped).
public struct ConfirmDisplay: Sendable, Hashable {
  public let title: String
  public let summary: String
  /// `nil` and `""` are the same text.
  public let detail: String?
  /// The serialised base URL the app dialed (`PasskeyBaseURL.serialise` of the stored address).
  public let baseURL: String

  public init(title: String, summary: String, detail: String?, baseURL: String) {
    self.title = title
    self.summary = summary
    self.detail = detail
    self.baseURL = baseURL
  }

  /// A step-up or a registration: title `""`, summary the subject, detail `""`.
  public static func subject(_ subject: String, baseURL: String) -> ConfirmDisplay {
    ConfirmDisplay(title: "", summary: subject, detail: nil, baseURL: baseURL)
  }

  /// The host the sheet names, from `baseURL`.
  public var host: String {
    WHATWGURL.parse(baseURL)?.hostWithPort ?? baseURL
  }

  /// `text_digest` (contract §4).
  public var textDigest: [UInt8] {
    PasskeyChallenge.textDigest(title: title, summary: summary, detail: detail)
  }
}

/// The fields of the challenge that come from the gateway (a frame, a registration or a step-up).
public struct PasskeyChallengeBinding: Sendable, Hashable {
  public var purpose: PasskeyPurpose
  public var gatewayID: [UInt8]
  public var userID: String
  /// `confirm`: the frame's `params.session_id`. Others: `""`.
  public var sessionID: String
  /// `confirm`: the frame's JSON-RPC id. Others: the registration or step-up id.
  public var requestID: String
  public var nonce: [UInt8]

  public init(
    purpose: PasskeyPurpose,
    gatewayID: [UInt8],
    userID: String,
    sessionID: String = "",
    requestID: String,
    nonce: [UInt8]
  ) {
    self.purpose = purpose
    self.gatewayID = gatewayID
    self.userID = userID
    self.sessionID = sessionID
    self.requestID = requestID
    self.nonce = nonce
  }
}

/// The challenge construction of contract §5, and the digests around it.
public enum PasskeyChallenge {
  /// `SHA-256(S("hermie-confirm-text-v1") ‖ S(title) ‖ S(summary) ‖ S(detail or ""))`.
  public static func textDigest(title: String, summary: String, detail: String?) -> [UInt8] {
    var preimage: [UInt8] = []
    appendString("hermie-confirm-text-v1", to: &preimage)
    appendString(title, to: &preimage)
    appendString(summary, to: &preimage)
    appendString(detail ?? "", to: &preimage)
    return Array(SHA256.hash(data: preimage))
  }

  /// The preimage of the challenge, for a test that compares it with `preimage_hex`.
  public static func preimage(_ display: ConfirmDisplay, _ binding: PasskeyChallengeBinding) -> [UInt8] {
    var preimage: [UInt8] = []
    appendString("hermie-confirm-v1", to: &preimage)
    appendString(binding.purpose.rawValue, to: &preimage)
    appendString(display.baseURL, to: &preimage)
    appendBytes(binding.gatewayID, to: &preimage)
    appendString(binding.userID, to: &preimage)
    appendString(binding.sessionID, to: &preimage)
    appendString(binding.requestID, to: &preimage)
    appendBytes(binding.nonce, to: &preimage)
    appendBytes(display.textDigest, to: &preimage)
    return preimage
  }

  /// The 32 bytes the WebAuthn ceremony signs.
  public static func challenge(_ display: ConfirmDisplay, _ binding: PasskeyChallengeBinding) -> [UInt8] {
    Array(SHA256.hash(data: preimage(display, binding)))
  }

  /// `HMAC-SHA-256(handle_key, "user-handle-v1" ‖ user_id)` (contract §6). The gateway's: a client
  /// never holds the key and reads its handle from `GET /api/auth/passkeys`. Here for the vectors.
  public static func userHandle(handleKey: [UInt8], userID: String) -> [UInt8] {
    let mac = HMAC<SHA256>.authenticationCode(
      for: Array("user-handle-v1".utf8) + Array(userID.utf8),
      using: SymmetricKey(data: handleKey)
    )
    return Array(mac)
  }

  /// `S(s)`: a 4-byte big-endian length of the UTF-8 bytes, then the bytes.
  private static func appendString(_ string: String, to buffer: inout [UInt8]) {
    appendBytes(Array(string.utf8), to: &buffer)
  }

  /// `LP(b)`.
  private static func appendBytes(_ bytes: [UInt8], to buffer: inout [UInt8]) {
    let count = UInt32(bytes.count)
    buffer += [UInt8(count >> 24 & 0xFF), UInt8(count >> 16 & 0xFF), UInt8(count >> 8 & 0xFF), UInt8(count & 0xFF)]
    buffer += bytes
  }
}

/// Enrolment codes as a person types them (contract §7).
public enum EnrolmentCode {
  private static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

  /// The canonical 20 symbols: upper-cased, `-` and spaces dropped, `O` read as `0`, `I` and `L` as
  /// `1`; `nil` for anything else or another length.
  public static func canonical(_ input: String) -> String? {
    var out = ""

    for character in input.uppercased() where character != "-" && character != " " {
      let mapped: Character =
        switch character {
        case "O": "0"
        case "I", "L": "1"
        default: character
        }

      guard alphabet.contains(mapped) else {
        return nil
      }

      out.append(mapped)
    }

    return out.count == 20 ? out : nil
  }
}

extension GatewayAddress {
  /// The base URL a passkey challenge commits to for a stored gateway address (contract §3).
  public static func passkeyBaseURL(of address: String) throws(PasskeyBaseURL.Invalid) -> String {
    try PasskeyBaseURL.serialise(address)
  }
}
