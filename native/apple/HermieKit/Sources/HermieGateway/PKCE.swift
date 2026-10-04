import CryptoKit
import Foundation

/// One sign-in attempt's PKCE values (RFC 7636; the port of `pkce.ts`).
public struct PKCE: Sendable, Equatable {
  /// 43-character base64url verifier (32 random bytes), RFC 7636 §4.1.
  public var verifier: String
  /// base64url(SHA-256(verifier)), sent as `code_challenge`.
  public var challenge: String
  /// 32-character base64url CSRF value (24 random bytes) echoed back on the redirect.
  public var state: String

  public init(verifier: String, challenge: String, state: String) {
    self.verifier = verifier
    self.challenge = challenge
    self.state = state
  }

  /// Loopback redirect the native flow ends on. Nothing listens on it: the app
  /// intercepts the navigation before the request is made. The gateway accepts
  /// loopback IP literals only (RFC 8252 §8.3).
  public static let redirectURI = "http://127.0.0.1:38007/callback"

  /// A fresh triple. `randomBytes(n)` is called twice, for 32 then 24 bytes;
  /// the challenge hashes the verifier STRING's bytes, not the raw random bytes.
  public static func create(randomBytes: (Int) -> [UInt8] = systemRandomBytes) -> PKCE {
    let verifier = Base64.encodeURL(randomBytes(32))
    let challenge = Base64.encodeURL(Array(SHA256.hash(data: Data(verifier.utf8))))
    let state = Base64.encodeURL(randomBytes(24))

    return PKCE(verifier: verifier, challenge: challenge, state: state)
  }

  /// Cryptographically secure bytes from the system generator, through CryptoKit.
  public static func systemRandomBytes(_ count: Int) -> [UInt8] {
    guard count > 0 else {
      return []
    }

    let key = SymmetricKey(size: SymmetricKeySize(bitCount: count * 8))
    return key.withUnsafeBytes { Array($0) }
  }
}

/// What the authorize URL carries besides the base.
public struct AuthorizeParams: Sendable, Equatable {
  public var provider: String?
  public var challenge: String
  public var state: String
  public var redirectURI: String?
  /// The fresh-authentication grant this sign-in completes instead of signing in (contract §7.2,
  /// passkey self-enrolment). `nil` (or empty) for an ordinary sign-in.
  public var reauth: String?

  public init(
    provider: String? = nil,
    challenge: String,
    state: String,
    redirectURI: String? = nil,
    reauth: String? = nil
  ) {
    self.provider = provider
    self.challenge = challenge
    self.state = state
    self.redirectURI = redirectURI
    self.reauth = reauth
  }
}

/// What an intercepted loopback redirect said.
public enum LoopbackRedirect: Sendable, Equatable {
  case code(code: String, state: String)
  case error(error: String, description: String)
}

extension PKCE {
  /// The URL the sign-in web view opens: `<base>/auth/native/authorize?…`.
  ///
  /// Query order is provider (only when non-empty), `code_challenge`,
  /// `code_challenge_method=S256`, `redirect_uri`, `state`, then `reauth` (only
  /// when non-empty: a re-authentication for a grant), serialised as
  /// `URLSearchParams` does it — space as `+`, only `A-Z a-z 0-9 * - . _`
  /// unescaped. Foundation's `URLQueryItem` encoding leaves `/ : ? ~ ! ' ( )`
  /// alone and writes a space as `%20`, so the serialiser is written out.
  public static func authorizeURL(baseURL: String, params: AuthorizeParams) throws(GatewayError) -> String {
    let base = try GatewayAddress.apiURL(baseURL, path: "/auth/native/authorize")

    // `new URL(base)` round-trips a normalised base unchanged; reading it back
    // through the parser keeps that true even for a base the parser rewrites.
    guard let url = WHATWGURL.parse(base) else {
      throw GatewayError(.config, "That is not a valid address: \(base)")
    }

    var pairs: [(String, String)] = []

    if let provider = params.provider, !provider.isEmpty {
      pairs.append(("provider", provider))
    }

    pairs.append(("code_challenge", params.challenge))
    pairs.append(("code_challenge_method", "S256"))
    pairs.append(("redirect_uri", params.redirectURI ?? redirectURI))
    pairs.append(("state", params.state))

    if let reauth = params.reauth, !reauth.isEmpty {
      pairs.append(("reauth", reauth))
    }

    return "\(url.protocolString)//\(url.hostWithPort)\(url.pathname)?\(JSText.formSerialize(pairs))"
  }

  /// True for the loopback callback the web view must intercept instead of loading:
  /// `/^http:\/\/(127\.0\.0\.1|\[::1\])(:\d{1,5})?\//`, case-sensitive, with a port of at most 65535.
  public static func isLoopbackRedirect(_ url: String) -> Bool {
    let scalars = Array(url.unicodeScalars)
    var index = 0

    func consume(_ literal: String) -> Bool {
      let needle = Array(literal.unicodeScalars)

      guard index + needle.count <= scalars.count, Array(scalars[index..<(index + needle.count)]) == needle else {
        return false
      }

      index += needle.count
      return true
    }

    guard consume("http://"), consume("127.0.0.1") || consume("[::1]") else {
      return false
    }

    if index < scalars.count, scalars[index] == ":" {
      let start = index + 1
      var end = start

      while end < scalars.count, JSText.isASCIIDigit(scalars[end]) {
        end += 1
      }

      // `(:\d{1,5})?` is optional, so a bare `:` (or `:` without digits) can only fail on the `/` that
      // follows. Six digits or more, or a value above 65535, is not a port and the URL is not ours.
      if end > start {
        guard end - start <= 5, Int(JSText.string(scalars[start..<end]))! <= 65535 else {
          return false
        }

        index = end
      }
    }

    return index < scalars.count && scalars[index] == "/"
  }

  /// Would loading this URL reach a server on this device? The other half of
  /// `isLoopbackRedirect`: a sign-in web view must never load one of these
  /// unless it is the gateway's own origin, since any app may be listening.
  ///
  /// Read with the URL parser, as the web view reads it: http or https, and a
  /// host in 127.0.0.0/8, `localhost` or a name under it, `::1`, an IPv4-mapped
  /// loopback, or the unspecified address (`0.0.0.0`, `::`).
  public static func isLoopbackURL(_ url: String) -> Bool {
    guard let parsed = WHATWGURL.parse(url), parsed.scheme == "http" || parsed.scheme == "https",
      let host = parsed.host
    else {
      return false
    }

    // The parser has already canonicalised every IPv4 and IPv6 spelling.
    if host == "0.0.0.0" || host == "[::]" || host == "[::ffff:0:0]" {
      return true
    }

    return HostClassification.of(host).privacy == .loopback
  }

  /// Read `code`/`state` (or `error`/`error_description`) off an intercepted
  /// redirect. Only parses: the caller still compares `state`. Any scheme that
  /// `new URL` accepts parses; host and path are not checked here.
  public static func parseLoopbackRedirect(_ url: String) throws(GatewayError) -> LoopbackRedirect {
    guard let parsed = WHATWGURL.parse(url) else {
      throw GatewayError(.protocol, "The sign-in redirect was not a URL: \(url)")
    }

    let query = JSText.formParse(parsed.query ?? "")

    func get(_ name: String) -> String? {
      query.first { JSText.same($0.0, name) }?.1
    }

    if let error = get("error"), !error.isEmpty {
      return .error(error: error, description: get("error_description") ?? "")
    }

    guard let code = get("code"), !code.isEmpty, let state = get("state"), !state.isEmpty else {
      return .error(error: "invalid_redirect", description: "The sign-in redirect carried no code and no error.")
    }

    return .code(code: code, state: state)
  }
}
