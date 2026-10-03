import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@MainActor
struct BotSettingsModelTests {
  private func loaded(
    _ gateway: ProfileGateway = ProfileGateway(),
    runtimeSession: String? = "runtime-1",
    changed: @escaping @MainActor () -> Void = {}
  ) async -> (BotSettingsModel, ProfileGateway) {
    let model = BotSettingsModel(
      gateway: gateway.gateway, profile: "researcher", runtimeSessionID: { runtimeSession }, onChanged: changed)
    await model.load()
    return (model, gateway)
  }

  // MARK: Reading

  @Test func loadingReadsTheProfileAndSeedsTheDrafts() async {
    let (model, gateway) = await loaded()

    #expect(model.phase == .loaded)
    #expect(model.details?.description == "Finds things out.")
    #expect(model.details?.soul == "You are careful.")
    #expect(model.descriptionDraft == "Finds things out.")
    #expect(model.soulDraft == "You are careful.")
    #expect(model.details?.model == BotModelPin(provider: "example-provider", model: "example-model"))
    #expect(model.details?.toolsets.map(\.enabled) == [true, true, true])
    #expect(model.details?.skills.map(\.enabled) == [true, false, true])
    #expect(gateway.methods == ["profiles.describe"])
    #expect(gateway.calls("profiles.describe") == [["name": "researcher"]])
  }

  @Test func aGatewayWithoutTheEditorLeavesNothingToShowAndSaysSo() async {
    let gateway = ProfileGateway()
    gateway.state.withLock { $0.unsupported = ["profiles.describe"] }
    let (model, _) = await loaded(gateway)

    #expect(model.phase == .failed(.unsupported))
    #expect(model.details == nil)
    #expect(!model.canWrite(connected: true))
  }

  @Test func aReloadKeepsWhatThePersonHasStartedTyping() async {
    let (model, gateway) = await loaded()

    model.descriptionDraft = "Reads slowly."
    gateway.state.withLock { $0.description = "Changed elsewhere." }
    await model.load()

    #expect(model.details?.description == "Changed elsewhere.")
    #expect(model.descriptionDraft == "Reads slowly.")
    // The soul was not being edited, so it follows.
    gateway.state.withLock { $0.soul = "You are brief." }
    await model.load()
    #expect(model.soulDraft == "You are brief.")
  }

  @Test func readOnlyWhenOfflineOrRefused() async {
    let (model, gateway) = await loaded()

    #expect(model.canWrite(connected: true))
    #expect(!model.canWrite(connected: false))

    gateway.refuse("profiles.configure")
    await model.setSkill("pdf", enabled: false)
    #expect(model.refused)
    #expect(!model.canWrite(connected: true))
  }

  // MARK: Text

  @Test func savingTheDescriptionWritesItTrimmedAndTellsTheListToReread() async {
    var changes = 0
    let (model, gateway) = await loaded(changed: { changes += 1 })

    model.descriptionDraft = "  Reads slowly.  \n"
    #expect(model.descriptionIsDirty)
    await model.saveDescription()

    #expect(gateway.configures == [["name": "researcher", "description": "Reads slowly."]])
    #expect(model.details?.description == "Reads slowly.")
    #expect(model.descriptionDraft == "Reads slowly.")
    #expect(!model.descriptionIsDirty)
    #expect(model.failures[.description] == nil)
    #expect(changes == 1)
  }

  @Test func savingThePersonalityWritesItAsTypedAndOnlyThat() async {
    var changes = 0
    let (model, gateway) = await loaded(changed: { changes += 1 })

    model.soulDraft = "  Be terse.\n\nNo emoji.\n"
    await model.saveSoul()

    #expect(gateway.configures == [["name": "researcher", "soul": "  Be terse.\n\nNo emoji.\n"]])
    #expect(gateway.state.withLock { $0.soul } == "  Be terse.\n\nNo emoji.\n")
    #expect(model.details?.soul == "  Be terse.\n\nNo emoji.\n")
    #expect(!model.soulIsDirty)
    // The roster does not show the soul, so nothing needs to reread it.
    #expect(changes == 0)
  }

  @Test func aTextRefusedByTheGatewayKeepsTheDraftAndSaysWhy() async {
    let (model, gateway) = await loaded()

    gateway.fail("profiles.configure", with: GatewayRPCError(.rejected, "disk full", code: 5064))
    model.soulDraft = "Be terse."
    await model.saveSoul()

    #expect(model.failures[.soul] == .refused("disk full"))
    #expect(model.soulDraft == "Be terse.")
    #expect(model.details?.soul == "You are careful.")
    #expect(model.soulIsDirty)
    #expect(!model.refused)

    model.revertSoul()
    #expect(model.soulDraft == "You are careful.")
    #expect(model.failures[.soul] == nil)
  }

  @Test func aTextTheGatewayAcceptedButDidNotApplyIsAFailure() async {
    let (model, gateway) = await loaded()

    gateway.fail("profiles.configure", with: BotSettingsFailure.notApplied)
    model.descriptionDraft = "New."
    await model.saveDescription()

    #expect(model.failures[.description] == .notApplied)
    #expect(model.details?.description == "Finds things out.")
  }

  // MARK: Switches

  @Test func aSkillSwitchWritesTheWholeDisabledSetAndLeavesTheOthersAlone() async {
    let (model, gateway) = await loaded()

    // `docx` was already off on the gateway; turning `pdf` off must keep it off.
    await model.setSkill("pdf", enabled: false)

    #expect(gateway.configures == [["name": "researcher", "disabled_skills": ["pdf", "docx"]]])
    #expect(gateway.state.withLock { $0.disabledSkills } == ["pdf", "docx"])
    #expect(model.details?.skills.map(\.enabled) == [false, false, true])

    await model.setSkill("docx", enabled: true)
    #expect(gateway.state.withLock { $0.disabledSkills } == ["pdf"])
  }

  @Test func aToolsetSwitchPinsTheListToWhatIsOnAndOnlyAskingForTheDefaultsTakesThePinAway() async {
    let (model, gateway) = await loaded()

    #expect(model.details?.toolsetsPinned == false)
    await model.setToolset("web", enabled: false)

    #expect(gateway.state.withLock { $0.pinnedToolsets } == ["files", "terminal"])
    #expect(model.details?.toolsetsPinned == true)

    // Back on is a pin of all three, which is what is on screen; the pin is not taken away behind
    // the person's back.
    await model.setToolset("web", enabled: true)
    #expect(gateway.configures.last == ["name": "researcher", "enabled_toolsets": ["files", "web", "terminal"]])
    #expect(gateway.state.withLock { $0.pinnedToolsets } == ["files", "web", "terminal"])
    #expect(model.details?.toolsetsPinned == true)

    await model.useDefaultToolsets()

    #expect(gateway.configures.last == ["name": "researcher", "enabled_toolsets": []])
    #expect(gateway.state.withLock { $0.pinnedToolsets } == nil)
    #expect(model.details?.toolsetsPinned == false)
    // And what the gateway says is on is what is shown.
    #expect(gateway.methods.last == "profiles.describe")
  }

  @Test func askingForTheDefaultsWhenThereIsNoPinSendsNothing() async {
    let (model, gateway) = await loaded()

    await model.useDefaultToolsets()

    #expect(gateway.configures.isEmpty)
  }

  @Test func aSwitchThatDoesNotChangeAnythingWritesNothing() async {
    let (model, gateway) = await loaded()

    await model.setToolset("files", enabled: true)
    await model.setSkill("nope", enabled: false)
    await model.setMcpServer("github", enabled: true)

    #expect(gateway.configures.isEmpty)
  }

  @Test func aRefusedSwitchGoesBackToWhatTheGatewayConfirmed() async {
    let (model, gateway) = await loaded()

    gateway.fail("profiles.configure", with: GatewayRPCError(.rejected, "locked", code: 5064))
    await model.setToolset("web", enabled: false)

    #expect(model.details?.toolsets.first { $0.name == "web" }?.enabled == true)
    #expect(model.failures[.toolsets] == .refused("locked"))
    #expect(gateway.state.withLock { $0.pinnedToolsets } == nil)
  }

  @Test func anAccessDenialOnASwitchPutsTheWholeScreenInReadOnly() async {
    let (model, gateway) = await loaded()

    gateway.refuse("profiles.configure", message: "Viewers cannot edit.")
    await model.setSkill("pdf", enabled: false)

    #expect(model.details?.skills.first?.enabled == true)
    #expect(model.failures[.skills] == .forbidden("Viewers cannot edit."))
    #expect(model.refused)
  }

  @Test func switchesMadeWhileAWriteIsInFlightAreSentTogetherAfterItNeverRacing() async {
    let (model, gateway) = await loaded()

    gateway.hold("profiles.configure")
    let first = Task { await model.setToolset("web", enabled: false) }
    await gateway.waitUntilHeld()

    // One more tap while the first write is still on its way: it paints at once and waits.
    await model.setToolset("terminal", enabled: false)
    #expect(model.details?.toolsets.map(\.enabled) == [true, false, false])
    // The first write is held before the gateway has applied it, and the second did not start.
    #expect(gateway.configures.isEmpty)

    gateway.release()
    await first.value

    // One more write, with the state on screen; never a second one at the same time.
    #expect(gateway.configures.count == 2)
    #expect(gateway.configures.last == ["name": "researcher", "enabled_toolsets": ["files"]])
    #expect(gateway.state.withLock { $0.pinnedToolsets } == ["files"])
    #expect(model.details?.toolsets.map(\.enabled) == [true, false, false])
    #expect(model.details?.toolsetsPinned == true)
    #expect(model.busy.isEmpty)
  }

  @Test func theLastToolsetStaysOnBecauseAnEmptyPinWouldUnpinTheList() async {
    let (model, gateway) = await loaded()

    await model.setToolset("web", enabled: false)
    await model.setToolset("terminal", enabled: false)
    #expect(!model.canDisableToolset("files"))
    #expect(model.canDisableToolset("web") == true)

    await model.setToolset("files", enabled: false)

    // Nothing was sent: an empty list would have put every toolset back on.
    #expect(gateway.configures.count == 2)
    #expect(model.details?.toolsets.first { $0.name == "files" }?.enabled == true)
    #expect(model.failures[.toolsets] == .lastToolset)
    #expect(gateway.state.withLock { $0.pinnedToolsets } == ["files"])
  }

  @Test func aFailedWriteDropsTheTapsQueuedBehindItAndShowsWhatIsReallyThere() async {
    let (model, gateway) = await loaded()

    gateway.hold("profiles.configure")
    gateway.fail("profiles.configure", with: GatewayRPCError(.rejected, "locked", code: 5064))
    let first = Task { await model.setSkill("pdf", enabled: false) }
    await gateway.waitUntilHeld()
    await model.setSkill("web-search", enabled: false)

    gateway.release()
    await first.value

    #expect(gateway.configures.count == 1)
    #expect(model.details?.skills.map(\.enabled) == [true, false, true])
    #expect(model.failures[.skills] == .refused("locked"))
  }

  // MARK: MCP

  @Test func anMcpSwitchWritesTheEnabledListThenAsksTheGatewayToReload() async {
    let (model, gateway) = await loaded()

    await model.setMcpServer("notes", enabled: false)

    #expect(gateway.configures == [["name": "researcher", "enabled_mcp_servers": ["github"]]])
    // Without `confirm`, with the live chat's session, and it wants an answer.
    #expect(gateway.calls("reload.mcp") == [["session_id": "runtime-1"]])
    #expect(model.mcpReloadPrompt == BotSettingsModel.ReloadPrompt(message: "Reloading will invalidate the prompt cache."))
    #expect(model.notice == nil)

    await model.reloadMcp(always: false)

    #expect(gateway.calls("reload.mcp").last == ["confirm": true, "session_id": "runtime-1"])
    #expect(model.mcpReloadPrompt == nil)
    #expect(model.notice == .mcpReloaded)
  }

  @Test func stopAskingReloadsAndTellsTheGatewayToStopAsking() async {
    let (model, gateway) = await loaded()

    await model.setMcpServer("notes", enabled: false)
    await model.reloadMcp(always: true)

    #expect(gateway.calls("reload.mcp").last == ["confirm": true, "always": true, "session_id": "runtime-1"])

    await model.setMcpServer("notes", enabled: true)
    // The gateway no longer asks, so the reload is just done.
    #expect(model.mcpReloadPrompt == nil)
    #expect(model.notice == .mcpReloaded)
  }

  @Test func notNowLeavesTheListChangedAndTheChatsAsTheyWere() async {
    let (model, gateway) = await loaded()

    await model.setMcpServer("notes", enabled: false)
    model.declineMcpReload()

    #expect(model.mcpReloadPrompt == nil)
    #expect(gateway.calls("reload.mcp").count == 1)
    #expect(model.details?.mcpServers.last?.enabled == false)
  }

  // MARK: Model

  @Test func theModelPickerListsWhatTheGatewayOffersOnce() async {
    let (model, gateway) = await loaded()

    await model.loadModelChoices()
    await model.loadModelChoices()

    #expect(model.modelChoices == .loaded([
      BotModelChoice(provider: "example-provider", providerName: "Example Provider", model: "example-model"),
      BotModelChoice(provider: "example-provider", providerName: "Example Provider", model: "expensive-model"),
      BotModelChoice(provider: "second-provider", providerName: "Second Provider", model: "reasoner-2")
    ]))
    #expect(gateway.calls("model.options") == [["explicit_only": true]])
  }

  @Test func aGatewayThatWillNotListModelsHidesThePicker() async {
    let gateway = ProfileGateway()
    gateway.state.withLock { $0.unsupported = ["model.options"] }
    let (model, _) = await loaded(gateway)

    await model.loadModelChoices()

    #expect(model.modelChoices == .unavailable)
  }

  @Test func choosingAModelPinsItAndShowsWhatTheGatewayStored() async {
    var changes = 0
    let (model, gateway) = await loaded(changed: { changes += 1 })
    let choice = BotModelChoice(provider: "second-provider", providerName: "Second Provider", model: "reasoner-2")

    await model.chooseModel(choice)

    #expect(gateway.configures == [["name": "researcher", "model": "reasoner-2", "provider": "second-provider"]])
    // What the gateway stored is what is shown, from a re-read.
    #expect(model.details?.model == BotModelPin(provider: "second-provider", model: "reasoner-2"))
    #expect(model.modelConfirmation == nil)
    #expect(changes == 1)
  }

  @Test func aGuardedModelWritesNothingUntilThePersonConfirmsIt() async {
    let (model, gateway) = await loaded()
    let choice = BotModelChoice(provider: "example-provider", providerName: "Example Provider", model: "expensive-model")

    await model.chooseModel(choice)

    #expect(model.modelConfirmation == BotSettingsModel.ModelConfirmation(
      choice: choice, message: "expensive-model is an expensive model. Continue?"))
    #expect(model.details?.model.model == "example-model")

    model.cancelModelConfirmation()
    #expect(model.modelConfirmation == nil)
    #expect(model.details?.model.model == "example-model")

    await model.chooseModel(choice)
    await model.confirmModel()

    #expect(gateway.configures.last?["confirm_expensive_model"] == true)
    #expect(model.modelConfirmation == nil)
    #expect(model.details?.model.model == "expensive-model")
  }

  // MARK: One queue, and reads that were already stale

  @Test func writesToDifferentSectionsTakeTurnsInTheOrderTheyWereAskedNeverTogether() async {
    let (model, gateway) = await loaded()

    gateway.hold("profiles.configure")
    let skill = Task { await model.setSkill("pdf", enabled: false) }
    await gateway.waitUntilHeld()

    // A description, a personality and a model while the first is still on its way: all wait.
    model.descriptionDraft = "Reads slowly."
    model.soulDraft = "Be brief."
    let description = Task { await model.saveDescription() }
    let soul = Task { await model.saveSoul() }
    let pin = Task { await model.chooseModel(BotModelChoice(provider: "second-provider", model: "reasoner-2")) }
    await botSettingsEventually("the three to be waiting") {
      model.busy.isSuperset(of: [.skills, .description, .soul, .model])
    }

    #expect(gateway.inFlight == 1)
    #expect(gateway.configures.isEmpty)

    gateway.release()
    await skill.value
    await description.value
    await soul.value
    await pin.value

    // Never two at once, and each one's params were built when its turn came.
    #expect(gateway.maxInFlight == 1)
    #expect(gateway.configures.count == 4)
    #expect(gateway.configures[0]["disabled_skills"] != nil)
    #expect(gateway.configures[1]["description"] == "Reads slowly.")
    #expect(gateway.configures[2]["soul"] == "Be brief.")
    #expect(gateway.configures[3]["model"] == "reasoner-2")
    #expect(model.failures.isEmpty)
    #expect(model.busy.isEmpty)
    #expect(model.details?.description == "Reads slowly.")
    #expect(model.details?.soul == "Be brief.")
    #expect(model.details?.model == BotModelPin(provider: "second-provider", model: "reasoner-2"))
  }

  @Test func aTapMadeWhileItsSectionWaitsInTheQueueIsPartOfTheWriteWhenItsTurnComes() async {
    let (model, gateway) = await loaded()

    gateway.hold("profiles.configure")
    model.soulDraft = "Be brief."
    let soul = Task { await model.saveSoul() }
    await gateway.waitUntilHeld()

    let first = Task { await model.setSkill("pdf", enabled: false) }
    await botSettingsEventually("the skill write to wait") { model.busy.contains(.skills) }
    await model.setSkill("web-search", enabled: false)

    gateway.release()
    await soul.value
    await first.value

    // One skills write, with both taps: the second needed none of its own.
    let skillWrites = gateway.configures.filter { $0["disabled_skills"] != nil }
    #expect(skillWrites == [["name": "researcher", "disabled_skills": ["pdf", "docx", "web-search"]]])
  }

  @Test func aDescribeThatWasSentBeforeAWriteAndAnswersAfterItDoesNotUndoIt() async {
    let (model, gateway) = await loaded()

    // The gateway works out its answer from the profile as it is now, and the reply is kept back.
    gateway.holdAfter("profiles.describe")
    let reload = Task { await model.load() }
    await gateway.waitUntilHeld()

    model.soulDraft = "Be brief."
    await model.saveSoul()
    #expect(model.details?.soul == "Be brief.")

    gateway.release()
    await reload.value

    // The old soul came back in the late answer; it is not believed.
    #expect(model.details?.soul == "Be brief.")
    #expect(model.soulDraft == "Be brief.")
    #expect(!model.soulIsDirty)
  }

  @Test func aStaleDescribeIsOnlyIgnoredForTheSectionThatWasWritten() async {
    let (model, gateway) = await loaded()

    gateway.holdAfter("profiles.describe")
    let reload = Task { await model.load() }
    await gateway.waitUntilHeld()

    // The soul is written; the description changed on the gateway behind the app's back.
    model.soulDraft = "Be brief."
    await model.saveSoul()
    gateway.state.withLock { $0.description = "Changed elsewhere." }

    gateway.release()
    await reload.value

    #expect(model.details?.soul == "Be brief.")
    // The description section was not written by this screen, and its read was sent after nothing
    // newer: it is taken. (The held answer was worked out before the change, so it still has the old
    // text; the next read takes the new one.)
    await model.load()
    #expect(model.details?.description == "Changed elsewhere.")
    #expect(model.details?.soul == "Be brief.")
  }

  @Test func aDescribeThatAnswersWhileAWriteToThatSectionIsInFlightDoesNotUndoTheSwitch() async {
    let (model, gateway) = await loaded()

    gateway.hold("profiles.configure")
    let write = Task { await model.setSkill("pdf", enabled: false) }
    await gateway.waitUntilHeld()

    // A read arrives while the write is held: the gateway still says the skill is on.
    await model.load()
    #expect(model.details?.skills.first { $0.name == "pdf" }?.enabled == false)

    gateway.release()
    await write.value
    #expect(model.details?.skills.first { $0.name == "pdf" }?.enabled == false)
    #expect(gateway.state.withLock { $0.disabledSkills.contains("pdf") })
  }

  // MARK: Back to the defaults

  @Test func puttingTheToolsetsBackToTheDefaultsLocksTheirSwitchesUntilItIsReadBack() async {
    let (model, gateway) = await loaded()

    await model.setToolset("web", enabled: false)
    #expect(model.details?.toolsetsPinned == true)

    gateway.hold("profiles.configure")
    let reset = Task { await model.useDefaultToolsets() }
    await gateway.waitUntilHeld()

    #expect(model.toolsetsLocked)
    #expect(model.busy.contains(.toolsets))

    // A switch tapped now is not written, and a read that answers meanwhile does not replace the pin.
    await model.setToolset("web", enabled: true)
    await model.load()
    #expect(gateway.configures.count == 1)
    #expect(model.details?.toolsetsPinned == true)
    #expect(model.details?.toolsets.first { $0.name == "web" }?.enabled == false)

    gateway.release()
    await reset.value

    #expect(!model.toolsetsLocked)
    #expect(model.details?.toolsetsPinned == false)
    #expect(model.details?.toolsets.first { $0.name == "web" }?.enabled == true)
    #expect(gateway.state.withLock { $0.pinnedToolsets } == nil)
    #expect(model.busy.isEmpty)
  }

  // MARK: Picture

  @Test func aPictureIsUploadedAndTheListToldToReread() async {
    var changes = 0
    let (model, gateway) = await loaded(changed: { changes += 1 })

    await model.setAvatar(base64: "iVBORw0KGgo=")

    #expect(gateway.calls("profiles.set_asset") == [["name": "researcher", "asset": "avatar", "data": "iVBORw0KGgo="]])
    #expect(gateway.state.withLock { $0.avatar } == "iVBORw0KGgo=")
    #expect(changes == 1)

    await model.clearAvatar()
    #expect(gateway.calls("profiles.set_asset").last == ["name": "researcher", "asset": "avatar", "clear": true])
    #expect(gateway.state.withLock { $0.avatar } == nil)
    #expect(changes == 2)
  }

  @Test func aPictureTheGatewayRefusesIsReportedAndNothingIsRefreshed() async {
    var changes = 0
    let (model, gateway) = await loaded(changed: { changes += 1 })

    gateway.fail("profiles.set_asset", with: GatewayRPCError(.rejected, "asset too large", code: 4069))
    await model.setAvatar(base64: "AAAA")

    #expect(model.failures[.avatar] == .refused("asset too large"))
    #expect(changes == 0)
  }
}
