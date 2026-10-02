import Foundation

/**
 The one network session a direct send uses: ephemeral, and it never follows a redirect.

 The same rule the app applies to every credentialed call (`HermieGateway.HTTPTransport`): no
 credential crosses a redirect. A gateway behind an access front door answers an unauthenticated
 or expired request with a redirect to its identity provider; following it would replay the
 session token or the bearer, and the front door's own headers, to that other host. So every
 redirect is refused before anything is sent where it points, and the refused response comes back
 as the answer — a 3xx the caller treats as a refusal, which queues the share for the app.

 Ephemeral, with no cache and no cookies, because nothing a share sends should outlive it. Never a
 background session: those follow redirects on their own without asking the delegate, and the
 transfer would run on after this process can no longer check anything about it.
 */
final class ShareTransport: NSObject, URLSessionTaskDelegate, URLSessionWebSocketDelegate, Sendable {
  /// A session whose delegate is a fresh `ShareTransport`. Invalidate it when done; it holds its
  /// delegate until then.
  static func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral

    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 60

    return URLSession(configuration: configuration, delegate: ShareTransport(), delegateQueue: nil)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    nil
  }
}
