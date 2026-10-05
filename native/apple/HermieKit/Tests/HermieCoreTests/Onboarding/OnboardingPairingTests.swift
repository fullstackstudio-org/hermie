import Foundation
import HermieGateway
import Testing

@testable import HermieCore

/// Setup taking a gateway that was offered by a QR code or a link (NX-14): the address and name are
/// filled in, and sign-in follows the probe. Nothing is added by taking it.
@MainActor
@Suite("Onboarding with a pairing offer")
struct OnboardingPairingTests {
  private let offer = GatewayPairingOffer(address: "https://gw.example.test", name: "Home lab", authHint: .nativePKCE)

  private func setUp(_ answers: [String: Result<OnboardingProbe, GatewayError>]) throws -> (OnboardingHarness, ProbeStub) {
    let stub = ProbeStub(answers)

    return (try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve), stub)
  }

  @Test("the address and the name are filled in, the gateway is probed and sign-in follows by itself")
  func goesStraightToSignIn() async throws {
    let (harness, stub) = try setUp(["https://gw.example.test": ProbeStub.ungated("https://gw.example.test")])
    let model = harness.model()

    model.applyPairing(offer)
    #expect(model.address == "https://gw.example.test")
    #expect(model.name == "Home lab")
    #expect(model.pairedOffer == offer)

    await eventually { model.path == [.signIn] }
    #expect(model.baseURL == "https://gw.example.test")
    #expect(stub.calls.map(\.raw) == ["https://gw.example.test"], "probed once, with nothing but the address")
    #expect(stub.calls.allSatisfy { $0.custom.isEmpty && $0.frontDoor == .none }, "no header or credential came with it")
    #expect(model.signIn == .idle, "taking an offer is not signing in")
    #expect(try await harness.registry().gateways.isEmpty, "and nothing was stored")
  }

  /// A setup somebody filled in for another gateway: an address, the Cloudflare Access pair, custom headers and a
  /// session token.
  private func filledIn(_ model: OnboardingModel) {
    model.address = "https://old.example.test"
    model.advancedShown = true
    model.frontDoorKind = .cloudflareAccess
    model.accessClientID = "client-id-for-old"
    model.accessClientSecret = "secret-for-old"
    model.addHeader()
    model.headers[0].name = "X-Old-Gateway-Key"
    model.headers[0].value = "key-for-old"
    model.sessionToken = "token-for-old"
  }

  @Test("an offer taken over a setup that already holds headers, an Access pair and a token sends none of them")
  func nothingEnteredBeforeTravels() async throws {
    let stub = ProbeStub([
      "https://old.example.test": ProbeStub.ungated("https://old.example.test"),
      "https://gw.example.test": ProbeStub.ungated("https://gw.example.test")
    ])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    filledIn(model)
    await eventually { model.resolved != nil }

    let before = stub.calls.count

    model.applyPairing(offer)
    #expect(model.headers.isEmpty)
    #expect(model.frontDoorKind == .custom)
    #expect(model.accessClientID.isEmpty && model.accessClientSecret.isEmpty)
    #expect(model.sessionToken.isEmpty)
    #expect(model.customHeaders.isEmpty && model.wireHeaders.isEmpty)
    #expect(!model.advancedShown)

    await eventually { model.path == [.signIn] }

    let after = stub.calls.dropFirst(before)

    #expect(!after.isEmpty && after.allSatisfy { $0.raw == "https://gw.example.test" }, "only the offered address is probed")
    #expect(after.allSatisfy { $0.custom.isEmpty && $0.frontDoor == .none }, "with no header and no Access pair")
    #expect(model.sessionToken.isEmpty)
  }

  @Test("an offer ends a sign-in that was half done for the old address")
  func signInDiscarded() async throws {
    let stub = ProbeStub(["https://old.example.test": ProbeStub.ungated("https://old.example.test")])
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: stub.resolve)
    let model = harness.model()

    model.address = "https://old.example.test"
    await eventually { model.resolved != nil }
    model.continueFromAddress()
    #expect(model.path == [.signIn])

    model.applyPairing(offer)
    #expect(model.path.isEmpty, "back on the address step")
    #expect(model.signIn == .idle && model.identity == nil)
    #expect(model.address == "https://gw.example.test")
  }

  @Test("a name typed for the old gateway is not kept, and the offer's own name is")
  func oldNameDiscarded() throws {
    let harness = try OnboardingHarness(transport: HTTPTransport(), resolve: ProbeStub([:]).resolve)
    let model = harness.model()

    model.name = "Old name"
    model.applyPairing(GatewayPairingOffer(address: "https://gw.example.test"))
    #expect(model.name.isEmpty)
  }

  @Test("the offer is only a hurry: a gateway that does not answer leaves the person on the address step")
  func failureStays() async throws {
    let (harness, _) = try setUp([
      "https://gw.example.test": .failure(GatewayError(.network, "no answer"))
    ])
    let model = harness.model()

    model.applyPairing(offer)
    await eventually {
      if case .failed = model.probe { true } else { false }
    }
    #expect(model.path.isEmpty)
    #expect(model.address == "https://gw.example.test")
    #expect(!model.canLeaveAddress)
  }

  @Test("the same offer is taken once, and typing another address takes the hurry away")
  func editedAddress() async throws {
    let (harness, _) = try setUp([
      "https://gw.example.test": ProbeStub.ungated("https://gw.example.test"),
      "https://other.example.test": ProbeStub.ungated("https://other.example.test")
    ])
    let model = harness.model()

    model.applyPairing(offer)
    // Typed over before the probe answered: the person is in charge of the field again.
    model.address = "https://other.example.test"
    await eventually { model.baseURL == "https://other.example.test" }
    try await Task.sleep(for: .milliseconds(30))
    #expect(model.path.isEmpty, "no jump to sign-in for an address the person typed")

    // Applying the same offer again does nothing.
    model.applyPairing(offer)
    #expect(model.address == "https://other.example.test")
  }

  @Test("a name that came with the offer is kept for the name step, and none leaves it empty")
  func names() throws {
    let (harness, _) = try setUp([:])
    let named = harness.model()
    let unnamed = harness.model()

    named.applyPairing(offer)
    unnamed.applyPairing(GatewayPairingOffer(address: "https://gw.example.test"))
    #expect(named.name == "Home lab")
    #expect(unnamed.name.isEmpty)
    #expect(unnamed.defaultName == "gw.example.test")
  }

  @Test("signing in again to a gateway the device has takes no offer")
  func resumeIgnoresOffer() throws {
    let (harness, _) = try setUp([:])
    let model = harness.model(.signIn(gatewayId: "g0"))

    model.applyPairing(offer)
    #expect(model.pairedOffer == nil)
    #expect(model.address.isEmpty)
  }
}
