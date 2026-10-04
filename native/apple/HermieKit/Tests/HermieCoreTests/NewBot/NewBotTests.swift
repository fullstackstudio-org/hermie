import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

struct ProfileNameTests {
  @Test func aLegalHandleIsKeptAsTypedInLowerCase() {
    let verdict = ProfileName.check("  Scout-2 ")

    #expect(verdict.handle == "scout-2")
    #expect(verdict.isValid)
    #expect(verdict.warning == nil)
  }

  @Test func nothingTypedIsAProblemOfItsOwn() {
    #expect(ProfileName.check("   ").problem == .empty)
  }

  @Test func theBuiltInBotIsRefusedWhateverTheCase() {
    #expect(ProfileName.check("Default").problem == .builtIn)
    #expect(ProfileName.check("DEFAULT").problem == .builtIn)
  }

  @Test func aNameThatIsNotAFileNameSaysWhatWouldDo() {
    #expect(ProfileName.check("My Work").problem == .shape(suggestion: "my-work"))
    #expect(ProfileName.check("-lead").problem == .shape(suggestion: "lead"))
    #expect(ProfileName.check("héllo").problem == .shape(suggestion: "h-llo"))
    // Nothing legal is left of this one, so the suggestion is the stock one.
    #expect(ProfileName.check("???").problem == .shape(suggestion: "my-work"))
  }

  @Test func sixtyFourCharactersAreAllowedAndSixtyFiveAreNot() {
    #expect(ProfileName.check(String(repeating: "a", count: 64)).isValid)
    #expect(ProfileName.check(String(repeating: "a", count: 65)).problem
      == .shape(suggestion: String(repeating: "a", count: 64)))
  }

  @Test func reservedNamesCollideWithTheInstallation() {
    for name in ["hermes", "test", "tmp", "root", "sudo"] {
      #expect(ProfileName.check(name).problem == .reserved(name))
    }
  }

  @Test func aNameOnTheRosterIsCaughtInTheField() {
    #expect(ProfileName.check("Scout", taken: ["scout"]).problem == .taken("scout"))
    #expect(ProfileName.check("other", taken: ["scout"]).isValid)
  }

  @Test func aSubcommandIsALegalNameWithAWarning() {
    let verdict = ProfileName.check("chat")

    #expect(verdict.isValid)
    #expect(verdict.warning == .subcommand("chat"))
  }
}

/// A gateway that makes profiles the way `profiles.create` does and answers `model.options`.
private final class CreatingGateway: Sendable {
  struct State {
    var calls: [(method: String, params: JSONObject)] = []
    var created: [String] = []
    var failures: [String: any Error] = [:]
    var answerName: String?
    var modelSet = false
    var inherited = true
    var listed = true
  }

  let state = Mutex(State())

  var gateway: BotSettingsGateway {
    BotSettingsGateway { method, params in
      try self.handle(method, params)
    }
  }

  var roster: NewBotRoster {
    NewBotRoster(
      refresh: {
        self.state.withLock { state in
          state.calls.append(("roster.refresh", [:]))
          return state.listed ? state.created.map { Bot(name: $0) } : []
        }
      },
      resolveCanonical: { bot in
        self.state.withLock { $0.calls.append(("roster.resolveCanonical", ["name": .string(bot.name)])) }
        return CanonicalSession(id: "stored-\(bot.name)", resolvedID: "resolved-\(bot.name)")
      }
    )
  }

  func calls(_ method: String) -> [JSONObject] {
    state.withLock { $0.calls.filter { $0.method == method }.map(\.params) }
  }

  var methods: [String] { state.withLock { $0.calls.map(\.method) } }

  private func handle(_ method: String, _ params: JSONObject) throws -> JSONValue {
    try state.withLock { state in
      state.calls.append((method, params))

      if let failure = state.failures[method] {
        state.failures[method] = nil
        throw failure
      }

      switch method {
      case "profiles.create":
        let name = state.answerName ?? params["name"]?.stringValue ?? ""
        state.created.append(name)

        return [
          "ok": true,
          "name": .string(name),
          "path": .string("/profiles/\(name)"),
          "model_set": .bool(state.modelSet),
          "mirrored": ["model_inherited": .bool(state.inherited)]
        ]
      case "model.options":
        return [
          "providers": [
            ["slug": "acme", "name": "Acme", "models": ["small", "large"]],
            ["slug": "other", "name": "Other", "models": ["tiny"]]
          ]
        ]
      default:
        throw GatewayRPCError(.rejected, "unexpected \(method)", code: -32601)
      }
    }
  }
}

@MainActor
struct NewBotModelTests {
  private func model(
    _ gateway: CreatingGateway = CreatingGateway(),
    existing: [String] = ["alpha", "beta"],
    labels: LabelLog = LabelLog()
  ) -> NewBotModel {
    NewBotModel(
      gateway: gateway.gateway,
      roster: gateway.roster,
      existing: existing,
      setLabel: { labels.record($0, $1) }
    )
  }

  @MainActor
  final class LabelLog {
    var entries: [String] = []
    func record(_ name: String, _ label: String) { entries.append("\(name)=\(label)") }
  }

  // MARK: Params

  @Test func aBareDraftSendsTheNameAlone() {
    let params = NewBotDraft(handle: "scout").params.json

    #expect(params == ["name": "scout"])
  }

  @Test func aDescriptionIsTrimmedAndAnEmptyOneIsLeftOut() {
    #expect(NewBotDraft(handle: "scout", description: "  Looks ahead.\n").params.json["description"] == "Looks ahead.")
    #expect(NewBotDraft(handle: "scout", description: "  \n").params.json["description"] == nil)
  }

  @Test func theModelAndItsProviderGoTogetherAndTheIdIsBare() {
    let choice = BotModelChoice(provider: "acme", model: "large")
    let params = NewBotDraft(handle: "scout", model: choice).params.json

    #expect(params["model"] == "large")
    #expect(params["provider"] == "acme")
  }

  @Test func aCloneNamesItsSourceAndNeverSendsNull() {
    #expect(NewBotDraft(handle: "scout", cloneFrom: "alpha").params.json["clone_from"] == "alpha")
    #expect(NewBotDraft(handle: "scout", cloneFrom: nil).params.json["clone_from"] == nil)
    #expect(NewBotDraft(handle: "scout", cloneFrom: "").params.json["clone_from"] == nil)
  }

  @Test func credentialsAreNeverNamedSoTheGatewayDefaultApplies() {
    let params = NewBotDraft(handle: "scout", cloneFrom: "alpha").params.json

    #expect(params["mirror_credentials"] == nil)
  }

  // MARK: Form

  @Test func theFormCannotBeSentUntilTheHandleIsGood() {
    let form = model()

    #expect(!form.canCreate)

    form.handleText = "alpha"
    #expect(form.verdict.problem == .taken("alpha"))
    #expect(!form.canCreate)

    form.handleText = "Scout"
    #expect(form.canCreate)
  }

  // MARK: Models

  @Test func theModelsAreFlattenedOutOfTheInventoryAndAskedForExplicitOnly() async {
    let gateway = CreatingGateway()
    let form = model(gateway)

    await form.loadModelChoices()

    #expect(
      form.modelChoices
        == .loaded([
          BotModelChoice(provider: "acme", providerName: "Acme", model: "small"),
          BotModelChoice(provider: "acme", providerName: "Acme", model: "large"),
          BotModelChoice(provider: "other", providerName: "Other", model: "tiny")
        ]))
    #expect(gateway.calls("model.options") == [["explicit_only": true]])
  }

  @Test func aGatewayThatWillNotListModelsLeavesTheBotToInherit() async {
    let gateway = CreatingGateway()
    gateway.state.withLock { $0.failures["model.options"] = GatewayRPCError(.rejected, "no", code: -32601) }
    let form = model(gateway)

    await form.loadModelChoices()

    #expect(form.modelChoices == .unavailable)
  }

  // MARK: Creating

  @Test func creatingMakesTheProfileRefreshesTheRosterAndThenResolvesTheChat() async {
    let gateway = CreatingGateway()
    let labels = LabelLog()
    let form = model(gateway, labels: labels)

    form.handleText = "  Scout "
    form.botDescription = "Looks ahead."
    form.cloneFrom = "alpha"
    form.displayName = "  Scouty "

    let created = await form.create()

    #expect(created?.name == "scout")
    #expect(created?.chat.id == "stored-scout")
    #expect(form.created == created)
    #expect(form.failure == nil)
    #expect(!form.creating)
    // The order is the point: the roster is read after the profile exists, the chat after the roster.
    #expect(gateway.methods == ["profiles.create", "roster.refresh", "roster.resolveCanonical"])
    #expect(
      gateway.calls("profiles.create")
        == [["name": "scout", "description": "Looks ahead.", "clone_from": "alpha"]])
    #expect(labels.entries == ["scout=Scouty"])
  }

  @Test func theChatIsLookedUpUnderTheNameTheGatewayStored() async {
    let gateway = CreatingGateway()
    gateway.state.withLock { $0.answerName = "scout-2" }
    let form = model(gateway)

    form.handleText = "scout"
    let created = await form.create()

    #expect(created?.name == "scout-2")
    #expect(gateway.calls("roster.resolveCanonical") == [["name": "scout-2"]])
  }

  @Test func aBotWithNoModelAtAllIsSaidToHaveNone() async {
    let gateway = CreatingGateway()
    gateway.state.withLock {
      $0.modelSet = false
      $0.inherited = false
    }
    let form = model(gateway)

    form.handleText = "scout"
    #expect(await form.create()?.withoutModel == true)
  }

  @Test func aPinnedOrInheritedModelIsAModel() async {
    let pinned = CreatingGateway()
    pinned.state.withLock {
      $0.modelSet = true
      $0.inherited = false
    }
    let first = model(pinned)
    first.handleText = "scout"
    #expect(await first.create()?.withoutModel == false)

    let inherited = model(CreatingGateway())
    inherited.handleText = "scout"
    #expect(await inherited.create()?.withoutModel == false)
  }

  @Test func aRefusalIsKeptAndNothingElseRuns() async {
    let gateway = CreatingGateway()
    gateway.state.withLock {
      $0.failures["profiles.create"] = GatewayRPCError(.rejected, "Profile 'scout' already exists", code: 5000)
    }
    let form = model(gateway)

    form.handleText = "scout"
    let created = await form.create()

    #expect(created == nil)
    #expect(form.failure == .request(.refused("Profile 'scout' already exists")))
    #expect(gateway.methods == ["profiles.create"])
    #expect(!form.creating)
    #expect(form.canCreate)
  }

  @Test func noConnectionIsOffline() async {
    let gateway = CreatingGateway()
    gateway.state.withLock { $0.failures["profiles.create"] = GatewayRPCError(.notConnected, "offline") }
    let form = model(gateway)

    form.handleText = "scout"
    _ = await form.create()

    #expect(form.failure == .request(.offline))
  }

  @Test func aBotTheGatewayMadeAndDidNotListIsSaidSoAndNotMadeAgain() async {
    let gateway = CreatingGateway()
    gateway.state.withLock { $0.listed = false }
    let form = model(gateway)

    form.handleText = "scout"
    #expect(await form.create() == nil)
    #expect(form.failure == .notListed("scout"))

    // The roster catches up; pressing again carries on from the roster, and the gateway is not asked
    // for a name that is taken now.
    gateway.state.withLock { $0.listed = true }
    let created = await form.create()

    #expect(created?.name == "scout")
    #expect(form.failure == nil)
    #expect(gateway.calls("profiles.create").count == 1)
  }

  @Test func aFailedResolveIsKeptAndTheBotIsNotMadeAgain() async {
    let gateway = CreatingGateway()
    let failing = NewBotRoster(
      refresh: gateway.roster.refresh,
      resolveCanonical: { _ in throw GatewayRPCError(.timeout, "slow") }
    )
    let form = NewBotModel(gateway: gateway.gateway, roster: failing, existing: [])

    form.handleText = "scout"
    #expect(await form.create() == nil)
    #expect(form.failure == .request(.offline))
    #expect(gateway.calls("profiles.create").count == 1)
  }

  @Test func aSecondPressAfterSuccessDoesNothingMore() async {
    let gateway = CreatingGateway()
    let form = model(gateway)

    form.handleText = "scout"
    let first = await form.create()
    let second = await form.create()

    #expect(first == second)
    #expect(gateway.calls("profiles.create").count == 1)
  }
}
