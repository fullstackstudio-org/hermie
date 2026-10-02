import Foundation
import HermieProtocol
import Synchronization

/// Which redirects a request may follow. Neither ever carries a request to
/// another origin: scheme, host and port must all stay the same.
public enum RedirectPolicy: Sendable, Equatable {
  /// Follow none. Every authenticated call, the ticket mint and the token endpoints.
  case refuseAll
  /// Follow one that stays on the same origin. Only the unauthenticated probe.
  case sameOrigin
}

/// One HTTP call as `requestText` takes it.
public struct JSONRequest: Sendable {
  public var method: String
  /// Sent as given, after `accept: application/json`; `content-type` is set when there is a body.
  public var headers: [String: String]
  /// Serialised as JSON. `nil` sends no body.
  public var body: JSONValue?
  /// Milliseconds; `nil` is `FetchJSON.defaultTimeoutMs`, zero or less is no limit.
  public var timeoutMs: Int?
  /// No redirect is followed unless this says so.
  public var redirects: RedirectPolicy

  public init(
    method: String = "GET",
    headers: [String: String] = [:],
    body: JSONValue? = nil,
    timeoutMs: Int? = nil,
    redirects: RedirectPolicy = .refuseAll
  ) {
    self.method = method
    self.headers = headers
    self.body = body
    self.timeoutMs = timeoutMs
    self.redirects = redirects
  }
}

/// What came back from one call, as `requestText` reports it.
public struct JSONResponse: Sendable, Equatable {
  public var status: Int
  /// The body as text: UTF-8, invalid sequences replaced, a leading byte order mark dropped (as `Response.text()`).
  public var text: String
  /// The URL the answer actually came from, after any same-origin redirects.
  public var url: String
  /// The `server` header, verbatim; empty when absent.
  public var server: String

  public var ok: Bool { (200...299).contains(status) }

  public init(status: Int, text: String, url: String, server: String) {
    self.status = status
    self.text = text
    self.url = url
    self.server = server
  }
}

/// A transport failure, with the facts the probe's scheme fallback needs that a
/// `GatewayError` does not carry: whether a TLS failure was about the
/// certificate (the reference reads it off `error.cause`), and whether the
/// peer demonstrably spoke TLS at all.
struct TransportFailure: Error {
  var error: GatewayError
  var certificate: Bool
  /// The handshake failed on a TLS alert the peer sent, so there IS a TLS
  /// server on that port (a protocol version or cipher it will not accept, an
  /// ATS minimum it does not meet). Retrying in the clear would answer a
  /// question nobody asked, exactly as for a rejected certificate.
  var peerSpokeTLS = false

  /// An https server is there: never a reason to try http instead.
  var tlsServerAnswered: Bool { certificate || peerSpokeTLS }
}

/// The round trip of `fetch-json.ts` (`requestText`) over `URLSession`.
///
/// What it does that a plain `URLSession.data(for:)` would not:
///
/// - **The window comes from an injected clock**, so a test can time a call
///   out without waiting. The request's own idle timeout is set far out of the way.
/// - **Nothing is cached and no cookie is sent or stored**: every call is
///   `no-store` (a cached 301 once outlived an app's whole installation), and
///   the native app has no cookie flow.
/// - **No credential ever crosses a redirect.** A redirect to another origin
///   (scheme, host or port, so https → http on one host too) is never
///   followed, and only the unauthenticated probe follows one that stays on
///   its origin (`RedirectPolicy`). A refusal happens before anything is sent
///   to where it pointed, and is reported as a `redirect` error whose
///   `redirectedTo` is that origin. The reference follows every redirect and
///   only the probe looks at where it landed.
/// - **Failures are `GatewayError`s**: `timeout`, `tls` (certificate or
///   handshake), `network` and `redirect`. HTTP statuses are the caller's to read.
public struct HTTPTransport: Sendable {
  public let session: URLSession
  public let clock: any Clock<Duration>

  public init(session: URLSession = HTTPTransport.sharedSession, clock: any Clock<Duration> = ContinuousClock()) {
    self.session = session
    self.clock = clock
  }

  /// One session for every transport that is not handed its own.
  public static let sharedSession = makeSession()

  /// An ephemeral session with no URL cache and no cookie storage.
  public static func makeSession(configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    return URLSession(configuration: configuration)
  }

  /// `requestText`: one call with a timeout, returning the raw body. HTTP
  /// statuses are the caller's to interpret.
  public func requestText(_ url: String, _ request: JSONRequest = JSONRequest()) async throws(GatewayError)
    -> JSONResponse
  {
    do {
      return try await requestTextDetailed(url, request)
    } catch {
      throw error.error
    }
  }

  func requestTextDetailed(_ url: String, _ request: JSONRequest) async throws(TransportFailure) -> JSONResponse {
    var headers = ["accept": "application/json"]

    for (name, value) in request.headers {
      headers[name] = value
    }

    var body: Data?

    if let json = request.body {
      do {
        body = try json.canonicalData()
      } catch {
        throw TransportFailure(
          error: GatewayError(.config, "The request to \(url) has a body that is not JSON."),
          certificate: false
        )
      }

      headers["content-type"] = "application/json"
    }

    let raw = try await send(
      url,
      method: request.method,
      headers: headers,
      body: body,
      timeoutMs: request.timeoutMs ?? FetchJSON.defaultTimeoutMs,
      redirects: request.redirects
    )

    return JSONResponse(status: raw.status, text: Self.decodeText(raw.data), url: raw.url, server: raw.server)
  }

  /// What `send` hands back: the status, the bytes and the headers anyone reads.
  struct RawResponse: Sendable {
    var status: Int
    var data: Data
    var url: String
    var server: String
    var contentType: String
  }

  private enum Race: Sendable {
    case done(Data, URLResponse)
    case timedOut
  }

  /// The one place a request goes out.
  func send(
    _ url: String,
    method: String,
    headers: [String: String],
    body: Data?,
    timeoutMs: Int,
    redirects: RedirectPolicy
  ) async throws(TransportFailure) -> RawResponse {
    guard let target = URL(string: url), URLOrigin(target) != nil else {
      throw TransportFailure(
        error: GatewayError(.network, "Could not reach \(url): it is not a valid address."),
        certificate: false
      )
    }

    var request = URLRequest(url: target)
    request.httpMethod = method
    request.httpBody = body
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    // The window is the clock's; the session's own idle timer must never fire first.
    request.timeoutInterval = 86_400

    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let guardian = RedirectGuard(asked: target, policy: redirects)
    let outgoing = request
    let session = session
    let clock = clock
    let race: Race

    do {
      race = try await withThrowingTaskGroup(of: Race.self) { group in
        group.addTask {
          let (data, response) = try await session.data(for: outgoing, delegate: guardian)
          return .done(data, response)
        }

        if timeoutMs > 0 {
          group.addTask {
            try await clock.sleep(for: .milliseconds(timeoutMs))
            return .timedOut
          }
        }

        defer { group.cancelAll() }
        return try await group.next()!
      }
    } catch {
      throw Self.failure(for: error, url: url)
    }

    switch race {
    case .timedOut:
      throw TransportFailure(
        error: GatewayError(.timeout, "\(url) did not answer within \(Self.wholeSeconds(timeoutMs)) seconds."),
        certificate: false
      )
    case .done(let data, let response):
      if let refusal = guardian.refusal {
        throw TransportFailure(
          error: FetchJSON.redirectError(
            requestedURL: url,
            target: refusal.target,
            status: (response as? HTTPURLResponse)?.statusCode
          ),
          certificate: false
        )
      }

      let http = response as? HTTPURLResponse

      return RawResponse(
        status: http?.statusCode ?? 0,
        data: data,
        url: response.url?.absoluteString ?? "",
        server: http?.value(forHTTPHeaderField: "server") ?? "",
        contentType: http?.value(forHTTPHeaderField: "content-type") ?? ""
      )
    }
  }

  /// `Math.round(ms / 1000)`.
  private static func wholeSeconds(_ ms: Int) -> String {
    JSText.numberString((Double(ms) / 1000 + 0.5).rounded(.down))
  }

  /// `Response.text()`: UTF-8 with replacement, and a leading byte order mark removed.
  static func decodeText(_ data: Data) -> String {
    let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
    let bytes = data.starts(with: bom) ? data.dropFirst(3) : data[...]
    return String(decoding: bytes, as: UTF8.self)
  }

  /// The `catch` of `requestText`: cancelled, TLS (certificate or handshake), or unreachable.
  private static func failure(for error: any Error, url: String) -> TransportFailure {
    if Task.isCancelled || error is CancellationError {
      return TransportFailure(error: GatewayError(.network, "The request to \(url) was cancelled."), certificate: false)
    }

    let message = (error as NSError).localizedDescription
    // A JavaScript `fetch` only ever has the message; `URLError` also has a code,
    // which says the same thing in every locale. NSURLErrorSecureConnectionFailed
    // (-1200) is a handshake that died; -1201…-1206 are about a certificate.
    let code = (error as? URLError)?.code.rawValue
    let tls = (code.map { (-1206)...(-1200) ~= $0 } ?? false) || FetchJSON.looksLikeTLSFailure(message)
    let certificate =
      (code.map { (-1206)...(-1201) ~= $0 } ?? false) || FetchJSON.looksLikeCertificateFailure(message)

    if tls {
      return TransportFailure(
        error: GatewayError(
          .tls,
          certificate
            ? "The TLS certificate for \(url) was rejected: \(message)"
            : "The TLS handshake with \(url) failed: \(message)"
        ),
        certificate: certificate,
        peerSpokeTLS: peerSentAlert(error)
      )
    }

    return TransportFailure(error: GatewayError(.network, "Could not reach \(url): \(message)"), certificate: false)
  }

  /// SecureTransport's received-alert codes, `errSSLPeerUnexpectedMsg` (-9819)
  /// through `errSSLPeerNoRenegotiation` (-9840): only a TLS peer sends an alert.
  static let peerAlertCodes = (-9840)...(-9819)

  /// Did the handshake fail on an alert the peer sent? Read from the stream
  /// error CFNetwork attaches to a -1200 (`_kCFStreamErrorCodeKey`, or an
  /// underlying error in `NSOSStatusErrorDomain` or `kCFStreamErrorDomainSSL`).
  /// Anything else — a peer that closed the connection or answered with bytes
  /// that are not TLS — leaves the reading as it was, so the scheme fallback
  /// still reaches a plain-http gateway.
  static func peerSentAlert(_ error: any Error) -> Bool {
    let nsError = error as NSError
    var codes: [Int] = []

    if let code = nsError.userInfo["_kCFStreamErrorCodeKey"] as? Int {
      codes.append(code)
    }

    if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
      if underlying.domain == NSOSStatusErrorDomain || underlying.domain == "kCFStreamErrorDomainSSL" {
        codes.append(underlying.code)
      }

      if let code = underlying.userInfo["_kCFStreamErrorCodeKey"] as? Int {
        codes.append(code)
      }
    }

    return codes.contains { peerAlertCodes.contains($0) }
  }
}

/// Scheme, host and port as Foundation parsed them: scheme and host lowercased,
/// an IPv6 host bracketed, the scheme's default port filled in.
///
/// Read from `URL`'s components, never from `absoluteString`: a `URLResponse`
/// URL is not serialised the way the URL Standard would.
struct URLOrigin: Sendable, Equatable {
  var scheme: String
  var host: String
  var port: Int

  init?(_ url: URL?) {
    guard let url, let scheme = url.scheme?.lowercased(), let rawHost = url.host(percentEncoded: false),
      !rawHost.isEmpty
    else {
      return nil
    }

    let defaultPort: Int? =
      switch scheme {
      case "http", "ws": 80
      case "https", "wss": 443
      default: nil
      }

    guard let port = url.port ?? defaultPort else {
      return nil
    }

    let host = rawHost.lowercased()
    self.scheme = scheme
    self.host = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    self.port = port
  }

  /// `scheme://host[:port]`, the port left out when it is the scheme's default.
  var serialized: String {
    let isDefault = ((scheme == "http" || scheme == "ws") && port == 80) || ((scheme == "https" || scheme == "wss") && port == 443)
    return isDefault ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port)"
  }
}

/// Decides each redirect by the request's `RedirectPolicy` (comparing
/// Foundation's own scheme, host and port), and remembers the first one it
/// refused. The error itself is `FetchJSON.redirectError`, as the reference words it.
private final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
  private let asked: URLOrigin?
  private let policy: RedirectPolicy
  private let refused = Mutex<Refusal?>(nil)

  /// A redirect that was not followed, and the URL it pointed at.
  struct Refusal: Sendable {
    var target: String
  }

  init(asked url: URL, policy: RedirectPolicy) {
    asked = URLOrigin(url)
    self.policy = policy
  }

  /// The first redirect refused, if any.
  var refusal: Refusal? {
    refused.withLock { $0 }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    let landed = URLOrigin(request.url)

    if policy == .sameOrigin, let asked, let landed, asked == landed {
      completionHandler(request)
      return
    }

    refused.withLock { $0 = $0 ?? Refusal(target: request.url?.absoluteString ?? "") }
    completionHandler(nil)
  }
}
