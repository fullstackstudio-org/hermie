import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A chat over a scripted link, opened, with the model one chat screen reads.
@MainActor
private struct YoloHarness {
  let harness: SessionHarness
  let model: ChatModel

  static func opened(resume: JSONValue = Fixture.resume()) async throws -> YoloHarness {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open(resume: resume)
    try await harness.frame()
    return YoloHarness(harness: harness, model: model)
  }

  var link: ScriptedLink { harness.link }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct YoloTests {
  @Test func aChatTheGatewayDescribedWithoutYoloIsOff() async throws {
    let opened = try await YoloHarness.opened()
    #expect(opened.model.yolo == false)
    await opened.shutdown()
  }

  @Test func theStateComesFromTheResumesInfoAndFollowsSessionInfo() async throws {
    let on = Fixture.resume(extra: ["info": ["desktop_contract": 7, "model": "example-model", "yolo": true]])
    let opened = try await YoloHarness.opened(resume: on)
    #expect(opened.model.yolo == true)

    opened.link.emit("session.info", session: Fixture.runtime, seq: 1, payload: ["desktop_contract": 7, "yolo": false])
    try await opened.harness.frame()
    #expect(opened.model.yolo == false)

    opened.link.emit("session.info", session: Fixture.runtime, seq: 2, payload: ["desktop_contract": 7, "yolo": true])
    try await opened.harness.frame()
    #expect(opened.model.yolo == true)
    await opened.shutdown()
  }

  @Test func switchingItOnAsksTheGatewayForThisSessionOnly() async throws {
    let opened = try await YoloHarness.opened()
    let model = opened.model

    let switching = Task { await model.setYolo(true) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    #expect(call.params["key"] == "yolo")
    #expect(call.params["value"] == "on")
    #expect(call.params["scope"] == "session")
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    #expect(call.params["profile"] == .string(bot))
    opened.link.answer(call, ["key": "yolo", "value": "1", "scope": "session"])

    #expect(await switching.value == .switched(true))
    try await opened.harness.frame()
    #expect(model.yolo == true)
    #expect(model.lastError == nil)
    await opened.shutdown()
  }

  @Test func switchingItOffSendsOffAndClearsTheState() async throws {
    let on = Fixture.resume(extra: ["info": ["desktop_contract": 7, "yolo": true]])
    let opened = try await YoloHarness.opened(resume: on)
    let model = opened.model
    #expect(model.yolo == true)

    let switching = Task { await model.setYolo(false) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    #expect(call.params["value"] == "off")
    #expect(call.params["scope"] == "session")
    opened.link.answer(call, ["key": "yolo", "value": "0", "scope": "session"])

    #expect(await switching.value == .switched(false))
    try await opened.harness.frame()
    #expect(model.yolo == false)
    await opened.shutdown()
  }

  @Test func theInfoTheAnswerCarriesIsWhatTheChatShows() async throws {
    let opened = try await YoloHarness.opened()
    let model = opened.model

    let switching = Task { await model.setYolo(true) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.answer(call, ["key": "yolo", "value": "on", "info": ["desktop_contract": 7, "yolo": true]])

    #expect(await switching.value == .switched(true))
    try await opened.harness.frame()
    #expect(model.yolo == true)
    await opened.shutdown()
  }

  @Test func aRefusedSwitchLeavesTheStateAndSaysWhy() async throws {
    let opened = try await YoloHarness.opened()
    let model = opened.model

    let switching = Task { await model.setYolo(true) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.fail(call, GatewayRPCError(.rejected, "not allowed here", code: 4030))

    #expect(await switching.value == .failed("not allowed here"))
    try await opened.harness.frame()
    #expect(model.yolo == false)
    #expect(model.lastError == "not allowed here")
    await opened.shutdown()
  }

  @Test func aDroppedConnectionIsAFailureToo() async throws {
    let on = Fixture.resume(extra: ["info": ["desktop_contract": 7, "yolo": true]])
    let opened = try await YoloHarness.opened(resume: on)
    let model = opened.model

    let switching = Task { await model.setYolo(false) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))

    #expect(await switching.value == .failed("WebSocket closed"))
    try await opened.harness.frame()
    #expect(model.yolo == true, "still on: the gateway never said otherwise")
    await opened.shutdown()
  }

  @Test func aChatWithNoSessionAsksNothing() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)

    let outcome = await model.setYolo(true)
    guard case .failed = outcome else {
      Issue.record("expected a failure, got \(outcome)")
      return
    }

    #expect(harness.link.calls(RPC.ConfigSet.name).isEmpty)
    #expect(model.yolo == false)
    await harness.session.shutdown()
  }
}
