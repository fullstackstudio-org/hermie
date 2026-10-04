import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

private func info(_ extra: JSONObject = [:]) -> JSONValue {
  var object: JSONObject = ["desktop_contract": 7, "model": "example-model"]

  for (key, value) in extra {
    object[key] = value
  }

  return Fixture.resume(extra: ["info": .object(object)])
}

/// A chat over a scripted link, opened, with the model one chat screen reads.
@MainActor
private struct OptionsHarness {
  let harness: SessionHarness
  let model: ChatModel

  static func opened(resume: JSONValue = Fixture.resume()) async throws -> OptionsHarness {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open(resume: resume)
    try await harness.frame()
    return OptionsHarness(harness: harness, model: model)
  }

  var link: ScriptedLink { harness.link }

  func shutdown() async {
    await harness.session.shutdown()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct ChatOptionsTests {
  @Test func aChatTheGatewayDescribedNothingAboutHasTheDefaults() async throws {
    let opened = try await OptionsHarness.opened()
    let options = opened.model.options
    #expect(options.fast == false)
    #expect(options.reasoningEffort == nil)
    #expect(options.contextUsage == nil)
    #expect(options.model == "example-model", "the fixture's resume names a model and nothing else")
    await opened.shutdown()
  }

  @Test func theStateComesFromTheResumesInfoAndFollowsSessionInfo() async throws {
    let resume = info([
      "fast": true, "reasoning_effort": "high", "provider": "example-provider",
      "usage": ["context_used": 50_000, "context_max": 200_000]
    ])
    let opened = try await OptionsHarness.opened(resume: resume)
    let first = opened.model.options
    #expect(first.fast == true)
    #expect(first.reasoningEffort == "high")
    #expect(first.provider == "example-provider")
    #expect(first.contextUsage?.used == 50_000)
    #expect(first.contextUsage?.limit == 200_000)
    #expect(first.contextUsage?.percent == 25)

    opened.link.emit(
      "session.info", session: Fixture.runtime, seq: 1,
      payload: ["desktop_contract": 7, "fast": false, "reasoning_effort": "low", "model": "other-model"])
    try await opened.harness.frame()
    let next = opened.model.options
    #expect(next.fast == false)
    #expect(next.reasoningEffort == "low")
    #expect(next.model == "other-model")
    await opened.shutdown()
  }

  @Test func theUsageATickCarriesMovesTheMeter() async throws {
    let opened = try await OptionsHarness.opened(resume: info(["usage": ["context_used": 1000, "context_max": 4000]]))
    #expect(opened.model.options.contextUsage?.percent == 25)

    opened.link.emit(
      "session.usage", session: Fixture.runtime, seq: 1,
      payload: ["usage": ["context_used": 3000, "context_max": 4000]])
    try await opened.harness.frame()
    #expect(opened.model.options.contextUsage?.percent == 75)
    await opened.shutdown()
  }

  // MARK: Switching

  @Test func fastModeSendsFastAndNormalAndFollowsTheAnswer() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model

    let on = Task { await model.setFast(true) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    #expect(call.params["key"] == "fast")
    #expect(call.params["value"] == "fast")
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    #expect(call.params["profile"] == .string(bot))
    #expect(call.params["scope"] == nil, "the web client scopes only yolo and reasoning")
    opened.link.answer(call, ["key": "fast", "value": "fast"])
    #expect(await on.value == .applied(warning: nil))
    try await opened.harness.frame()
    #expect(model.options.fast == true)

    let off = Task { await model.setFast(false) }
    let second = try await opened.link.pendingCall(RPC.ConfigSet.name) { $0.params["value"] == "normal" }
    opened.link.answer(second, ["key": "fast", "value": "normal"])
    #expect(await off.value == .applied(warning: nil))
    try await opened.harness.frame()
    #expect(model.options.fast == false)
    await opened.shutdown()
  }

  @Test func reasoningEffortIsScopedToTheSession() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model

    let switching = Task { await model.setReasoningEffort("high") }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    #expect(call.params["key"] == "reasoning")
    #expect(call.params["value"] == "high")
    #expect(call.params["scope"] == "session")
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    opened.link.answer(call, ["key": "reasoning", "value": "high"])

    #expect(await switching.value == .applied(warning: nil))
    try await opened.harness.frame()
    #expect(model.options.reasoningEffort == "high")
    await opened.shutdown()
  }

  @Test func theModelGoesOutAsProviderAndModelWithoutAConfirmation() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model
    let choice = BotModelChoice(provider: "second-provider", providerName: "Second Provider", model: "reasoner-2")

    let switching = Task { await model.setModel(choice) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    #expect(call.params["key"] == "model")
    #expect(call.params["value"] == "second-provider/reasoner-2")
    #expect(call.params["confirm_expensive_model"] == nil)
    opened.link.answer(call, ["key": "model", "value": "second-provider/reasoner-2", "warning": "Context shrinks."])

    #expect(await switching.value == .applied(warning: "Context shrinks."))
    try await opened.harness.frame()
    #expect(model.options.model == "second-provider/reasoner-2")
    await opened.shutdown()
  }

  @Test func anExpensiveModelIsHandedBackAndNeverConfirmedOnItsOwn() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model
    let choice = BotModelChoice(provider: "example-provider", model: "expensive-model")

    let asking = Task { await model.setModel(choice) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.answer(
      call,
      ["key": "model", "value": "example-provider/expensive-model", "confirm_required": true, "confirm_message": "It is pricey."])

    #expect(await asking.value == .needsConfirmation(message: "It is pricey."))
    try await opened.harness.frame()
    #expect(model.options.model == "example-model", "nothing was written")
    #expect(opened.link.calls(RPC.ConfigSet.name).count == 1, "no second call without the reader")

    let confirmed = Task { await model.setModel(choice, confirmExpensive: true) }
    let second = try await opened.link.pendingCall(RPC.ConfigSet.name) { $0.params["confirm_expensive_model"] == true }
    #expect(second.params["value"] == "example-provider/expensive-model")
    opened.link.answer(second, ["key": "model", "value": "example-provider/expensive-model"])

    #expect(await confirmed.value == .applied(warning: nil))
    try await opened.harness.frame()
    #expect(model.options.model == "example-provider/expensive-model")
    await opened.shutdown()
  }

  @Test func theInfoTheAnswerCarriesIsWhatTheChatShows() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model

    let switching = Task { await model.setModel(BotModelChoice(provider: "p", model: "m")) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.answer(
      call, ["key": "model", "info": ["desktop_contract": 7, "model": "canonical-m", "provider": "canonical-p"]])

    #expect(await switching.value == .applied(warning: nil))
    try await opened.harness.frame()
    #expect(model.options.model == "canonical-m")
    #expect(model.options.provider == "canonical-p")
    await opened.shutdown()
  }

  @Test func aRefusedSwitchLeavesTheStateAndSaysWhy() async throws {
    let opened = try await OptionsHarness.opened(resume: info(["reasoning_effort": "medium"]))
    let model = opened.model

    let switching = Task { await model.setReasoningEffort("ultra") }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.fail(call, GatewayRPCError(.rejected, "unknown reasoning level", code: 4002))

    #expect(await switching.value == .failed("unknown reasoning level"))
    try await opened.harness.frame()
    #expect(model.options.reasoningEffort == "medium")
    #expect(model.lastError == "unknown reasoning level")
    await opened.shutdown()
  }

  @Test func aDroppedConnectionIsAFailureToo() async throws {
    let opened = try await OptionsHarness.opened()
    let model = opened.model

    let switching = Task { await model.setFast(true) }
    let call = try await opened.link.pendingCall(RPC.ConfigSet.name)
    opened.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))

    #expect(await switching.value == .failed("WebSocket closed"))
    try await opened.harness.frame()
    #expect(model.options.fast == false)
    await opened.shutdown()
  }

  @Test func aChatWithNoSessionAsksNothing() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)

    for outcome in [
      await model.setFast(true), await model.setReasoningEffort("low"),
      await model.setModel(BotModelChoice(provider: "p", model: "m"))
    ] {
      guard case .failed = outcome else {
        Issue.record("expected a failure, got \(outcome)")
        return
      }
    }

    #expect(harness.link.calls(RPC.ConfigSet.name).isEmpty)
    await harness.session.shutdown()
  }

  // MARK: The model list

  @Test func theModelListIsFlattenedAndReadOncePerConnection() async throws {
    let opened = try await OptionsHarness.opened()
    opened.link.respond(
      to: RPC.ModelOptions.name,
      with: [
        "providers": [
          ["slug": "example-provider", "name": "Example Provider", "models": ["example-model", "expensive-model"]],
          ["slug": "second-provider", "name": "Second Provider", "models": ["reasoner-2"]]
        ]
      ])

    guard case .success(let choices) = await opened.model.modelChoices() else {
      Issue.record("expected the list")
      return
    }

    #expect(choices.map(\.sessionValue) == [
      "example-provider/example-model", "example-provider/expensive-model", "second-provider/reasoner-2"
    ])
    #expect(choices.first?.providerName == "Example Provider")

    _ = await opened.model.modelChoices()
    #expect(opened.link.calls(RPC.ModelOptions.name).count == 1)
    await opened.shutdown()
  }

  @Test func aGatewayThatCannotListModelsSaysSoAndIsAskedAgainNextTime() async throws {
    let opened = try await OptionsHarness.opened()
    opened.link.refuse(RPC.ModelOptions.name) { _ in GatewayRPCError(.rejected, "no inventory", code: 4001) }

    let failed = await opened.model.modelChoices()
    #expect(failed == .failure(ChatOptionFailure(message: "no inventory")))

    opened.link.refuse(RPC.ModelOptions.name) { _ in nil }
    opened.link.respond(to: RPC.ModelOptions.name, with: ["providers": [["slug": "p", "models": ["m"]]]])
    guard case .success(let choices) = await opened.model.modelChoices() else {
      Issue.record("expected the list the second time")
      return
    }

    #expect(choices.map(\.sessionValue) == ["p/m"])
    await opened.shutdown()
  }

  @Test func theCurrentModelIsRecognisedWithOrWithoutItsProvider() {
    let choice = BotModelChoice(provider: "example-provider", model: "example-model")
    #expect(choice.isCurrent(model: "example-provider/example-model", provider: nil))
    #expect(choice.isCurrent(model: "example-model", provider: nil))
    #expect(choice.isCurrent(model: "example-model", provider: "example-provider"))
    #expect(!choice.isCurrent(model: "example-model", provider: "other-provider"))
    #expect(!choice.isCurrent(model: "other-model", provider: "example-provider"))
    #expect(!choice.isCurrent(model: nil, provider: nil))
    #expect(BotModelChoice(provider: "p", model: "vendor/m").sessionValue == "vendor/m", "never prefixed twice")
  }

  // MARK: Usage

  @Test func aChatResumedWithoutUsageAsksForIt() async throws {
    let opened = try await OptionsHarness.opened()
    #expect(opened.model.options.contextUsage == nil)

    let refreshing = Task { await opened.model.refreshUsage() }
    let call = try await opened.link.pendingCall(RPC.SessionUsage.name)
    #expect(call.params["session_id"] == .string(Fixture.runtime))
    opened.link.answer(call, ["context_used": 10_000, "context_max": 40_000, "context_estimated": true])
    await refreshing.value

    try await opened.harness.frame()
    let usage = try #require(opened.model.options.contextUsage)
    #expect(usage.percent == 25)
    #expect(usage.estimated)
    await opened.shutdown()
  }

  @Test func anEmptyUsageAnswerDrawsNothing() async throws {
    let opened = try await OptionsHarness.opened()
    opened.link.respond(to: RPC.SessionUsage.name, with: [:])
    await opened.model.refreshUsage()
    try await opened.harness.frame()
    #expect(opened.model.options.contextUsage == nil)
    await opened.shutdown()
  }

  @Test func aDroppedSocketIsNotTakenForAGatewayWithoutUsage() async throws {
    let opened = try await OptionsHarness.opened()
    opened.link.refuse(RPC.SessionUsage.name) { _ in GatewayRPCError(.closed, "WebSocket closed") }
    await opened.model.refreshUsage()

    opened.link.refuse(RPC.SessionUsage.name) { _ in nil }
    opened.link.respond(to: RPC.SessionUsage.name, with: ["context_used": 1, "context_max": 4])
    await opened.model.refreshUsage()
    try await opened.harness.frame()
    #expect(opened.link.calls(RPC.SessionUsage.name).count == 2, "asked again after a transport failure")
    #expect(opened.model.options.contextUsage?.percent == 25)
    await opened.shutdown()
  }

  @Test func aGatewayThatRefusesUsageOnceIsNotAskedAgain() async throws {
    let opened = try await OptionsHarness.opened()
    opened.link.refuse(RPC.SessionUsage.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    await opened.model.refreshUsage()
    await opened.model.refreshUsage()
    #expect(opened.link.calls(RPC.SessionUsage.name).count == 1)
    #expect(opened.model.options.contextUsage == nil)
    #expect(opened.model.lastError == nil, "a missing method is not a fault a reader is told about")
    await opened.shutdown()
  }
}
