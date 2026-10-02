import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The port of `fetch-json.test.ts`: which shapes the transport accepts, and
/// where an object is still the contract.
@Suite struct FetchJSONTests {
  static let base = "http://gateway.test"

  /// A server answering every call with one body (`answering`).
  static func answering(_ text: String, status: Int = 200) -> StubServer {
    StubServer { _ in .json(text, status: status, headers: ["content-type": "application/json"]) }
  }

  static func http(_ server: StubServer) throws -> HTTPClient {
    try HTTPClient(baseURL: base, credentials: AnonymousCredentials(), transport: server.transport())
  }

  // MARK: classifying a failed secure connection

  @Test(
    "reads %s as a TLS failure",
    arguments: [
      "A TLS error caused the secure connection to fail.",
      "javax.net.ssl.SSLException: Unable to parse TLS packet header",
      "unable to verify the first certificate",
      "Error code=-1200"
    ]
  )
  func readsAsTLS(_ message: String) {
    #expect(FetchJSON.looksLikeTLSFailure(message))
  }

  @Test("does not read an ordinary connection failure as one")
  func ordinaryFailureIsNotTLS() {
    #expect(!FetchJSON.looksLikeTLSFailure("connect ECONNREFUSED 10.0.0.4:443"))
    #expect(!FetchJSON.looksLikeTLSFailure("getaddrinfo ENOTFOUND hermes.test"))
  }

  @Test("reads %s — what a real fetch throws — as no kind of TLS failure", arguments: ["Network request failed", "fetch failed"])
  func realFetchMessages(_ message: String) {
    #expect(!FetchJSON.looksLikeTLSFailure(message))
    #expect(!FetchJSON.looksLikeCertificateFailure(message))
  }

  @Test(
    "reads %s as a CERTIFICATE failure — there is a real https server there",
    arguments: [
      "unable to verify the first certificate",
      "The certificate for this server is invalid",
      "Hostname/IP does not match certificate altnames",
      "self signed certificate in certificate chain",
      "NSURLErrorDomain Code=-1202"
    ]
  )
  func readsAsCertificate(_ message: String) {
    #expect(FetchJSON.looksLikeCertificateFailure(message))
  }

  @Test(
    "does not read %s as one — nothing there spoke TLS",
    arguments: [
      "A TLS error caused the secure connection to fail.",
      "javax.net.ssl.SSLException: Unable to parse TLS packet header",
      "write EPROTO ... wrong version number",
      "NSURLErrorDomain Code=-1200"
    ]
  )
  func handshakeIsNotCertificate(_ message: String) {
    #expect(!FetchJSON.looksLikeCertificateFailure(message))
  }

  // MARK: parseJsonBody

  @Test("accepts an array, which is what the cron list answers with")
  func bodyAcceptsArray() throws {
    #expect(try FetchJSON.parseJSONBody("[{\"id\":\"job-1\"}]", url: Self.base, kind: .protocol) == [["id": "job-1"]])
  }

  @Test("accepts an object, a string, a number and null just as readily")
  func bodyAcceptsAnything() throws {
    #expect(try FetchJSON.parseJSONBody("{\"ok\":true}", url: Self.base, kind: .protocol) == ["ok": true])
    #expect(try FetchJSON.parseJSONBody("\"done\"", url: Self.base, kind: .protocol) == "done")
    #expect(try FetchJSON.parseJSONBody("7", url: Self.base, kind: .protocol) == 7)
    #expect(try FetchJSON.parseJSONBody("null", url: Self.base, kind: .protocol) == .null)
  }

  @Test("still refuses a body that is not JSON at all")
  func bodyRefusesNonJSON() {
    do {
      _ = try FetchJSON.parseJSONBody("<html>nope</html>", url: Self.base, kind: .protocol)
      Issue.record("should have thrown")
    } catch {
      #expect(error.message.contains("not JSON"))
    }
  }

  // MARK: parseJsonObject

  @Test("refuses an array, which is the check the handshakes need")
  func objectRefusesArray() {
    do {
      _ = try FetchJSON.parseJSONObject("[1,2,3]", url: Self.base, kind: .notHermes)
      Issue.record("should have thrown")
    } catch {
      #expect(error.message.contains("not an object"))
    }
  }

  @Test("refuses the other non-objects too, including null")
  func objectRefusesOthers() {
    for body in ["null", "\"done\"", "7", "true"] {
      do {
        _ = try FetchJSON.parseJSONObject(body, url: Self.base, kind: .protocol)
        Issue.record("\(body) should have thrown")
      } catch {
        #expect(error.message.contains("not an object"))
      }
    }
  }

  @Test("carries the kind it was given, so a probe can say \"not a Hermes gateway\"")
  func objectCarriesKind() {
    do {
      _ = try FetchJSON.parseJSONObject("[]", url: Self.base, kind: .notHermes)
      Issue.record("should have thrown")
    } catch {
      #expect(error.kind == .notHermes)
    }
  }

  // MARK: a generic REST call through GatewayHttp

  @Test("hands an array body to the caller instead of throwing at it")
  func restHandsOverArray() async throws {
    let jobs = try await Self.http(Self.answering("[{\"id\":\"job-1\"},{\"id\":\"job-2\"}]")).get("/api/cron/jobs?profile=all")

    #expect(jobs?.arrayValue?.count == 2)
    #expect(jobs?[0]?["id"] == "job-1")
  }

  @Test("hands an object body over unchanged")
  func restHandsOverObject() async throws {
    let body = try await Self.http(Self.answering("{\"runs\":[],\"limit\":20}")).get("/api/cron/jobs/job-1/runs")

    #expect(body == ["runs": [], "limit": 20])
  }

  @Test("answers undefined for an empty body rather than a parse failure")
  func restEmptyBody() async throws {
    #expect(try await Self.http(Self.answering("")).delete("/api/cron/jobs/job-1") == nil)
  }

  @Test("still refuses a body that is not JSON")
  func restRefusesNonJSON() async throws {
    let error = await gatewayError { try await Self.http(Self.answering("<html>proxy error</html>")).get("/api/cron/jobs") }

    #expect(error?.message.contains("not JSON") == true)
  }

  // MARK: the handshakes that still require an object

  @Test("the status probe refuses an array")
  func probeRefusesArray() async {
    let error = await gatewayError { try await Probe.probeGateway(Self.base, transport: Self.answering("[]").transport()) }

    #expect(error?.message.contains("not an object") == true)
  }

  @Test("the provider list refuses an array")
  func providersRefuseArray() async {
    let calls = Counter()
    // The status answers a gated gateway; the provider list is the array.
    let server = StubServer { _ in calls.increment() == 1 ? .json("{\"auth_required\":true}") : .json("[]") }
    let error = await gatewayError { try await Probe.probeGateway(Self.base, transport: server.transport()) }

    #expect(error?.message.contains("not an object") == true)
  }

  @Test("the WebSocket ticket refuses an array")
  func ticketRefusesArray() async throws {
    let error = await gatewayError { try await Self.http(Self.answering("[]")).wsTicket() }

    #expect(error?.message.contains("without a ticket") == true)
  }

  @Test("the native token exchange refuses an array")
  func exchangeRefusesArray() async {
    let error = await gatewayError {
      try await NativeAuth.exchangeCode(
        baseURL: Self.base,
        code: "c",
        verifier: "v",
        options: NativeAuth.Options(transport: Self.answering("[]").transport())
      )
    }

    #expect(error?.message.contains("not an object") == true)
  }

  @Test("the native refresh refuses an array")
  func refreshRefusesArray() async {
    let error = await gatewayError {
      try await NativeAuth.refreshTokens(
        baseURL: Self.base,
        refreshToken: "r",
        provider: "self-hosted",
        options: NativeAuth.Options(transport: Self.answering("[]").transport())
      )
    }

    #expect(error?.message.contains("not an object") == true)
  }
}
