import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The emergency stop over a live session: what it finds running (the gateway's `session.active_list`
/// and the chats the app holds), and how each turn is interrupted (`session.interrupt`, through the
/// chat's own Stop for a chat of the app, by runtime id for another client's).
@MainActor
@Suite("Emergency stop: over a session", .timeLimit(.minutes(1)))
struct SessionStopGatewayTests {
  private static func row(
    id: String, key: String, status: String = "working", title: String = ""
  ) -> JSONValue {
    ["id": .string(id), "session_key": .string(key), "status": .string(status), "title": .string(title)]
  }

  /// A session with the researcher's chat open and a turn streaming in it.
  private func running() async throws -> (harness: SessionHarness, gateway: SessionStopGateway) {
    let harness = SessionHarness()
    try await harness.start()
    try await harness.open()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Working on it"])
    try await harness.frame()

    return (harness, SessionStopGateway(session: harness.session, name: "Home"))
  }

  private func list(_ harness: SessionHarness, _ rows: [JSONValue]) {
    harness.link.respond(to: RPC.SessionActiveList.name, with: ["sessions": .array(rows)])
  }

  @Test("it finds the app's own running chat, another client's session by id, and counts a bare row it cannot act on")
  func readsWhatRuns() async throws {
    let (harness, gateway) = try await running()

    list(
      harness,
      [
        Self.row(id: Fixture.runtime, key: Fixture.stored),
        Self.row(id: "rt-terminal", key: "other-stored", title: "Nightly report"),
        Self.row(id: "rt-idle", key: "idle-stored", status: "idle"),
        Self.row(id: "", key: "someone-elses", status: "streaming")
      ])

    let reading = try #require(await gateway.runningTurns())

    #expect(reading.complete)
    #expect(reading.unreachable == 1, "a busy session this connection may not act on")
    #expect(reading.turns.map(\.id) == [Fixture.runtime, "rt-terminal"])

    let own = reading.turns[0]
    #expect(own.chatKey == Fixture.profile, "stopped through its chat")
    #expect(own.botName == harness.session.chatName(Fixture.profile))

    let other = reading.turns[1]
    #expect(other.chatKey == nil, "stopped by its runtime id")
    #expect(other.title == "Nightly report")
    #expect(other.botName.isEmpty, "the gateway does not say whose it is")

    await harness.session.shutdown()
  }

  @Test("another client's session that belongs to one of the roster's bots is named by that bot")
  func namesAForeignSessionByItsBot() async throws {
    let harness = SessionHarness()
    try await harness.start()
    list(harness, [Self.row(id: "rt-other-client", key: Fixture.stored, title: "ignored")])

    let gateway = SessionStopGateway(session: harness.session, name: "Home")
    let reading = try #require(await gateway.runningTurns())

    #expect(reading.turns.map(\.id) == ["rt-other-client"])
    #expect(reading.turns.first?.chatKey == nil)
    #expect(reading.turns.first?.botName == harness.session.chatName(Fixture.profile))

    await harness.session.shutdown()
  }

  @Test("a chat that thinks it is busy while the gateway says it finished is not stopped")
  func theGatewayIsTheTruth() async throws {
    let (harness, gateway) = try await running()

    list(harness, [Self.row(id: Fixture.runtime, key: Fixture.stored, status: "idle")])

    let reading = try #require(await gateway.runningTurns())
    #expect(reading.turns.isEmpty)
    #expect(reading.unreachable == 0)

    await harness.session.shutdown()
  }

  @Test("when the gateway's list cannot be read, the app's own busy chats are all there is, and it says so")
  func listUnreadable() async throws {
    let (harness, gateway) = try await running()

    harness.link.refuse(RPC.SessionActiveList.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    let reading = try #require(await gateway.runningTurns())
    #expect(!reading.complete)
    #expect(reading.turns.map(\.id) == [Fixture.runtime])
    #expect(reading.turns.first?.chatKey == Fixture.profile)

    await harness.session.shutdown()
  }

  @Test("with the socket down it cannot be asked, and a stop says it is not connected")
  func notConnected() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let gateway = SessionStopGateway(session: harness.session, name: "Home")

    harness.link.status(.disconnected)
    try await eventually("the session to see it") { await harness.session.status.phase != .ready }

    #expect(await gateway.runningTurns() == nil)
    #expect(await gateway.stop(RunningTurn(id: "rt-1", chatKey: Fixture.profile)) == .notConnected)
    #expect(harness.link.calls(RPC.SessionInterrupt.name).isEmpty)

    await harness.session.shutdown()
  }

  @Test("a chat of the app is stopped through its Stop: the runtime id and the profile go out, the partial reply is kept")
  func stopsAChat() async throws {
    let (harness, gateway) = try await running()
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])

    let outcome = await gateway.stop(RunningTurn(id: Fixture.runtime, chatKey: Fixture.profile))
    #expect(outcome == .stopped)

    let call = try #require(harness.link.calls(RPC.SessionInterrupt.name).first)
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    #expect(call.params["profile"] == .string(Fixture.profile))

    try await harness.frame()
    let state = await harness.session.store.state(of: Fixture.profile)
    #expect(state?.turn.active == false)
    #expect(state?.orderedItems.compactMap(\.asAssistant).last?.text == "Working on it")
    #expect(state?.orderedItems.compactMap(\.asAssistant).last?.status == .interrupted)

    await harness.session.shutdown()
  }

  @Test("a turn the gateway says had already ended is reported as already finished, not as stopped")
  func alreadyDone() async throws {
    let (harness, gateway) = try await running()
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "not_interrupted", "interrupted": false])

    #expect(await gateway.stop(RunningTurn(id: Fixture.runtime, chatKey: Fixture.profile)) == .alreadyDone)
    #expect(await gateway.stop(RunningTurn(id: "rt-terminal")) == .alreadyDone)

    await harness.session.shutdown()
  }

  @Test("another client's session is interrupted by its runtime id alone")
  func stopsAnotherClientsSession() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])
    let gateway = SessionStopGateway(session: harness.session, name: "Home")

    #expect(await gateway.stop(RunningTurn(id: "rt-terminal", title: "Nightly report")) == .stopped)

    let call = try #require(harness.link.calls(RPC.SessionInterrupt.name).first)
    #expect(call.params["session_id"] == .string("rt-terminal"))
    #expect(call.params["profile"] == nil)

    await harness.session.shutdown()
  }

  @Test("a refused interrupt is the gateway's own words in the outcome")
  func refused() async throws {
    let (harness, gateway) = try await running()
    harness.link.refuse(RPC.SessionInterrupt.name) { _ in GatewayRPCError(.rejected, "session not found", code: 4001) }

    #expect(
      await gateway.stop(RunningTurn(id: Fixture.runtime, chatKey: Fixture.profile)) == .failed("session not found"))
    #expect(await gateway.stop(RunningTurn(id: "rt-terminal")) == .failed("session not found"))

    await harness.session.shutdown()
  }

  @Test("the whole flow on a gateway without stop-everything: every running turn is interrupted once, the one that fails is in the summary")
  func wholeFlow() async throws {
    let (harness, gateway) = try await running()
    harness.link.refuse(RPC.SessionInterruptAll.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    list(
      harness,
      [
        Self.row(id: Fixture.runtime, key: Fixture.stored),
        Self.row(id: "rt-a", key: "a", title: "A"),
        Self.row(id: "rt-b", key: "b", title: "B"),
        Self.row(id: "", key: "c", status: "working")
      ])
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])
    harness.link.refuse(RPC.SessionInterrupt.name) { params in
      params["session_id"]?.stringValue == "rt-b" ? GatewayRPCError(.rejected, "not yours", code: 4001) : nil
    }

    let model = EmergencyStopModel(gateways: { [gateway] }, notConnected: { ["Work"] })
    await model.begin()

    guard case .confirming(let plan) = model.phase else {
      Issue.record("expected a question, got \(model.phase)")
      return
    }

    #expect(plan.total == 3)
    #expect(plan.unreachable == 1)
    #expect(plan.notAsked == ["Work"])

    await model.confirm()

    guard case .finished(let summary) = model.phase else {
      Issue.record("expected a summary, got \(model.phase)")
      return
    }

    #expect(summary.stopped == 2)
    #expect(summary.failed == 1)
    #expect(summary.records.first { $0.turn.id == "rt-b" }?.outcome == .failed("not yours"))

    let interrupted = harness.link.calls(RPC.SessionInterrupt.name).compactMap { $0.params["session_id"]?.stringValue }
    #expect(Set(interrupted) == [Fixture.runtime, "rt-a", "rt-b"])
    #expect(interrupted.count == 3, "each turn once")

    await harness.session.shutdown()
  }

  // MARK: - In one call (session.interrupt_all)

  private static let everything: JSONValue = [
    "stopped": [
      ["session_id": "rt-1", "session_key": "stored-1", "profile": .string(Fixture.profile), "title": "Quarterly", "source": "tui"],
      ["session_id": "rt-2", "session_key": "stored-2", "profile": "ghost", "title": .null, "source": "cli"]
    ],
    "already_idle": 3, "not_allowed": 1, "failed": 0
  ]

  @Test("one call stops everything: no params, each stopped turn named by the bot of its profile")
  func stopsEverythingInOneCall() async throws {
    let (harness, gateway) = try await running()
    harness.link.respond(to: RPC.SessionInterruptAll.name, with: Self.everything)

    let outcome = await gateway.stopEverything()

    guard case .answered(let report) = outcome else {
      Issue.record("expected an answer, got \(outcome)")
      return
    }

    #expect(report.stopped.map(\.id) == ["rt-1", "rt-2"])
    #expect(report.stopped[0].botName == harness.session.chatName(Fixture.profile))
    #expect(report.stopped[0].title == "Quarterly")
    #expect(report.stopped[0].source == "tui")
    #expect(report.stopped[1].botName == "ghost", "a profile the roster does not know is named by its handle")
    #expect(report.stopped[1].title.isEmpty)
    #expect(report.alreadyIdle == 3)
    #expect(report.notAllowed == 1)
    #expect(report.failed == 0)

    let calls = harness.link.calls(RPC.SessionInterruptAll.name)
    #expect(calls.count == 1)
    #expect(calls.first?.params["profile"] == nil, "every profile")
    #expect(harness.link.calls(RPC.SessionInterrupt.name).isEmpty)
    #expect(harness.link.calls(RPC.SessionActiveList.name).isEmpty, "it does not read the list to stop")

    await harness.session.shutdown()
  }

  @Test("a gateway that answers -32601 is unsupported, and is not asked again")
  func methodNotFound() async throws {
    let (harness, gateway) = try await running()
    harness.link.refuse(RPC.SessionInterruptAll.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    #expect(await gateway.stopEverything() == .unsupported)
    #expect(await gateway.stopEverything() == .unsupported)
    #expect(harness.link.calls(RPC.SessionInterruptAll.name).count == 1, "told once is enough")

    await harness.session.shutdown()
  }

  @Test("another refusal is the gateway's own words, and is asked again next time")
  func otherRefusal() async throws {
    let (harness, gateway) = try await running()
    harness.link.refuse(RPC.SessionInterruptAll.name) { _ in GatewayRPCError(.rejected, "agents may not stop turns", code: 4033) }

    #expect(await gateway.stopEverything() == .failed("agents may not stop turns"))
    #expect(await gateway.stopEverything() == .failed("agents may not stop turns"))
    #expect(harness.link.calls(RPC.SessionInterruptAll.name).count == 2)

    await harness.session.shutdown()
  }

  @Test("an answer that is not this call's is a failure, and a socket that is down is not connected")
  func unusableAndDown() async throws {
    let (harness, gateway) = try await running()
    harness.link.respond(to: RPC.SessionInterruptAll.name, with: ["status": "interrupted"])

    #expect(await gateway.stopEverything() == .failed(""))

    harness.link.refuse(RPC.SessionInterruptAll.name) { _ in GatewayRPCError(.closed, "socket closed") }
    #expect(await gateway.stopEverything() == .notConnected)

    harness.link.status(.disconnected)
    try await eventually("the session to see it") { await harness.session.status.phase != .ready }

    let calls = harness.link.calls(RPC.SessionInterruptAll.name).count
    #expect(await gateway.stopEverything() == .notConnected)
    #expect(harness.link.calls(RPC.SessionInterruptAll.name).count == calls, "nothing is sent with the socket down")

    await harness.session.shutdown()
  }

  @Test("the whole flow in one call: the question reads the list, the yes is one call, the summary is the gateway's answer")
  func wholeFlowInOneCall() async throws {
    let (harness, gateway) = try await running()

    list(harness, [Self.row(id: Fixture.runtime, key: Fixture.stored), Self.row(id: "", key: "c", status: "working")])
    harness.link.respond(to: RPC.SessionInterruptAll.name, with: Self.everything)

    let model = EmergencyStopModel(gateways: { [gateway] })
    await model.begin()

    guard case .confirming(let plan) = model.phase else {
      Issue.record("expected a question, got \(model.phase)")
      return
    }

    #expect(plan.total == 1)
    #expect(plan.unreachable == 1)
    #expect(harness.link.calls(RPC.SessionInterruptAll.name).isEmpty, "nothing before the yes")

    await model.confirm()

    guard case .finished(let summary) = model.phase else {
      Issue.record("expected a summary, got \(model.phase)")
      return
    }

    #expect(summary.usedStopEverything)
    #expect(summary.stopped == 2)
    #expect(summary.alreadyIdleCount == 3)
    #expect(summary.notAllowed == 1)
    #expect(summary.failed == 0)
    #expect(summary.unreachable == 0, "the caveat is gone: the call does not go by the list")
    #expect(harness.link.calls(RPC.SessionInterruptAll.name).count == 1)
    #expect(harness.link.calls(RPC.SessionInterrupt.name).isEmpty, "no interrupt per session")

    await harness.session.shutdown()
  }

  @Test("a gateway that has no stop-everything falls back inside the same confirm, with a turn by turn stop")
  func fallsBackOnMethodNotFound() async throws {
    let (harness, gateway) = try await running()

    list(harness, [Self.row(id: Fixture.runtime, key: Fixture.stored)])
    harness.link.refuse(RPC.SessionInterruptAll.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }
    harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])

    let model = EmergencyStopModel(gateways: { [gateway] })
    await model.begin()
    await model.confirm()

    guard case .finished(let summary) = model.phase else {
      Issue.record("expected a summary, got \(model.phase)")
      return
    }

    #expect(!summary.usedStopEverything)
    #expect(summary.stopped == 1)
    #expect(harness.link.calls(RPC.SessionInterrupt.name).count == 1)

    await harness.session.shutdown()
  }
}
