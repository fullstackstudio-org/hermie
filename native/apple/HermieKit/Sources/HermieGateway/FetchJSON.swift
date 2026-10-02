import HermieProtocol

/// The pure half of `fetch-json.ts`: the two TLS predicates, the two body
/// parsers and the default window for one call. The round trip itself is
/// `HTTPTransport`.
public enum FetchJSON {
  /// Default window for a single HTTP call to a gateway (`DEFAULT_HTTP_TIMEOUT_MS`).
  public static let defaultTimeoutMs = 10_000

  /// Did the secure channel fail, whatever the reason? (`looksLikeTlsFailure`)
  ///
  /// Plain substring tests on the lowercased message: `ssl`, `certificate`,
  /// `tls` or `-1200`. The transport also reads `URLError` codes, which a
  /// JavaScript `fetch` never sees; this predicate is what it applies to text.
  public static func looksLikeTLSFailure(_ message: String) -> Bool {
    let lowered = message.lowercased()

    return contains(lowered, "ssl") || contains(lowered, "certificate") || contains(lowered, "tls")
      || contains(lowered, "-1200")
  }

  /// Did the secure channel fail because of the CERTIFICATE, rather than
  /// because there was no TLS there at all? (`looksLikeCertificateFailure`)
  ///
  /// The difference decides whether an address typed without a scheme may be
  /// retried in the clear: a rejected certificate means there IS an https
  /// server on that port.
  public static func looksLikeCertificateFailure(_ message: String) -> Bool {
    let lowered = message.lowercased()

    return contains(lowered, "certificate") || contains(lowered, "untrusted") || contains(lowered, "self signed")
      || contains(lowered, "self-signed") || hasCertificateErrorCode(lowered)
  }

  /// Parse a response body that must be JSON, object or array (`parseJsonBody`).
  ///
  /// The grammar is `JSON.parse`'s: surrounding JSON whitespace is skipped, a
  /// byte order mark is not whitespace, a repeated key keeps the last value.
  public static func parseJSONBody(_ text: String, url: String, kind: GatewayErrorKind) throws(GatewayError) -> JSONValue {
    do {
      return try JSONValue(parsing: text)
    } catch {
      throw GatewayError(kind, "\(url) answered with something that is not JSON.")
    }
  }

  /// Parse a response body that must be a JSON object (`parseJsonObject`): the
  /// status probe, the credential exchange and the token endpoints.
  public static func parseJSONObject(_ text: String, url: String, kind: GatewayErrorKind) throws(GatewayError)
    -> JSONObject
  {
    guard case .object(let object) = try parseJSONBody(text, url: url, kind: kind) else {
      throw GatewayError(kind, "\(url) answered with JSON that is not an object.")
    }

    return object
  }

  /// `String.prototype.includes`, code point for code point.
  static func contains(_ haystack: String, _ needle: String) -> Bool {
    let scalars = Array(haystack.unicodeScalars)
    let wanted = Array(needle.unicodeScalars)

    guard !wanted.isEmpty, scalars.count >= wanted.count else {
      return wanted.isEmpty
    }

    return (0...(scalars.count - wanted.count)).contains { start in
      scalars[start..<(start + wanted.count)].elementsEqual(wanted)
    }
  }

  /// `/-120[2-6]\b/`: the NSURLErrorServerCertificate… family, followed by a
  /// word boundary (end of text or anything outside `[A-Za-z0-9_]`).
  private static func hasCertificateErrorCode(_ lowered: String) -> Bool {
    let scalars = Array(lowered.unicodeScalars)
    let prefix = Array("-120".unicodeScalars)

    guard scalars.count >= prefix.count + 1 else {
      return false
    }

    for start in 0...(scalars.count - prefix.count - 1) {
      guard scalars[start..<(start + prefix.count)].elementsEqual(prefix) else {
        continue
      }

      let digit = scalars[start + prefix.count]

      guard ("2"..."6").contains(digit) else {
        continue
      }

      let next = start + prefix.count + 1

      if next == scalars.count || !isWordCharacter(scalars[next]) {
        return true
      }
    }

    return false
  }

  private static func isWordCharacter(_ scalar: Unicode.Scalar) -> Bool {
    JSText.isASCIIAlpha(scalar) || JSText.isASCIIDigit(scalar) || scalar == "_"
  }
}
