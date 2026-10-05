import Foundation
import Testing

@testable import HermieShared

/// `hermie://add-gateway?url=…&name=…&auth=…`: the pairing offer a gateway's QR code holds (NX-14).
/// Any app and any web page can send one, so the parser keeps only an address, a cleaned name and a
/// known sign-in kind, and drops everything else.
@Suite("Add-gateway links")
struct DeepLinkAddGatewayTests {
  private func link(_ query: String) -> String { "hermie://add-gateway?\(query)" }

  // MARK: Encode and decode

  @Test("a link built from an address, a name and a kind reads back as it was")
  func roundTrip() throws {
    let built = DeepLink.addGateway(url: "https://hermes.example.com:8443/prefix", name: "Work & play", auth: "native_pkce")
    let text = try #require(built.string)

    #expect(DeepLink(text) == built)
    #expect(DeepLink(url: try #require(built.url)) == built)
  }

  @Test("the built link holds exactly the address, the name and the kind, escaped")
  func shape() throws {
    let text = try #require(
      DeepLink.addGateway(url: "https://hermes.example.com", name: "Mijn gateway", auth: "session_token").string)

    #expect(text == "hermie://add-gateway?url=https%3A%2F%2Fhermes.example.com&name=Mijn%20gateway&auth=session_token")
  }

  @Test("an empty name and an unknown kind are left out of the link")
  func optionalParts() throws {
    let text = try #require(DeepLink.addGateway(url: "https://hermes.example.com", name: "", auth: "magic").string)

    #expect(text == "hermie://add-gateway?url=https%3A%2F%2Fhermes.example.com")
    #expect(DeepLink(text) == .addGateway(url: "https://hermes.example.com", name: "", auth: ""))
  }

  @Test("a name with punctuation of the link's own cannot add parameters")
  func nameCannotInjectParameters() throws {
    let text = try #require(
      DeepLink.addGateway(url: "https://a.example", name: "x&auth=cookie&token=abc#frag", auth: "").string)

    #expect(DeepLink(text) == .addGateway(url: "https://a.example", name: "x&auth=cookie&token=abc#frag", auth: ""))
    #expect(!text.contains("&token"), "everything of the name is escaped")
  }

  @Test("the dev client scheme and a slash before the query are tolerated")
  func variants() {
    let expected = DeepLink.addGateway(url: "https://a.example", name: "", auth: "")

    #expect(DeepLink("exp+hermie://add-gateway?url=https%3A%2F%2Fa.example") == expected)
    #expect(DeepLink("hermie://add-gateway/?url=https%3A%2F%2Fa.example") == expected)
    #expect(DeepLink("hermie://add-gateway?url=https%3A%2F%2Fa.example#top") == expected)
  }

  // MARK: Dropped

  @Test("parameters other than the three are dropped, whatever they say")
  func extrasDropped() {
    let parsed = DeepLink(
      link(
        "url=https%3A%2F%2Fa.example&token=secret&password=hunter2&header=Authorization%3A%20Bearer%20x&secret=1&gateway=0123456789abcdef"
      ))

    #expect(parsed == .addGateway(url: "https://a.example", name: "", auth: ""))
  }

  @Test("a link never carries a credential that survives parsing")
  func noCredentialSurvives() throws {
    let parsed = try #require(
      DeepLink(link("auth=cookie&url=https%3A%2F%2Fa.example&name=Home&bearer=abc&access_token=abc&client_secret=abc")))
    let rebuilt = try #require(parsed.string)

    for word in ["bearer", "access_token", "client_secret", "token", "secret", "password"] {
      #expect(!rebuilt.lowercased().contains(word), "\(word)")
    }

    #expect(parsed == .addGateway(url: "https://a.example", name: "Home", auth: "cookie"))
  }

  @Test("the first of a repeated parameter wins")
  func firstWins() {
    #expect(
      DeepLink(link("url=https%3A%2F%2Fa.example&url=https%3A%2F%2Fevil.example"))
        == .addGateway(url: "https://a.example", name: "", auth: ""))
  }

  @Test("an unknown sign-in kind is dropped, a known one kept", arguments: [
    ("native_pkce", "native_pkce"), ("session_token", "session_token"), ("cookie", "cookie"),
    ("password", ""), ("NATIVE_PKCE", ""), ("", "")
  ])
  func authKinds(kind: String, kept: String) {
    #expect(DeepLink(link("url=https%3A%2F%2Fa.example&auth=\(kind)")) == .addGateway(url: "https://a.example", name: "", auth: kept))
  }

  @Test("a name is cleaned: control and invisible characters go, white space is one space, the length is capped")
  func nameCleaned() {
    #expect(
      DeepLink(link("url=https%3A%2F%2Fa.example&name=%20%20Home%0A%09%20lab%20%20"))
        == .addGateway(url: "https://a.example", name: "Home lab", auth: ""))
    // A right-to-left override and a zero-width space are format characters: dropped.
    #expect(
      DeepLink(link("url=https%3A%2F%2Fa.example&name=ab%E2%80%AEcd%E2%80%8Bef"))
        == .addGateway(url: "https://a.example", name: "abcdef", auth: ""))

    let long = String(repeating: "x", count: 200)
    let parsed = DeepLink(link("url=https%3A%2F%2Fa.example&name=\(long)"))

    #expect(parsed == .addGateway(url: "https://a.example", name: String(repeating: "x", count: DeepLink.maxNameLength), auth: ""))
  }

  @Test("a name that is not valid percent-encoding is dropped, the address kept")
  func badNameEscape() {
    #expect(
      DeepLink(link("url=https%3A%2F%2Fa.example&name=%E0%A4%A")) == .addGateway(url: "https://a.example", name: "", auth: ""))
  }

  // MARK: Refused

  @Test(
    "refuses an offer whose address is not an address this link may carry",
    arguments: [
      ("no url", "name=Home"),
      ("an empty url", "url="),
      ("another scheme", "url=ftp%3A%2F%2Fa.example"),
      ("a javascript url", "url=javascript%3Aalert(1)"),
      ("a file url", "url=file%3A%2F%2F%2Fetc%2Fpasswd"),
      ("no scheme", "url=a.example"),
      ("no host", "url=https%3A%2F%2F"),
      ("a port and no host", "url=https%3A%2F%2F%3A8080"),
      ("a user name and password", "url=https%3A%2F%2Fuser%3Apass%40a.example"),
      ("a user name only", "url=https%3A%2F%2Fuser%40a.example"),
      ("a query", "url=https%3A%2F%2Fa.example%2F%3Ftoken%3Dabc"),
      ("a fragment", "url=https%3A%2F%2Fa.example%2F%23token"),
      ("a space", "url=https%3A%2F%2Fa.example%20evil"),
      ("a line break", "url=https%3A%2F%2Fa.example%0A"),
      ("a backslash", "url=https%3A%2F%2Fa.example%5C%40evil.example"),
      ("a malformed escape", "url=https%3A%2F%2Fa.example%E0%A4%A")
    ] as [(String, String)]
  )
  func refusals(label: String, query: String) {
    #expect(DeepLink(link(query)) == nil, "\(label)")
  }

  @Test("refuses an address longer than the cap")
  func tooLong() {
    let address = "https://a.example/" + String(repeating: "p", count: DeepLink.maxAddressLength)

    #expect(DeepLink(link("url=\(address)")) == nil)
  }

  @Test(
    "refuses shapes that are not exactly add-gateway and a query",
    arguments: [
      "hermie://add-gateway",
      "hermie://add-gateway/",
      "hermie://add-gateway/x?url=https%3A%2F%2Fa.example",
      "hermie://add-gatewayx?url=https%3A%2F%2Fa.example",
      "hermie://add-gateway?url=https%3A%2F%2Fa.example#a\nb",
      "hermie://Add-Gateway?url=https%3A%2F%2Fa.example",
      "hermie-evil://add-gateway?url=https%3A%2F%2Fa.example"
    ]
  )
  func shapes(text: String) {
    #expect(DeepLink(text) == nil, "\(text)")
  }

  @Test("an address that is not allowed cannot be written into a link either")
  func buildRefusals() {
    #expect(DeepLink.addGateway(url: "https://u:p@a.example", name: "", auth: "").string == nil)
    #expect(DeepLink.addGateway(url: "ftp://a.example", name: "", auth: "").string == nil)
    #expect(DeepLink.addGateway(url: "", name: "", auth: "").string == nil)
  }

  @Test("the other links are unaffected")
  func othersUnchanged() {
    #expect(DeepLink("hermie://chat/researcher") == .chat(bot: "researcher", gatewayKey: ""))
    #expect(DeepLink("hermie://chat/") == nil)
  }
}
