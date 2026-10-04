import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// `commands.catalog` as `hermes serve` 0.21.3 answers it (and the fake gateway with it): every key
/// WITH its slash, descriptions that end in `(usage: …)`, a skill both a pair and a `skills` key,
/// and an alias only in `canon` and `commands`.
enum SlashFixture {
  static let catalog: JSONValue = [
    "pairs": [
      ["/model", "Switch model (session-scoped; --global to persist) (usage: /model [model])"],
      ["/reasoning", "Set the reasoning effort (usage: /reasoning [low|medium|high])"],
      ["/status", "Show session, model, token, and context info"],
      ["/help", "Show available commands (usage: /help [skills|<filter>])"],
      ["/yolo", "Toggle YOLO mode (skip all dangerous command approvals)"],
      ["/queue", "Queue a prompt for the next turn (usage: /queue [<prompt>|list])"],
      ["/release-notes", "Draft release notes"],
      ["/docx", "Work with Word documents"]
    ],
    "sub": ["/queue": ["list", "edit", "rm", "clear"]],
    "canon": [
      "/model": "/model", "/reasoning": "/reasoning", "/status": "/status", "/help": "/help", "/yolo": "/yolo",
      "/queue": "/queue", "/q": "/queue"
    ],
    "commands": [
      "/model": ["argument_mode": "mixed", "desktop": nil],
      "/reasoning": ["argument_mode": "options", "desktop": nil],
      "/status": ["argument_mode": nil, "desktop": nil],
      "/help": ["argument_mode": "text", "desktop": nil],
      "/yolo": ["argument_mode": nil, "desktop": nil],
      "/queue": ["argument_mode": "text", "desktop": nil],
      "/q": ["argument_mode": "text", "desktop": nil]
    ],
    "categories": [
      ["name": "Session", "pairs": [["/status", "Show session, model, token, and context info"]]]
    ],
    "skills": [
      "/release-notes": ["usage": 0, "origin": "bundled"],
      "/docx": ["usage": 9, "origin": "bundled"]
    ],
    "skill_count": 2,
    "warning": ""
  ]

  static var parsed: SlashCatalog { SlashCatalog(json: catalog) }
}

@Suite struct SlashLineTests {
  @Test func aLineSplitsIntoANameAndAnArgument() {
    #expect(SlashLine(parsing: "/model gpt-5") == SlashLine(name: "model", argument: "gpt-5"))
    #expect(SlashLine(parsing: "/MODEL   gpt-5  ") == SlashLine(name: "model", argument: "gpt-5"))
    #expect(SlashLine(parsing: "/status") == SlashLine(name: "status"))
    #expect(SlashLine(parsing: "model") == SlashLine(name: "model"), "a missing slash is tolerated")
  }

  @Test func theArgumentMaySpanLinesAndKeepsItsInterior() {
    let line = SlashLine(parsing: "/goal fix it\n\n  and then\n    this")
    #expect(line.name == "goal")
    #expect(line.argument == "fix it\n\n  and then\n    this")
  }

  @Test func nothingBeforeTheNameIsACommandWithoutOne() {
    #expect(SlashLine(parsing: "/").name.isEmpty)
    #expect(SlashLine(parsing: "/   ").name.isEmpty)
    #expect(SlashLine(parsing: "/ words").name.isEmpty)
    #expect(SlashLine(parsing: "").name.isEmpty)
  }

  @Test func onlyASlashFirstFollowedByABareNameIsACommand() {
    #expect(SlashLine.looksLikeCommand("/"))
    #expect(SlashLine.looksLikeCommand("/model"))
    #expect(SlashLine.looksLikeCommand("/model gpt-5"))
    #expect(SlashLine.looksLikeCommand("/ words"))
    #expect(!SlashLine.looksLikeCommand("/usr/local/bin"))
    #expect(!SlashLine.looksLikeCommand("//model"))
    #expect(!SlashLine.looksLikeCommand("run /clean"))
    #expect(!SlashLine.looksLikeCommand("hello"))
    #expect(!SlashLine.looksLikeCommand(""))
  }
}

@Suite struct SlashStageTests {
  @Test func aCommandBeingWrittenIsOnItsNameThenItsArgument() {
    #expect(SlashStage(draft: "/") == .name(query: ""))
    #expect(SlashStage(draft: "/mo") == .name(query: "mo"))
    #expect(SlashStage(draft: "/model ") == .argument(command: "model", typed: "/model "))
    #expect(SlashStage(draft: "/Model gpt") == .argument(command: "model", typed: "/Model gpt"))
  }

  @Test func prosePastesAndPathsAreNotCommandsBeingWritten() {
    #expect(SlashStage(draft: "hello") == nil)
    #expect(SlashStage(draft: "") == nil)
    #expect(SlashStage(draft: "/usr/local") == nil)
    #expect(SlashStage(draft: "/ words") == nil)
    #expect(SlashStage(draft: "/goal one\ntwo") == nil, "a line break ends it: a pasted paragraph")
  }
}

@Suite struct SlashRoutingTests {
  @Test func theConversationCommandsAreTheAppsOwnWithOrWithoutACatalogue() {
    for name in ["new", "reset", "clear", "NEW"] {
      #expect(SlashRouting.route(for: name, in: nil) == .local)
      #expect(SlashRouting.route(for: name, in: SlashFixture.parsed) == .local)
    }
  }

  @Test func aSkillGoesToDispatchAndACommandToExec() {
    let catalog = SlashFixture.parsed
    #expect(SlashRouting.route(for: "docx", in: catalog) == .dispatch)
    #expect(SlashRouting.route(for: "release-notes", in: catalog) == .dispatch)
    #expect(SlashRouting.route(for: "model", in: catalog) == .exec)
    #expect(SlashRouting.route(for: "MODEL", in: catalog) == .exec)
    #expect(SlashRouting.route(for: "q", in: catalog) == .exec, "an alias is the command")
  }

  @Test func anUnknownNameIsProseAndABlankOneToo() {
    let catalog = SlashFixture.parsed
    #expect(SlashRouting.route(for: "usr", in: catalog) == nil)
    #expect(SlashRouting.route(for: "", in: catalog) == nil)
    #expect(SlashRouting.route(for: "model", in: nil) == nil, "before the catalogue arrives it is prose")
  }

  @Test func statusIsLocalOnlyWhereTheCatalogueDoesNotListIt() {
    #expect(SlashRouting.route(for: "status", in: SlashFixture.parsed) == .exec)
    #expect(SlashRouting.route(for: "status", in: SlashCatalog(commands: [])) == .local)
    #expect(SlashRouting.route(for: "status", in: nil) == nil)
  }
}

@Suite struct SlashCatalogTests {
  @Test func theCommandsComeInTheGatewaysOrderAndTheSkillsAfterThemMostUsedFirst() {
    let catalog = SlashFixture.parsed
    #expect(
      catalog.commands.map(\.name) == ["model", "reasoning", "status", "help", "yolo", "queue", "docx", "release-notes"])
    #expect(catalog.commands.filter { $0.kind == .skill }.map(\.name) == ["docx", "release-notes"])
  }

  @Test func theUsageLineBecomesAnArgumentHintAndLeavesTheSummary() {
    let model = SlashFixture.parsed.command(named: "model")
    #expect(model?.summary == "Switch model (session-scoped; --global to persist)")
    #expect(model?.usage == "[model]")
    #expect(model?.argumentMode == .mixed)
    #expect(SlashFixture.parsed.command(named: "reasoning")?.usage == "[low|medium|high]")
    #expect(SlashFixture.parsed.command(named: "status")?.usage == nil)
    #expect(SlashFixture.parsed.command(named: "status")?.summary == "Show session, model, token, and context info")
  }

  @Test func aUsageThatIsOnlyTheNameSaysNothing() {
    let parts = SlashCatalog.split(description: "Show it (usage: /show)", name: "show")
    #expect(parts.summary == "Show it")
    #expect(parts.usage == nil)
    #expect(SlashCatalog.split(description: "Plain", name: "x").summary == "Plain")
  }

  @Test func anAliasIsTheCommandItsCanonSaysItIs() {
    let catalog = SlashFixture.parsed
    #expect(catalog.command(named: "q")?.name == "queue")
    #expect(catalog.command(named: "/Q")?.name == "queue")
    #expect(catalog.command(named: "queue")?.aliases == ["q"])
    #expect(catalog.command(named: "queue")?.subcommands == ["list", "edit", "rm", "clear"])
    #expect(!catalog.commands.contains { $0.name == "q" }, "listed once, under its own name")
  }

  @Test func aCatalogueMissingPartsIsASmallerOneNotAnError() {
    #expect(SlashCatalog(json: [:]).commands.isEmpty)
    #expect(SlashCatalog(json: .null).commands.isEmpty)

    // A gateway that sent only categories still lists everything.
    let categories = SlashCatalog(
      json: ["categories": [["name": "A", "pairs": [["/one", "First"], ["/two", "Second"]]]]])
    #expect(categories.commands.map(\.name) == ["one", "two"])

    // Names with or without the slash, case ignored.
    let bare = SlashCatalog(json: ["pairs": [["Plain", "No slash"]], "skills": ["Other": ["usage": 1]]])
    #expect(bare.commands.map(\.name) == ["plain", "other"])
  }

  @Test func theNamesAreNotReadAsMarkup() {
    let hostile = SlashCatalog(json: ["pairs": [["/**bold**", "<b>x</b> [link](http://evil.invalid)"]]])
    #expect(hostile.commands.first?.name == "**bold**")
    #expect(hostile.commands.first?.summary == "<b>x</b> [link](http://evil.invalid)")
  }
}

@Suite struct SlashSuggestionTests {
  private let catalog = SlashFixture.parsed

  @Test func aBareSlashListsEveryCommandThenTheSkills() {
    let all = catalog.suggestions(matching: "")
    #expect(all.map(\.label).first == "/model")
    #expect(all.count == catalog.commands.count)
    #expect(all.last?.kind == .skill)
  }

  @Test func aPrefixNarrowsTheListAndAcceptingInsertsTheNameAndASpace() {
    let narrowed = catalog.suggestions(matching: "mo")
    #expect(narrowed.map(\.label) == ["/model"])
    #expect(narrowed.first?.insert == "/model ")
    #expect(narrowed.first?.hint == "[model]")
    #expect(narrowed.first?.detail == "Switch model (session-scoped; --global to persist)")
  }

  @Test func theExactNameRanksFirstThenPrefixesThenAliasesThenContainedNames() {
    let named = SlashCatalog(
      commands: [
        SlashCommand(name: "reload"),
        SlashCommand(name: "load"),
        SlashCommand(name: "preload"),
        SlashCommand(name: "queue", aliases: ["lo"]),
        SlashCommand(name: "zoom", summary: "Load a lot")
      ])

    #expect(named.suggestions(matching: "lo").map(\.label) == ["/load", "/queue", "/reload", "/preload"])
    #expect(named.suggestions(matching: "lo").first { $0.label == "/queue" }?.alias == "/lo")
    #expect(named.suggestions(matching: "load").map(\.label).first == "/load", "the exact name first")
  }

  @Test func aDescriptionIsOnlyAFallbackForWhenNoNameMatches() {
    // `/mo` is `/model`, not every command whose description mentions a mode.
    #expect(catalog.suggestions(matching: "mo").map(\.label) == ["/model"])

    let described = SlashCatalog(commands: [SlashCommand(name: "zoom", summary: "Load a lot")])
    #expect(described.suggestions(matching: "lo").map(\.label) == ["/zoom"])
  }

  @Test func anAliasFindsItsCommandAndInsertsTheCommandsOwnName() {
    let found = catalog.suggestions(matching: "q")
    #expect(found.map(\.label) == ["/queue"])
    #expect(found.first?.insert == "/queue ")
  }

  @Test func aDescriptionIsSearchedOnlyFromTwoLetters() {
    #expect(catalog.suggestions(matching: "effort").map(\.label) == ["/reasoning"])
    #expect(catalog.suggestions(matching: "w").isEmpty, "one letter: names only")
  }

  @Test func aSkillIsMarkedAndNothingMatchingIsAnEmptyList() {
    #expect(catalog.suggestions(matching: "doc").first?.kind == .skill)
    #expect(catalog.suggestions(matching: "zzz").isEmpty)
  }

  @Test func theListIsCapped() {
    #expect(catalog.suggestions(matching: "", limit: 3).count == 3)
  }

  @Test func theWordsAfterACommandAreItsSubcommandsThatBeginWithWhatIsTyped() {
    #expect(
      catalog.subcommandSuggestions(for: "queue", argument: "").map(\.insert)
        == ["/queue list ", "/queue edit ", "/queue rm ", "/queue clear "])
    #expect(catalog.subcommandSuggestions(for: "q", argument: "L").map(\.label) == ["list"])
    #expect(catalog.subcommandSuggestions(for: "status", argument: "").isEmpty)
  }

  @Test func theLineUnderTheListSaysWhatACommandTakes() {
    let hint = catalog.argumentHint(for: "model")
    #expect(hint?.command == "/model")
    #expect(hint?.usage == "[model]")
    #expect(catalog.argumentHint(for: "status") == nil, "nothing follows it")
    #expect(catalog.argumentHint(for: "nonsense") == nil)
    #expect(catalog.argumentHint(for: "queue")?.mode == .text)
  }
}

@Suite struct SlashDirectiveTests {
  @Test func eachTypeIsReadAndAnythingElseIsPlainOutput() {
    #expect(SlashDirective(json: ["type": "exec", "output": "hi"]) == .exec(output: "hi"))
    #expect(SlashDirective(json: ["type": "plugin"]) == .exec(output: nil))
    #expect(SlashDirective(json: ["type": "alias", "target": "/queue"]) == .alias(target: "/queue"))
    #expect(SlashDirective(json: ["type": "prefill", "message": "words"]) == .prefill(message: "words"))
    #expect(
      SlashDirective(json: ["type": "send", "message": "list", "display": "/queue list"])
        == .send(message: "list", display: "/queue list"))
    #expect(
      SlashDirective(json: ["type": "skill", "name": "docx", "message": "body", "display": "/docx"])
        == .skill(message: "body", display: "/docx"))
  }

  @Test func aPayloadMissingAFieldItNeedsOrOfAnUnknownTypeIsNotADirective() {
    #expect(SlashDirective(json: ["type": "alias"]) == nil)
    #expect(SlashDirective(json: ["type": "prefill"]) == nil)
    #expect(SlashDirective(json: ["type": "send"]) == nil)
    #expect(SlashDirective(json: ["type": "skill"]) == nil)
    #expect(SlashDirective(json: ["type": "teleport", "message": "x"]) == nil)
    #expect(SlashDirective(json: ["output": "just text"]) == nil)
    #expect(SlashDirective(json: "text") == nil)
    #expect(SlashDirective(json: .null) == nil)
  }
}
