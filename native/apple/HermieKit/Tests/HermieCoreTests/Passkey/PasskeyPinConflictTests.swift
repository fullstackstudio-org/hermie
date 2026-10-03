import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/// The pins against frames: what other sessions pinned, credential ids of other gateways, and a
/// gateway removed and added again.
@MainActor
@Suite struct PasskeyPinConflictTests {
  typealias T = PasskeyModelTests

  @Test("an allow list that shares no id with the credentials seen here is refused no_credential")
  func allowListOutsideKnown() async throws {
    let known = PasskeyPinRecord(knownCredentialIDs: ["a-known-one"], appCredentialIDs: ["a-known-one"], seenAt: 1)
    let f = await T.fixture(pins: ["gw-1": known])
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id]))

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declineData("srq-1") == ["reason": "no_credential"])
  }

  @Test("credential ids pinned for another gateway are never offered to this one")
  func allowListOfAnotherGateway() async throws {
    let phone = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
    let other = PasskeyPinRecord(
      gatewayID: Base64URL.encode(Array(repeating: 0xEE, count: 16)),
      knownCredentialIDs: [phone.id],
      appCredentialIDs: [phone.id],
      seenAt: 1
    )
    let f = await T.fixture(pins: ["gw-other": other], authenticator: phone)
    try await PasskeyModelTests().raise(f, T.params(ids: [phone.id]))

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declineData("srq-1") == ["reason": "no_credential"])
  }

  @Test("a gateway_id another session pinned after this model started is still a conflict")
  func foreignPinnedLater() async throws {
    let f = await T.fixture()
    await f.pins.save(PasskeyPinRecord(gatewayID: Base64URL.encode(T.gatewayID), seenAt: 1), for: "gw-other")
    try await PasskeyModelTests().raise(f)

    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declineData("srq-1") == ["reason": "gateway_id_conflict"])
  }

  @Test("a gateway removed and added again under another id is not a conflict with itself")
  func removedThenAddedAgain() async throws {
    let database = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: database)
    let pins = KeyValuePasskeyPins(store: KeyValueStore(store: database))
    let address = T.address

    try await registry.add(GatewayRecord(id: "g0a", name: "Home", address: address, authKind: .nativePKCE, addedAt: 1))
    await pins.save(PasskeyPinRecord(gatewayID: Base64URL.encode(T.gatewayID), seenAt: 1), for: "g0a")
    try await registry.remove(id: "g0a")
    try await registry.add(GatewayRecord(id: "g0b", name: "Home", address: address, authKind: .nativePKCE, addedAt: 2))

    let f = await T.fixture(storedID: "g0b", store: pins)
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await PasskeyModelTests().raise(f)

    #expect(f.link.declines.isEmpty)
    #expect(f.model.confirmation("srq-1")?.phase == .waiting)
  }

  @Test("one gateway stored twice asks 'same gateway as <name>', and linking the pins lets it confirm")
  func sameGatewayStoredTwice() async throws {
    let phone = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
    let shared = Base64URL.encode(T.gatewayID)
    let lan = PasskeyPinRecord(gatewayID: shared, knownCredentialIDs: [phone.id], appCredentialIDs: [phone.id], seenAt: 1)
    let store = InMemoryPasskeyPins(["gw-lan": lan], names: ["gw-lan": "Home (LAN)"])
    let f = await T.fixture(store: store, authenticator: phone)
    try await PasskeyModelTests().raise(f, T.params(ids: [phone.id]))

    // Not an impersonation finding but a question; until the person answers it, nothing is signed.
    #expect(f.model.confirmation("srq-1") == nil)
    #expect(f.link.declineData("srq-1") == ["reason": "gateway_id_conflict"])
    #expect(f.model.notices.map(\.kind) == [.sameGatewayAs(storedGatewayID: "gw-lan", name: "Home (LAN)")])

    #expect(await f.model.linkPins(with: "gw-lan"))
    #expect(f.model.notices.isEmpty, "answered")

    let linked = await store.record(for: "gw-1")
    #expect(linked.gatewayID == shared)
    #expect(linked.appCredentialIDs == [phone.id], "the credential ids are shared")
    #expect(linked.linkedGatewayIDs == ["gw-lan"])
    #expect(f.source.policy.passkey?.hasCredential == true)
    #expect(f.source.policy.passkey?.foreignGatewayIDs.isEmpty == true)
    #expect(await store.record(for: "gw-lan") == lan, "the other gateway's record is not written")

    f.link.raise(id: "srq-2", method: "confirm", params: T.params(ids: [phone.id]))
    try await eventually("the second confirmation") { @MainActor in f.model.confirmation("srq-2") != nil }
    #expect(f.model.confirmation("srq-2")?.phase == .waiting)
    #expect(f.link.declineData("srq-2") == nil)
  }

  @Test("a gateway_id pinned for no stored gateway stays a refusal, and cannot be linked")
  func conflictWithUnstoredPin() async throws {
    let orphan = PasskeyPinRecord(gatewayID: Base64URL.encode(T.gatewayID), seenAt: 1)
    let f = await T.fixture(pins: ["g-gone": orphan])
    try await PasskeyModelTests().raise(f)

    #expect(f.link.declineData("srq-1") == ["reason": "gateway_id_conflict"])
    #expect(f.model.notices.map(\.kind) == [.gatewayIDConflict])
    #expect(await f.model.linkPins(with: "g-gone") == false)
    #expect(await f.pins.record(for: "gw-1") == PasskeyPinRecord())
  }

  @Test("a pin record that cannot be read is reported, never written over, and refuses passkey frames")
  func unreadableOwnPin() async throws {
    let database = try SQLiteStore(.inMemory)
    let values = KeyValueStore(store: database)
    let key = KeyValuePasskeyPins.key(for: "g0a")
    try await values.setString("{not a record", forKey: key)

    let f = await T.fixture(storedID: "g0a", store: KeyValuePasskeyPins(store: values))
    #expect(f.model.notices.map(\.kind) == [.pinUnreadable(storedGatewayID: "g0a")])

    try await PasskeyModelTests().raise(f)
    #expect(f.link.declineData("srq-1") == ["reason": "pin_unreadable"])

    await f.model.savePin()
    #expect(try await values.string(forKey: key) == "{not a record")
  }
}
