import Foundation
import HermieGateway
import HermieShared
import Testing

@testable import HermieCore

/// A gateway offered by a QR code or a link (NX-14): the address rule, the cleaning, and what the code
/// can never hold.
@Suite("Gateway pairing offers")
struct GatewayPairingOfferTests {
  private func offer(_ address: String, name: String = "", auth: String = "") throws -> GatewayPairingOffer {
    try GatewayPairingOffer.validate(address: address, name: name, auth: auth).get()
  }

  private func problem(_ address: String) -> GatewayPairingOffer.Problem? {
    if case .failure(let problem) = GatewayPairingOffer.validate(address: address) { problem } else { nil }
  }

  // MARK: The address rule

  @Test("an https address is accepted and taken in its normal form")
  func https() throws {
    let plain = try offer("https://gw.example.test")

    #expect(plain.address == "https://gw.example.test")
    #expect(plain.isSecure)
    #expect(plain.host == "gw.example.test")
    #expect(try offer("HTTPS://GW.Example.Test:443/").address == "https://gw.example.test")
    #expect(try offer("https://gw.example.test:8443/prefix/").address == "https://gw.example.test:8443/prefix")
  }

  @Test(
    "plain http is accepted only for this machine and a .local name",
    arguments: [
      "http://localhost", "http://localhost:9119", "http://127.0.0.1:9119", "http://127.1.2.3", "http://[::1]:9119",
      "http://hermes.local", "http://hermes.local:9119/prefix", "http://my-mac.LOCAL", "http://dev.localhost:3000"
    ]
  )
  func httpAllowed(address: String) throws {
    let accepted = try offer(address)

    #expect(!accepted.isSecure)
    #expect(accepted.address.hasPrefix("http://"))
  }

  @Test(
    "plain http to anything else is refused, not softened",
    arguments: [
      "http://gw.example.test", "http://192.168.1.20:9119", "http://10.0.0.5", "http://100.64.1.2",
      "http://box.ts.net", "http://hermes", "http://box.internal", "http://8.8.8.8", "http://hermes.local.evil.example"
    ]
  )
  func httpRefused(address: String) {
    guard case .notSecure(let host)? = problem(address) else {
      Issue.record("\(address) was not refused as insecure: \(String(describing: problem(address)))")
      return
    }

    #expect(!host.isEmpty)
  }

  @Test(
    "an address that is no address is refused",
    arguments: ["", "   ", "ftp://gw.example.test", "https://", "https://u:p@gw.example.test", "https://gw.example.test/?x=1",
      "https://gw.example.test/#x", "gw.example.test", "javascript:alert(1)", "https://gw example.test"]
  )
  func notAnAddress(address: String) {
    #expect(problem(address) == .notAnAddress)
  }

  @Test("a host spelled as a number is judged by what it is, not by how it is written")
  func numericHosts() {
    // `0x7f.1` is 127.0.0.1 to the URL standard; `0x0a.0.0.5` is 10.0.0.5 and so is not this machine.
    #expect((try? offer("http://0x7f.1")) != nil)
    #expect(problem("http://0x0a.0.0.5") != nil)
  }

  // MARK: Name and sign-in kind

  @Test("the name is cleaned and the sign-in kind is a hint only when it is one this build knows")
  func nameAndAuth() throws {
    let accepted = try offer("https://gw.example.test", name: " \u{202E}Lab\n\t  gateway ", auth: "native_pkce")

    #expect(accepted.name == "Lab gateway")
    #expect(accepted.authHint == .nativePKCE)
    #expect(accepted.displayName == "Lab gateway")
    #expect(try offer("https://gw.example.test", auth: "password").authHint == nil)
    #expect(try offer("https://gw.example.test").displayName == "gw.example.test", "no name: the host leads")
  }

  @Test(
    "a name that reads as another domain than the host is dropped, so the host leads",
    arguments: [
      "bank.example.com", "www.bank.com", "https://bank.example.com", "Login.Example.org", "paypal.com", "my.gateway"
    ]
  )
  func impersonatingName(name: String) throws {
    let accepted = try offer("https://gw.example.test", name: name)

    #expect(accepted.name.isEmpty, "\(name)")
    #expect(accepted.displayName == "gw.example.test")
  }

  @Test("a name that is the host itself, or is not a domain, is kept")
  func honestNames() throws {
    #expect(try offer("https://gw.example.test", name: "GW.example.test").name == "GW.example.test")
    #expect(try offer("https://gw.example.test", name: "Home lab").name == "Home lab")
    #expect(try offer("https://gw.example.test", name: "Work. Mostly").name == "Work. Mostly", "a sentence is not a domain")
    #expect(try offer("https://gw.example.test", name: "v1.2").name == "v1.2", "a number is not a top-level domain")
    #expect(try offer("https://gw.example.test", name: "Mijn gateway").name == "Mijn gateway")
  }

  @Test("an international host is shown as the punycode that will be dialled, so a look-alike cannot pass")
  func internationalHost() throws {
    let accepted = try offer("https://аррӏе.example")

    #expect(accepted.host.hasPrefix("xn--"), "\(accepted.host)")
    #expect(accepted.address.hasPrefix("https://xn--"))
    #expect(try offer("https://bücher.example").host == "xn--bcher-kva.example")
  }

  @Test("a root dot on the host is not a different gateway, and a path is case sensitive")
  func exactMatching() throws {
    let made = try offer("https://gw.example.test:8443/Hermes")

    #expect(made.matches(address: "https://GW.example.test.:8443/Hermes"))
    #expect(made.matches(address: "gw.example.test.:8443/Hermes/"))
    #expect(!made.matches(address: "https://gw.example.test:8443/hermes"), "/Hermes and /hermes are two gateways")
    #expect(try offer("https://gw.example.test.").matches(address: "https://gw.example.test"))
    #expect(try offer("https://gw.example.test").matches(address: "https://gw.example.test."))
  }

  @Test("an IPv4 address written as an IPv6 one is judged by the address inside it, and plain http to a real one is refused")
  func mappedAddresses() {
    #expect(problem("http://[::ffff:8.8.8.8]") != nil)
    #expect(problem("http://[::ffff:808:808]") != nil)
    #expect(problem("http://[::ffff:10.0.0.5]") != nil, "a private address is not this machine")
    #expect(problem("http://[::ffff:192.168.1.5]") != nil)
    // Over https any of them is fine, and they are all the same host to the person: shown as written.
    #expect((try? offer("https://[::ffff:8.8.8.8]")) != nil)
  }

  // MARK: From a link, from a payload

  @Test("only an add-gateway link is an offer")
  func onlyAddGateway() throws {
    for text in [
      "https://gw.example.test", "hermie://chat/researcher", "WIFI:S:home;T:WPA;P:secret;;", "hello", "",
      "hermie://add-gateway", "hermie://share/abc"
    ] {
      #expect(GatewayPairingOffer.offer(fromPayload: text) == .failure(.notAnOffer), "\(text)")
    }

    let text = "  hermie://add-gateway?url=https%3A%2F%2Fgw.example.test&name=Home\n"

    #expect(try GatewayPairingOffer.offer(fromPayload: text).get().displayName == "Home")
  }

  @Test("a link whose address is refused says why, and a link that is not an offer says so")
  func problems() {
    #expect(
      GatewayPairingOffer.offer(fromPayload: "hermie://add-gateway?url=http%3A%2F%2Fgw.example.test")
        == .failure(.notSecure(host: "gw.example.test")))
    #expect(GatewayPairingOffer.offer(from: .chat(bot: "r", gatewayKey: "")) == .failure(.notAnOffer))
  }

  @Test("of several codes in a picture the first usable offer wins, and a refused one is the reason when none is")
  func severalCodes() throws {
    let good = "hermie://add-gateway?url=https%3A%2F%2Fgood.example.test"
    let bad = "hermie://add-gateway?url=https%3A%2F%2F"
    let insecure = "hermie://add-gateway?url=http%3A%2F%2Fgw.example.test"

    #expect(try GatewayPairingOffer.offer(fromPayloads: ["x", insecure, good]).get().host == "good.example.test")
    #expect(GatewayPairingOffer.offer(fromPayloads: ["x", insecure, bad]) == .failure(.notSecure(host: "gw.example.test")))
    #expect(GatewayPairingOffer.offer(fromPayloads: ["x", "y"]) == .failure(.notAnOffer))
    #expect(GatewayPairingOffer.offer(fromPayloads: []) == .failure(.notAnOffer))
  }

  @Test("hostile parameters that come with a valid address are not part of the offer")
  func hostileParameters() throws {
    let accepted = try GatewayPairingOffer.offer(
      fromPayload:
        "hermie://add-gateway?url=https%3A%2F%2Fgw.example.test&name=Home&token=abc&header=X%3A%20y&password=p&auth=cookie&gateway=0123456789abcdef"
    ).get()

    #expect(accepted == GatewayPairingOffer(address: "https://gw.example.test", name: "Home", authHint: .cookie))
    #expect(accepted.linkString == "hermie://add-gateway?url=https%3A%2F%2Fgw.example.test&name=Home&auth=cookie")
  }

  // MARK: Making one

  @Test("the link of an offer holds the address, the name and the kind, and nothing that could be a credential")
  func linkHoldsNoCredential() throws {
    let made = GatewayPairingOffer(address: "https://gw.example.test:8443", name: "Home", authHint: .sessionToken)
    let text = try #require(made.linkString)
    let components = try #require(URLComponents(string: text))

    #expect(components.scheme == "hermie")
    #expect(components.host == "add-gateway")
    #expect(Set(components.queryItems?.map(\.name) ?? []) == ["url", "name", "auth"])
    #expect(try GatewayPairingOffer.offer(fromPayload: text).get() == made)
  }

  @Test("a gateway on plain http over a public address cannot be offered, because the other side would refuse it")
  func sharingRefusals() throws {
    let shared = try GatewayPairingOffer.sharing(address: "https://gw.example.test", name: "", authKind: "native_pkce").get()

    #expect(shared.name.isEmpty && shared.authHint == .nativePKCE)
    #expect(GatewayPairingOffer.sharing(address: "http://gw.example.test", name: "x", authKind: nil) == .failure(.notSecure(host: "gw.example.test")))
    #expect(try GatewayPairingOffer.sharing(address: "http://localhost:9119", name: "", authKind: nil).get().address == "http://localhost:9119")
  }

  @Test("an offer is matched to a gateway already held by its normal address")
  func matching() throws {
    let made = try offer("https://gw.example.test:8443/x")

    #expect(made.matches(address: "https://GW.example.test:8443/x/"))
    #expect(made.matches(address: "gw.example.test:8443/x"))
    #expect(!made.matches(address: "https://gw.example.test:8443"))
    #expect(!made.matches(address: "not an address ::"))
  }
}
