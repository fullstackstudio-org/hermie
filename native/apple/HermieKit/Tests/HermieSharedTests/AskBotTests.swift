import Foundation
import Testing

@testable import HermieShared

private let key = "aaaaaaaaaaaaaaaa"
private let other = "bbbbbbbbbbbbbbbb"

private func choice(_ handle: String, _ name: String = "", key: String = key) -> FocusBotChoice {
  FocusBotChoice(bot: FocusFilter.Bot(gatewayKey: key, handle: handle), displayName: name)
}

@Suite("Write to a bot: the link")
struct AskLinkTests {
  @Test("an ask link names the bot and the gateway, like a chat link, under its own kind")
  func building() {
    #expect(DeepLink.ask(bot: "researcher", gatewayKey: key).string == "hermie://ask/researcher?gateway=\(key)")
    #expect(DeepLink.ask(bot: "researcher", gatewayKey: "").string == "hermie://ask/researcher")
    #expect(DeepLink.ask(bot: "code reviewer", gatewayKey: key).string == "hermie://ask/code%20reviewer?gateway=\(key)")
    #expect(DeepLink.ask(bot: "", gatewayKey: key).string == nil)
  }

  @Test("an ask link parses back to the same route, and a chat link stays a chat link")
  func parsing() {
    #expect(DeepLink("hermie://ask/researcher?gateway=\(key)") == .ask(bot: "researcher", gatewayKey: key))
    #expect(DeepLink("hermie://ask/b%C3%B6b") == .ask(bot: "böb", gatewayKey: ""))
    #expect(DeepLink("hermie://chat/researcher?gateway=\(key)") == .chat(bot: "researcher", gatewayKey: key))
    #expect(DeepLink("exp+hermie://ask/researcher") == .ask(bot: "researcher", gatewayKey: ""))
  }

  @Test("an ask link is held to a chat link's rules: one segment, a real name, a valid key")
  func refusals() {
    #expect(DeepLink("hermie://ask/") == nil)
    #expect(DeepLink("hermie://ask") == nil)
    #expect(DeepLink("hermie://ask/researcher/more") == nil)
    #expect(DeepLink("hermie://ask/%2E%2E%2Fadmin") == nil)
    // A gateway key that is not sixteen hex digits is dropped, as on a chat link.
    #expect(DeepLink("hermie://ask/researcher?gateway=nope") == .ask(bot: "researcher", gatewayKey: ""))
    // Words to type are never carried: the parameter is ignored.
    #expect(DeepLink("hermie://ask/researcher?text=hello") == .ask(bot: "researcher", gatewayKey: ""))
  }

  @Test("the intent's bot (gateway key and handle) is turned into the ask link")
  func route() {
    #expect(AskBotRoute.link(forBotIdentifier: "\(key)/researcher") == .ask(bot: "researcher", gatewayKey: key))
    #expect(AskBotRoute.link(forBotIdentifier: "\(other)/b\u{F6}b")?.url?.absoluteString == "hermie://ask/b%C3%B6b?gateway=\(other)")
  }

  @Test("an identifier that is not a gateway key and a handle opens nothing")
  func routeRefusals() {
    #expect(AskBotRoute.link(forBotIdentifier: "researcher") == nil)
    #expect(AskBotRoute.link(forBotIdentifier: "nope/researcher") == nil)
    #expect(AskBotRoute.link(forBotIdentifier: "\(key)/") == nil)
    #expect(AskBotRoute.link(forBotIdentifier: "") == nil)
  }
}

@Suite("Write to a bot: the entity query")
struct AskBotQueryTests {
  private let roster = [
    choice("researcher", "Researcher"), choice("ops", "Ops"), choice("ops-staging", "Ops staging"), choice("scout", "Scout")
  ]

  @Test("the picker lists the roster the widgets read, in its order, by gateway and handle")
  func suggested() throws {
    let container = FileManager.default.temporaryDirectory.appendingPathComponent("ask-\(UUID().uuidString)", isDirectory: true)

    try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: container) }

    let snapshot = WidgetSnapshot(
      generatedAt: 1, gatewayKey: key,
      bots: ["researcher", "ops"].map { name in
        WidgetSnapshot.Bot(
          name: name, displayName: name.capitalized, avatarPath: nil, initials: "X", colour: "#ffffff",
          presence: "idle", lastLine: "", lastAt: 0, unread: 0, needsInput: false)
      })

    try snapshot.encoded().write(to: container.appendingPathComponent(SharedContainer.widgetSnapshotFile))

    let listed = FocusBotChoices.load(container: container)

    #expect(listed.map(\.id) == ["\(key)/researcher", "\(key)/ops"])
    #expect(listed.map(\.displayName) == ["Researcher", "Ops"])
    #expect(FocusBotChoices.load(container: nil).isEmpty, "no container, no bots")
  }

  @Test("a name Siri heard finds the bot, exact first, case aside")
  func matchingExact() {
    #expect(FocusBotChoices.matching("ops", in: roster).map(\.id) == ["\(key)/ops"])
    #expect(FocusBotChoices.matching("  RESEARCHER ", in: roster).map(\.id) == ["\(key)/researcher"])
    #expect(FocusBotChoices.matching("Ops staging", in: roster).map(\.id) == ["\(key)/ops-staging"])
  }

  @Test("words that are not a whole name offer every bot that holds them, in the roster's order")
  func matchingPartial() {
    #expect(FocusBotChoices.matching("o", in: roster).map(\.id) == ["\(key)/ops", "\(key)/ops-staging", "\(key)/scout"])
    #expect(FocusBotChoices.matching("stag", in: roster).map(\.id) == ["\(key)/ops-staging"])
    #expect(FocusBotChoices.matching("nobody", in: roster).isEmpty)
  }

  @Test("no words offer the whole roster")
  func matchingEmpty() {
    #expect(FocusBotChoices.matching("", in: roster) == roster)
    #expect(FocusBotChoices.matching("   ", in: roster) == roster)
  }

  @Test("a bot chosen once that has left the roster still resolves, by its handle")
  func resolvesTheGone() {
    let resolved = FocusBotChoices.resolve(["\(other)/retired", "\(key)/ops", "garbage"], in: roster)

    #expect(resolved.map(\.id) == ["\(other)/retired", "\(key)/ops"])
    #expect(resolved.first.flatMap { AskBotRoute.link(forBotIdentifier: $0.id) } == .ask(bot: "retired", gatewayKey: other))
  }
}
