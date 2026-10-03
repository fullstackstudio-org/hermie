import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The read and write mapping: what `profiles.describe` becomes, and the params of every write.
struct BotSettingsParamsTests {
  // MARK: Reading

  @Test func aDescribeAnswerBecomesTheDetailsTheScreenWorksWith() throws {
    let reply: JSONValue = [
      "name": "researcher",
      "description": "Finds things out.",
      "soul": "You are careful.",
      "model": ["provider": "example-provider", "default": "example-model"],
      "skills": [["name": "pdf", "enabled": true], ["name": "docx", "enabled": false], ["name": "bare"]],
      "toolsets": [
        ["name": "files", "label": "Files", "description": "Read files.", "tool_count": 6, "enabled": true],
        ["name": "web", "enabled": false]
      ],
      "toolsets_pinned": true,
      "mcp_servers": [["name": "github", "enabled": true, "transport": "http"], ["name": "notes", "enabled": false]]
    ]
    let described = try #require(ProfilesDescribeResult(jsonValue: reply))
    let details = BotProfileDetails(described, fallbackName: "fallback")

    #expect(details.name == "researcher")
    #expect(details.description == "Finds things out.")
    #expect(details.soul == "You are careful.")
    #expect(details.model == BotModelPin(provider: "example-provider", model: "example-model"))
    #expect(details.model.isPinned)
    // A skill that says nothing about itself is on: the gateway lists what is installed.
    #expect(details.skills == [
      BotSwitch(name: "pdf", enabled: true), BotSwitch(name: "docx", enabled: false), BotSwitch(name: "bare", enabled: true)
    ])
    #expect(details.toolsets.map(\.name) == ["files", "web"])
    #expect(details.toolsets[0].details == "Read files.")
    #expect(details.toolsets[0].toolCount == 6)
    // A toolset without a label is called by its name.
    #expect(details.toolsets[1].label == "web")
    #expect(!details.toolsets[1].enabled)
    #expect(details.toolsetsPinned)
    #expect(details.mcpServers == [
      BotSwitch(name: "github", enabled: true, transport: "http"),
      BotSwitch(name: "notes", enabled: false, transport: "stdio")
    ])
  }

  @Test func anEmptyAnswerIsAnEmptyProfileNotACrash() throws {
    let described = try #require(ProfilesDescribeResult(jsonValue: [:]))
    let details = BotProfileDetails(described, fallbackName: "researcher")

    #expect(details == BotProfileDetails(name: "researcher"))
    #expect(!details.model.isPinned)
    #expect(!details.toolsetsPinned)
  }

  @Test func entriesWithoutANameAreLeftOut() throws {
    let described = try #require(
      ProfilesDescribeResult(jsonValue: [
        "skills": [["enabled": true], ["name": ""], ["name": "pdf"]],
        "toolsets": [["label": "Nameless"]],
        "mcp_servers": [["transport": "http"]]
      ]))
    let details = BotProfileDetails(described, fallbackName: "x")

    #expect(details.skills.map(\.name) == ["pdf"])
    #expect(details.toolsets.isEmpty)
    #expect(details.mcpServers.isEmpty)
  }

  @Test func theModelInventoryIsFlattenedInTheGatewaysOrder() throws {
    let options = try #require(
      ModelOptionsResult(jsonValue: [
        "providers": [
          ["slug": "a", "name": "Provider A", "models": ["one", "two"]],
          ["name": "No slug", "models": ["lost"]],
          ["slug": "b", "models": ["three", ""]]
        ]
      ]))
    let choices = BotModelChoice.choices(options)

    #expect(choices.map(\.qualified) == ["a/one", "a/two", "b/three"])
    #expect(choices[0].providerName == "Provider A")
    // A provider with no name is called by its slug.
    #expect(choices[2].providerName == "b")
  }

  // MARK: Writing

  private let toolsets = [
    BotToolset(name: "files", enabled: true), BotToolset(name: "web", enabled: false),
    BotToolset(name: "terminal", enabled: true)
  ]

  @Test func textIsSentAsTheGatewayStoresIt() {
    // The description is trimmed; the soul is the author's, whitespace and all.
    #expect(BotSettingsParams.description("r", "  Finds things.\n") == ["name": "r", "description": "Finds things."])
    #expect(BotSettingsParams.soul("r", "  You are terse.\n") == ["name": "r", "soul": "  You are terse.\n"])
  }

  @Test func toolsetsAreSentAsThePinOfTheEnabledOnes() {
    #expect(
      BotSettingsParams.toolsets("r", toolsets)
        == ["name": "r", "enabled_toolsets": ["files", "terminal"]])
  }

  @Test func everythingOnIsStillAPinOfNamesBecauseTheDefaultsNeedNotBeEverything() {
    let all = toolsets.map { BotToolset(name: $0.name, enabled: true) }

    #expect(BotSettingsParams.toolsets("r", all) == ["name": "r", "enabled_toolsets": ["files", "web", "terminal"]])
  }

  @Test func followingTheDefaultsIsItsOwnRequestAndIsAnEmptyList() {
    #expect(BotSettingsParams.toolsetDefaults("r") == ["name": "r", "enabled_toolsets": []])
  }

  @Test func skillsAreSentAsTheDisabledSetAndMcpAsTheEnabledList() {
    let skills = [BotSwitch(name: "pdf"), BotSwitch(name: "docx", enabled: false), BotSwitch(name: "web", enabled: false)]
    let servers = [BotSwitch(name: "github"), BotSwitch(name: "notes", enabled: false)]

    #expect(BotSettingsParams.skills("r", skills) == ["name": "r", "disabled_skills": ["docx", "web"]])
    #expect(BotSettingsParams.mcp("r", servers) == ["name": "r", "enabled_mcp_servers": ["github"]])
  }

  @Test func aModelIsSentQualifiedWithItsProviderAndConfirmedOnlyWhenAsked() {
    let choice = BotModelChoice(provider: "second-provider", model: "reasoner-2")

    #expect(
      BotSettingsParams.model("r", choice)
        == ["name": "r", "model": "second-provider/reasoner-2", "provider": "second-provider"])
    #expect(
      BotSettingsParams.model("r", choice, confirmExpensive: true)
        == [
          "name": "r", "model": "second-provider/reasoner-2", "provider": "second-provider",
          "confirm_expensive_model": true
        ])
  }

  @Test func pictureAndReloadParams() {
    #expect(BotSettingsParams.avatar("r", base64: "AAAA") == ["name": "r", "asset": "avatar", "data": "AAAA"])
    #expect(BotSettingsParams.clearAvatar("r") == ["name": "r", "asset": "avatar", "clear": true])
    #expect(BotSettingsParams.reloadMcp() == [:])
    #expect(
      BotSettingsParams.reloadMcp(confirm: true, always: true, sessionID: "s1")
        == ["confirm": true, "always": true, "session_id": "s1"])
    #expect(BotSettingsParams.reloadMcp(sessionID: "") == [:])
  }

  // MARK: Reading the answers

  @Test func aSectionTheGatewayDidNotApplyIsAFailure() {
    #expect(throws: BotSettingsFailure.notApplied) {
      try BotSettingsParams.check(["ok": false, "applied": ["soul": false]], applied: "soul")
    }
    // A section the request carried and the answer leaves out was not written either.
    #expect(throws: BotSettingsFailure.notApplied) {
      try BotSettingsParams.check(["ok": true, "applied": [:]], applied: "soul")
    }
    #expect(throws: Never.self) {
      try BotSettingsParams.check(["ok": true, "applied": ["soul": true]], applied: "soul")
    }
    // An answer that reports nothing is taken at its word.
    #expect(throws: Never.self) {
      try BotSettingsParams.check(["ok": true], applied: "soul")
    }
  }

  @Test func theGatewaysWordForEachSectionIsNotTheParameters() {
    #expect(BotSettingsParams.appliedKey(.toolsets) == "toolsets")
    #expect(BotSettingsParams.appliedKey(.skills) == "skills")
    #expect(BotSettingsParams.appliedKey(.mcp) == "mcp_servers")
  }

  @Test func aGuardedModelAsksBeforeItWrites() throws {
    let asked: JSONValue = [
      "ok": true, "applied": [:], "confirm_required": true, "confirm_message": "Expensive. Continue?"
    ]

    #expect(try BotSettingsParams.modelAnswer(asked) == .confirmationRequired("Expensive. Continue?"))
    #expect(try BotSettingsParams.modelAnswer(["ok": true, "applied": ["model": true]]) == .applied)
    #expect(throws: BotSettingsFailure.notApplied) {
      try BotSettingsParams.modelAnswer(["ok": false, "applied": ["model": false]])
    }
  }

  @Test func theMcpReloadAsksOrDoes() {
    #expect(
      BotSettingsParams.reloadAnswer(["status": "confirm_required", "message": "Cache."])
        == .confirmationRequired("Cache."))
    #expect(BotSettingsParams.reloadAnswer(["status": "reloaded"]) == .reloaded)
    #expect(BotSettingsParams.reloadAnswer([:]) == .reloaded)
  }
}

/// How a call that failed is sorted, because the screen does something different for each.
struct BotSettingsFailureTests {
  private func rejected(_ code: Int?, _ message: String = "no") -> GatewayRPCError {
    GatewayRPCError(.rejected, message, code: code)
  }

  @Test func anAccessDenialPutsTheScreenInReadOnly() {
    for code in [4030, 4031, 4033, 4403] {
      let failure = BotSettingsFailure.classify(rejected(code, "Not for you."))

      #expect(failure == .forbidden("Not for you."))
      #expect(failure.isForbidden)
    }
  }

  @Test func theGatewaysPlainWordsForItAreRecognisedToo() {
    #expect(BotSettingsFailure.classify(rejected(5064, "Forbidden: viewers cannot edit profiles")).isForbidden)
    #expect(BotSettingsFailure.classify(rejected(nil, "permission denied")).isForbidden)
    #expect(!BotSettingsFailure.classify(rejected(5064, "disk full")).isForbidden)
  }

  @Test func aMissingMethodHidesTheSectionInsteadOfBeingAnError() {
    #expect(BotSettingsFailure.classify(rejected(-32601, "unknown method")) == .unsupported)
  }

  @Test func noConnectionIsOfflineWhateverTheWayItWasLost() {
    #expect(BotSettingsFailure.classify(GatewayRPCError(.notConnected, "gateway not connected")) == .offline)
    #expect(BotSettingsFailure.classify(GatewayRPCError(.closed, "WebSocket closed")) == .offline)
    #expect(BotSettingsFailure.classify(GatewayRPCError(.timeout, "timed out")) == .offline)
    #expect(BotSettingsFailure.classify(GatewayError(.network, "down")) == .offline)
  }

  @Test func anUnknownProfileAndAnyOtherRefusalKeepTheGatewaysWords() {
    #expect(BotSettingsFailure.classify(rejected(4064, "profile 'x' not found")) == .notFound("profile 'x' not found"))
    #expect(BotSettingsFailure.classify(rejected(5064, "disk full")) == .refused("disk full"))
    #expect(BotSettingsFailure.classify(GatewayError(.auth, "401")) == .forbidden("401"))
    #expect(BotSettingsFailure.classify(CancellationError()).detail != nil)
  }

  @Test func theDetailIsTheGatewaysOwnWordsAndOnlyWhenItHadSome() {
    #expect(BotSettingsFailure.refused("disk full").detail == "disk full")
    #expect(BotSettingsFailure.refused("").detail == nil)
    #expect(BotSettingsFailure.offline.detail == nil)
    #expect(BotSettingsFailure.unsupported.detail == nil)
  }
}
