import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// An authenticator that dismisses or signs as a script says, one entry per assertion (`true`:
/// dismissed), then signs.
final class ScriptedAssertAuthenticator: PasskeyAuthenticator {
  let base: SoftPasskeyAuthenticator
  private let script: Mutex<[Bool]>

  init(_ base: SoftPasskeyAuthenticator, dismissals: [Bool]) {
    self.base = base
    script = Mutex(dismissals)
  }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    try await base.register(request)
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    let dismissed = script.withLock { $0.isEmpty ? false : $0.removeFirst() }

    if dismissed {
      throw .cancelled
    }

    return try await base.assert(request)
  }

  func cancel() async {}
}

/// A system sheet that is up until `cancel()` takes it away, and then ends as cancelled.
final class SheetEndedByCancel: PasskeyAuthenticator {
  private struct State {
    var up = false
    var ceremony: CheckedContinuation<Void, Never>?
  }

  private let state = Mutex(State())

  var up: Bool { state.withLock { $0.up } }

  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    throw .unavailable(reason: "not_in_this_test")
  }

  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    await withCheckedContinuation { continuation in
      state.withLock {
        $0.up = true
        $0.ceremony = continuation
      }
    }

    throw .cancelled
  }

  func cancel() async {
    state.withLock { $0.ceremony.take() }?.resume()
  }
}

/// The system answers "no passkey on this device" and a person's Cancel with the same cancellation, so
/// the model tells them apart by what this device knows: it holds none of the request's passkeys (never
/// made one here, never signed with one here) or it does.
@MainActor
@Suite("A dismissed passkey sheet on a device without the passkey")
struct PasskeyMissingHereTests {
  static let rpID = "confirm.hermie.dev"
  static let address = "https://gw.example.com"

  struct Fixture {
    let link: ScriptedLink
    let model: PasskeyModel
    let pins: InMemoryPasskeyPins
  }

  static func fixture(authenticator: any PasskeyAuthenticator, pin: PasskeyPinRecord? = nil) async -> Fixture {
    let link = ScriptedLink()
    let pins = InMemoryPasskeyPins(pin.map { ["gw-1": $0] } ?? [:])
    let model = PasskeyModel(
      storedGatewayID: "gw-1",
      address: address,
      link: link,
      client: nil,
      authenticator: authenticator,
      configuration: PasskeyConfiguration(rpID: rpID),
      pins: pins,
      source: nil,
      now: { 1_790_000_000 }
    )

    await model.start()
    return Fixture(link: link, model: model, pins: pins)
  }

  func raise(_ f: Fixture, id: String = "srq-1", ids: [String]) async throws {
    f.link.raise(id: id, method: "confirm", params: PasskeyModelTests.params(ids: ids))
    try await eventually("the confirmation") { @MainActor in f.model.confirmation(id) != nil }
  }

  // MARK: - Confirm

  @Test("dismissed on a device that holds none of the passkeys: kept open, explained, nothing sent")
  func explained() async throws {
    let f = await Self.fixture(authenticator: FailingAuthenticator(error: .cancelled))
    try await raise(f, ids: ["AQID"])
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false, "nothing is said before a try")

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.phase == .waiting, "still open: Confirm and Decline stay")
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == true)
    #expect(f.model.confirmation("srq-1")?.isOpen == true)
    #expect(f.link.calls("request.answer").isEmpty)
    #expect(f.link.declines.isEmpty, "the gateway keeps waiting: this is no 4040")
  }

  @Test("dismissed on a device that has signed with one of them: a plain dismissal")
  func plainDismissal() async throws {
    let held = PasskeyPinRecord(
      knownCredentialIDs: ["AQID"], appCredentialIDs: ["AQID"], deviceCredentialIDs: ["AQID"], seenAt: 1)
    let f = await Self.fixture(authenticator: FailingAuthenticator(error: .cancelled), pin: held)
    try await raise(f, ids: ["AQID", "BAUG"])

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.phase == .waiting)
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false)
  }

  @Test("a passkey this device holds for another credential id of the account does not count for this request")
  func otherCredentialHeld() async throws {
    let held = PasskeyPinRecord(
      knownCredentialIDs: ["AQID", "BAUG"], appCredentialIDs: ["AQID", "BAUG"], deviceCredentialIDs: ["BAUG"], seenAt: 1)
    let f = await Self.fixture(authenticator: FailingAuthenticator(error: .cancelled), pin: held)
    // The frame lists only the passkey this device does not hold.
    try await raise(f, ids: ["AQID"])

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == true)
  }

  @Test(
    "only a dismissal reads as a missing passkey: a busy or failed ceremony does not",
    arguments: [PasskeyCeremonyError.busy, .failed("boom")]
  )
  func otherErrors(_ error: PasskeyCeremonyError) async throws {
    let f = await Self.fixture(authenticator: FailingAuthenticator(error: error))
    try await raise(f, ids: ["AQID"])

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false)
  }

  @Test("a ceremony that cannot run keeps its 4040 and no explanation")
  func unavailableStaysUnavailable() async throws {
    let f = await Self.fixture(authenticator: FailingAuthenticator(error: .unavailable(reason: "not_interactive")))
    try await raise(f, ids: ["AQID"])

    await f.model.confirm("srq-1")

    #expect(f.model.confirmation("srq-1")?.phase == .ended(.unavailable(reason: "not_interactive")))
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false)
    #expect(f.link.declines.first?.code == 4040)
  }

  @Test("the next try clears it; signing remembers the passkey, so a later dismissal is plain")
  func clearedAndRemembered() async throws {
    let phone = SoftPasskeyAuthenticator(userHandle: Array(repeating: 9, count: 32))
    // Dismissed, signs, dismissed.
    let f = await Self.fixture(authenticator: ScriptedAssertAuthenticator(phone, dismissals: [true, false, true]))
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await raise(f, ids: [phone.id])

    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == true)
    #expect(f.model.pin.deviceCredentialIDs.isEmpty, "a dismissal teaches nothing")

    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .received)
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false, "the next try cleared it")
    #expect(try #require(await f.pins.records()["gw-1"]).deviceCredentialIDs == [phone.id], "this device signed with it")

    try await raise(f, id: "srq-2", ids: [phone.id])
    await f.model.confirm("srq-2")

    #expect(f.model.confirmation("srq-2")?.phase == .waiting)
    #expect(f.model.confirmation("srq-2")?.passkeyMissingHere == false, "a device that holds it: Cancel is Cancel")
  }

  @Test("the gateway withdrawing the request while the sheet is up is no missing passkey")
  func withdrawnWhileSigning() async throws {
    let sheet = SheetEndedByCancel()
    let f = await Self.fixture(authenticator: sheet)
    try await raise(f, ids: ["AQID"])

    let signing = Task { await f.model.confirm("srq-1") }
    try await eventually("the sheet") { sheet.up }

    // `cancel()` takes the sheet away and the ceremony returns as cancelled, as the system's does.
    f.link.emit("request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": "timeout"])
    await signing.value

    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
    #expect(f.model.confirmation("srq-1")?.passkeyMissingHere == false)
  }

  // MARK: - What the device remembers

  @Test("a pin written before the field existed reads back without it, and the field survives a round trip")
  func pinRecordCoding() throws {
    let old = #"{"gateway_id":"g","known_credential_ids":["a"],"app_credential_ids":["a"],"seen_at":1}"#
    let decoded = try JSONDecoder().decode(PasskeyPinRecord.self, from: Data(old.utf8))
    #expect(decoded.deviceCredentialIDs.isEmpty)

    var held = decoded
    held.deviceCredentialIDs = ["a"]
    let again = try JSONDecoder().decode(PasskeyPinRecord.self, from: JSONEncoder().encode(held))
    #expect(again == held)
  }

  @Test("the error mapping: dismissal is cancelled, and what only a missing passkey may mean is left to the model")
  func holdsNone() async {
    let f = await Self.fixture(
      authenticator: FailingAuthenticator(error: .cancelled),
      pin: PasskeyPinRecord(deviceCredentialIDs: ["AQID"], seenAt: 1))

    #expect(f.model.holdsNoneHere([[1, 2, 3]]) == false)
    #expect(f.model.holdsNoneHere([[1, 2, 3], [4, 5, 6]]) == false, "one held is enough")
    #expect(f.model.holdsNoneHere([[4, 5, 6]]) == true)
    #expect(f.model.holdsNoneHere([]) == true)
  }
}

/// Step-ups (an invite, a revoke) sign with a passkey of this device too: the same reading.
@MainActor
@Suite("A dismissed passkey sheet on a step-up")
struct PasskeyStepUpMissingHereTests {
  static func stepUpGateway(_ f: PasskeySelfEnrolmentTests.Fixture, allowing id: String) {
    let nonce = Base64URL.encode(Array(repeating: 7, count: 32))
    let body = SelfEnrolWire.text(
      [
        "stepup_id": "su-1",
        "purpose": "invite",
        "subject": "invite",
        "nonce": .string(nonce),
        "credentials": [["rp_id": "confirm.hermie.dev", "ids": [.string(id)]]]
      ])

    f.gateway.answer("/api/auth/passkeys/stepup/begin", .json(body))
  }

  @Test("dismissed on a device that holds none of the passkeys: said as such, not as a plain dismissal")
  func explained() async throws {
    let f = try PasskeySelfEnrolmentTests.fixture(authenticator: { _ in FailingAuthenticator(error: .cancelled) })
    Self.stepUpGateway(f, allowing: f.phone.id)

    await #expect(throws: PasskeyActionError.noPasskeyHere) { try await f.model.mintInvite() }
  }

  @Test("dismissed on a device that has signed with it: a plain dismissal")
  func plain() async throws {
    let f = try PasskeySelfEnrolmentTests.fixture(authenticator: { _ in FailingAuthenticator(error: .cancelled) })
    Self.stepUpGateway(f, allowing: f.phone.id)
    f.model.pin.deviceCredentialIDs = [f.phone.id]

    await #expect(throws: PasskeyActionError.ceremony(.cancelled)) { try await f.model.mintInvite() }
  }

  @Test("signing a step-up remembers the passkey")
  func remembered() async throws {
    let f = try PasskeySelfEnrolmentTests.fixture()
    Self.stepUpGateway(f, allowing: f.phone.id)
    f.gateway.answer("/api/auth/passkeys/invites", .json(#"{"code":"ABCDEFGHJKLMNPQRSTUV"}"#))

    _ = try await f.model.mintInvite()

    #expect(f.model.pin.deviceCredentialIDs == [f.phone.id])
    #expect(try #require(await f.pins.records()["gw-1"]).deviceCredentialIDs == [f.phone.id])
  }

  @Test("a passkey made here is remembered as held here, and one that left the list is forgotten")
  func madeHereAndPruned() async throws {
    let f = try PasskeySelfEnrolmentTests.fixture()
    let listed = SelfEnrolWire.text(SelfEnrolWire.example("status_self_enrol"))
      .replacingOccurrences(of: "zAmx9u3edJzfBdWGJPSMEd7IEddgqfUqIzMXlFj1KoE", with: f.phone.id)
    f.gateway.answer("/api/auth/passkeys", .json(listed))

    let ready = try await f.model.beginSelfEnrolment(presenter: PasskeySelfEnrolmentTests.presenter)
    _ = try await f.model.enrol(grantID: ready.grantID)

    #expect(f.model.pin.deviceCredentialIDs == [f.phone.id], "made here, and still listed after the refresh")

    f.model.pin.deviceCredentialIDs.append("revoked-elsewhere")
    await f.model.refresh()

    #expect(f.model.pin.deviceCredentialIDs == [f.phone.id], "a revoked passkey is no longer held")
  }
}
