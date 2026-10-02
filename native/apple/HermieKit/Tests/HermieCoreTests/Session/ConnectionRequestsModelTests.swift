import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

private let chat = "researcher"
private let runtime = "rt-1"

/// Unix seconds of `ManualClock.date` at zero.
private let start: Double = 1_790_000_000

private func target(_ name: String, state: String = "initiated", url: String? = nil, extra: JSONObject = [:])
  -> JSONValue
{
  var object: JSONObject = ["name": .string(name), "kind": "connector", "action": "authorize", "state": .string(state)]
  object["connect_url"] = url.map(JSONValue.string)

  for (key, value) in extra {
    object[key] = value
  }

  return .object(object)
}

private func request(op: String = "op-1", seq: Int = 1, deadline: Double = start + 300, targets: [JSONValue])
  -> ConnectionRequestPayload
{
  ConnectionRequestPayload(json: [
    "op_id": .string(op), "seq": .number(Double(seq)), "deadline_at": .number(deadline), "timeout_seconds": 300,
    "tool_call_id": "call-1", "targets": .array(targets)
  ])
}

private func update(op: String = "op-1", seq: Int, settled: Bool = false, targets: [JSONValue], owner: JSONValue? = nil)
  -> ConnectionUpdatePayload
{
  var json: JSONObject = [
    "op_id": .string(op), "seq": .number(Double(seq)), "deadline_at": .number(start + 300), "settled": .bool(settled),
    "targets": .array(targets), "owner": owner ?? ["type": "session", "session_id": .string(runtime)]
  ]

  if settled {
    json["settled_by"] = "all_resolved"
  }

  return ConnectionUpdatePayload(json: json)
}

/// Records every call the model makes, and answers or refuses it.
final class RecordingCalls: Sendable {
  private let state = Mutex<(calls: [(String, JSONValue)], fail: Bool)>(([], false))

  var calls: [(String, JSONValue)] { state.withLock { $0.calls } }

  func failing(_ fail: Bool) {
    state.withLock { $0.fail = fail }
  }

  func call(_ method: String, _ params: JSONValue) throws -> RPCReply<JSONValue> {
    let fail = state.withLock { state in
      state.calls.append((method, params))
      return state.fail
    }

    if fail {
      throw GatewayRPCError(.closed, "WebSocket closed")
    }

    return RPCReply(index: 1, result: ["status": "ok", "settled": false])
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct ConnectionRequestsModelTests {
  private func model(_ clock: ManualClock = ManualClock(), calls: RecordingCalls = RecordingCalls()) -> ConnectionRequestsModel {
    ConnectionRequestsModel(clock: clock) { method, params in try calls.call(method, params) }
  }

  @Test func aRequestShowsItsRowsWithOnlyHttpsLinksOpenable() throws {
    let model = model()
    model.requested(
      chat: chat,
      runtimeSessionID: runtime,
      request(targets: [
        target("calendar", url: "https://auth.example.invalid/start?state=x"),
        target("mail", url: "http://auth.example.invalid/start"),
        target("drive", url: "https://trusted.example.invalid@elsewhere.example.invalid/start"),
        target("files", state: "pending", extra: ["kind": "mcp", "instructions": "Paste the token from the settings page."]),
        target("   ")
      ])
    )

    let card = try #require(model.request(for: chat))
    #expect(card.opID == "op-1")
    #expect(card.toolCallID == "call-1")
    #expect(card.runtimeSessionID == runtime)
    #expect(card.deadline == Date(timeIntervalSince1970: start + 300))
    #expect(card.targets.map(\.name) == ["calendar", "mail", "drive", "files"], "a row without a name is no row")

    #expect(card.targets[0].link?.host == "auth.example.invalid")
    #expect(card.targets[0].link?.url.absoluteString == "https://auth.example.invalid/start?state=x")
    #expect(card.targets[1].link == nil && card.targets[1].linkRefused, "plain http is never opened")
    #expect(card.targets[2].link == nil && card.targets[2].linkRefused, "a user part hides the real host")
    #expect(card.targets[3].link == nil && !card.targets[3].linkRefused)
    #expect(card.targets[3].instructions == "Paste the token from the settings page.")
    #expect(card.remaining(at: Date(timeIntervalSince1970: start + 60)) == 240)
  }

  @Test func anIncompleteRequestIsNotACard() {
    let model = model()
    model.requested(chat: chat, runtimeSessionID: runtime, request(targets: []))
    model.requested(chat: chat, runtimeSessionID: runtime, request(deadline: 0, targets: [target("calendar")]))
    model.requested(chat: chat, runtimeSessionID: "", request(targets: [target("calendar")]))
    #expect(model.requests.isEmpty)
  }

  @Test func updatesMoveRowsInOrderAndTheSettlementWithdrawsTheCard() throws {
    let model = model()
    model.requested(chat: chat, runtimeSessionID: runtime, request(targets: [target("calendar", url: "https://a.example.invalid/x"), target("mail")]))
    model.markOpened(chat: chat, target: "calendar")

    model.updated(chat: chat, update(seq: 3, targets: [target("calendar", state: "connected")]))
    #expect(model.request(for: chat)?.targets[0].state == .connected)
    #expect(model.request(for: chat)?.targets[0].opened == true, "what this device did is kept")
    #expect(model.request(for: chat)?.targets[0].link?.host == "a.example.invalid", "a frame without the link keeps it")

    // An older frame, another operation, an account's operation: none moves a row.
    model.updated(chat: chat, update(seq: 2, targets: [target("calendar", state: "failed")]))
    model.updated(chat: chat, update(op: "op-2", seq: 9, targets: [target("mail", state: "failed")]))
    model.updated(chat: chat, update(seq: 9, targets: [target("mail", state: "failed")], owner: ["type": "account"]))
    let card = try #require(model.request(for: chat))
    #expect(card.targets.map(\.state) == [.connected, .initiated])
    #expect(card.seq == 3)

    model.updated(chat: chat, update(seq: 4, settled: true, targets: [target("mail", state: "connected")]))
    #expect(model.request(for: chat) == nil)
  }

  @Test func aResumeRestoresTheCardWithoutRegressingANewerOne() {
    let model = model()
    model.restored(chat: chat, runtimeSessionID: runtime, request(seq: 5, targets: [target("calendar")]))
    #expect(model.request(for: chat)?.seq == 5)

    model.updated(chat: chat, update(seq: 6, targets: [target("calendar", state: "connected")]))
    model.restored(chat: chat, runtimeSessionID: runtime, request(seq: 5, targets: [target("calendar")]))
    #expect(model.request(for: chat)?.targets.first?.state == .connected, "a resume read before the frame does not undo it")

    model.restored(chat: chat, runtimeSessionID: runtime, nil)
    #expect(model.request(for: chat) == nil, "a resume with nothing pending withdraws the card")
  }

  @Test func theCardGoesWhenItsDeadlinePasses() async {
    let clock = ManualClock()
    let model = model(clock)
    model.requested(chat: chat, runtimeSessionID: runtime, request(deadline: start + 30, targets: [target("calendar")]))

    await clock.advance(by: .seconds(29))
    #expect(model.request(for: chat) != nil)
    await clock.advance(by: .seconds(1))
    #expect(model.request(for: chat) == nil)

    model.requested(chat: chat, runtimeSessionID: runtime, request(op: "op-old", deadline: start - 5, targets: [target("calendar")]))
    #expect(model.request(for: chat) == nil, "an operation already past its deadline is not shown")
  }

  @Test func skipAndCancelAnswerTheOperationOnItsSession() async throws {
    let calls = RecordingCalls()
    let model = model(calls: calls)
    model.requested(chat: chat, runtimeSessionID: runtime, request(targets: [target("calendar"), target("mail")]))

    #expect(await model.skip(chat: chat, target: "mail"))
    #expect(await model.cancel(chat: chat))
    #expect(await model.skip(chat: chat, target: "nobody") == false)

    let sent = calls.calls
    #expect(sent.map(\.0) == ["connection.respond", "connection.respond"])
    let skip = sent[0].1
    #expect(skip["op_id"] == "op-1")
    #expect(skip["profile"] == .string(chat))
    #expect(skip["owner"] == ["type": "session", "session_id": .string(runtime)])
    #expect(skip["result"] == ["targets": [["name": "mail", "status": "skipped"]]])
    #expect(sent[1].1["result"] == ["settled_by": "continue"])
    #expect(model.request(for: chat) != nil, "the card moves when the gateway says so")

    calls.failing(true)
    #expect(await model.cancel(chat: chat) == false)
    #expect(model.lastError != nil)
  }
}
