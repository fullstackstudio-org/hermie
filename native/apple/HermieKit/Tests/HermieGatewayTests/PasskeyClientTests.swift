import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// What a passkey route's refusal reads as, and the host the sheet names.
@Suite struct PasskeyClientTests {
  static func refusal(_ status: Int, error: String, retryAfter: String = "") -> PasskeyRouteError {
    PasskeyClient.refusal(HTTPExchange(status: status, body: ["error": .string(error)], retryAfter: retryAfter))
  }

  @Test("a 429 is rate_limited with the seconds Retry-After gives")
  func rateLimited() {
    let limited = Self.refusal(429, error: "rate_limited", retryAfter: "30")
    #expect(limited.kind == .rateLimited)
    #expect(limited.retryAfter == 30)
    #expect(limited.error == "rate_limited")

    #expect(Self.refusal(429, error: "rate_limited").retryAfter == nil, "no header")
    #expect(Self.refusal(429, error: "rate_limited", retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT").retryAfter == nil)
    #expect(Self.refusal(429, error: "rate_limited", retryAfter: "-5").retryAfter == nil)
    #expect(Self.refusal(400, error: "bad_request", retryAfter: "30").retryAfter == nil, "only a 429 waits")
  }

  @Test("a 403 origin_not_listed says the gateway does not list the address the app dialed")
  func originNotListed() {
    #expect(Self.refusal(403, error: "origin_not_listed").kind == .originNotListed)
    #expect(Self.refusal(403, error: "no_identity").kind == .refused)
    #expect(Self.refusal(404, error: "").kind == .notOffered)
  }

  @Test("the sheet's host keeps the path prefix of a gateway served under one")
  func hostWithPath() {
    #expect(ConfirmDisplay.subject("", baseURL: "https://gw.example.com").host == "gw.example.com")
    #expect(ConfirmDisplay.subject("", baseURL: "https://gw.example.com/hermes").host == "gw.example.com/hermes")
    #expect(ConfirmDisplay.subject("", baseURL: "https://gw.example.com:8443/a/b").host == "gw.example.com:8443/a/b")
  }
}
