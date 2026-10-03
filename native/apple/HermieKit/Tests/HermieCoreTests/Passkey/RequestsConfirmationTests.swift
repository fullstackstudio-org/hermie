import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A passkey confirmation in the chat's request area: which chat shows it, when its sheet comes up,
/// and what closes it.
@MainActor
@Suite struct RequestsConfirmationTests {
  typealias T = PasskeyModelTests

  private static let bot = "researcher"

  /// A requests model of `bot`'s chat over the passkey model of `f`, routing session `sess-1` to
  /// `owner`.
  private func requests(_ f: T.Fixture, owner: String = bot, bot: String = bot) -> RequestsModel {
    let harness = SessionHarness()

    return RequestsModel(
      chat: harness.session.chat(bot),
      passkeys: f.model,
      gatewayName: "Home",
      confirmRoute: { session in session == "sess-1" ? owner : nil }
    )
  }

  @Test("a confirmation belongs to the chat that holds its session, and to no other")
  func routing() async throws {
    let f = await T.fixture()
    let mine = requests(f)
    let other = requests(f, owner: Self.bot, bot: "writer")
    try await PasskeyModelTests().raise(f)

    #expect(mine.confirmations.isEmpty, "not claimed until the store is asked")
    #expect(mine.unroutedConfirmationIDs == ["srq-1"])

    #expect(await mine.routeConfirmations())
    #expect(await other.routeConfirmations())
    #expect(mine.confirmations.map(\.id) == ["srq-1"])
    #expect(other.confirmations.isEmpty)
    #expect(mine.nextToPresent == "srq-1")
    #expect(other.nextToPresent == nil)
  }

  @Test("a confirmation whose session no chat holds yet is asked about again, not shown")
  func unbound() async throws {
    let f = await T.fixture()
    let harness = SessionHarness()
    let held = Held()
    let model = RequestsModel(
      chat: harness.session.chat(Self.bot),
      passkeys: f.model,
      gatewayName: "Home",
      confirmRoute: { _ in held.key }
    )
    try await PasskeyModelTests().raise(f)

    #expect(await model.routeConfirmations() == false)
    #expect(model.nextToPresent == nil)

    held.key = Self.bot
    #expect(await model.routeConfirmations())
    #expect(model.nextToPresent == "srq-1")
  }

  @Test("an open confirmation cannot be put away; once it is over, Close does, and it does not come back")
  func dismissing() async throws {
    let f = await T.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    let model = requests(f)
    try await PasskeyModelTests().raise(f)
    await model.routeConfirmations()

    model.present("srq-1")
    #expect(model.presentedConfirmation?.id == "srq-1")

    model.dismissSheet()
    #expect(model.presentedRequestID == "srq-1", "Esc and a swipe never close an open confirmation")

    await f.model.decline("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .declined)

    model.dismissSheet()
    #expect(model.presentedRequestID == nil)
    #expect(model.nextToPresent == nil, "over: nothing to raise again")
  }

  @Test("a verification the gateway could not commit raises the sheet again after it closed")
  func verificationFailedComesBack() async throws {
    let f = await T.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    let model = requests(f)
    try await PasskeyModelTests().raise(f)
    await model.routeConfirmations()
    model.present("srq-1")

    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .received)
    model.dismissSheet()
    #expect(model.presentedRequestID == nil)
    #expect(model.nextToPresent == nil)

    f.link.emit(
      "request.cancel", session: "sess-1",
      payload: ["id": "srq-1", "method": "confirm", "reason": "verification_failed"]
    )
    try await eventually("verification failed") { @MainActor in
      f.model.confirmation("srq-1")?.phase == .ended(.verificationFailed)
    }

    #expect(model.nextToPresent == "srq-1", "the person must hear that it did NOT go through")
    model.present("srq-1")
    model.dismissSheet()
    #expect(model.presentedRequestID == nil)
    #expect(model.nextToPresent == nil, "heard once, closed")
  }

  @Test("a request that timed out before it was ever shown is not raised")
  func expiredNeverShown() async throws {
    let f = await T.fixture()
    let model = requests(f)
    try await PasskeyModelTests().raise(f)
    await model.routeConfirmations()

    f.link.emit("request.cancel", session: "sess-1", payload: ["id": "srq-1", "method": "confirm", "reason": "timeout"])
    try await eventually("timed out") { @MainActor in f.model.confirmation("srq-1")?.phase == .ended(.timedOut) }

    #expect(model.nextToPresent == nil)
  }

  @Test("the countdown ending ends it locally as timed out")
  func expireIfDue() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id], expiresAt: 1_789_999_999))

    await f.model.expireIfDue("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .ended(.timedOut))
  }

  @Test("the frame keeps the session and the arrival time")
  func frame() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f)

    let shown = try #require(f.model.confirmation("srq-1"))
    #expect(shown.sessionID == "sess-1")
    #expect(shown.receivedAt == Date(timeIntervalSince1970: 1_790_000_000))
  }

  /// A key a test changes between two asks.
  private final class Held: Sendable {
    private let value = Mutex<String?>(nil)

    var key: String? {
      get { value.withLock { $0 } }
      set { value.withLock { $0 = newValue } }
    }
  }
}
