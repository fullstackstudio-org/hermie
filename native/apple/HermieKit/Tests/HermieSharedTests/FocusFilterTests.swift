import Foundation
import Testing

@testable import HermieShared

private let keyA = "1111111111111111"
private let keyB = "2222222222222222"

private func scratch() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("focus-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)

  return url
}

/// A snapshot as the app writes it, with `names` as the roster.
private func snapshot(key: String? = keyA, _ names: [String]) -> WidgetSnapshot {
  WidgetSnapshot(
    generatedAt: 1,
    gatewayKey: key,
    bots: names.map { name in
      WidgetSnapshot.Bot(
        name: name, displayName: name.capitalized, avatarPath: nil, initials: "X", colour: "#ffffff",
        presence: "idle", lastLine: "", lastAt: 0, unread: 0, needsInput: false)
    })
}

@Suite("Focus filter matching")
struct FocusFilterMatchingTests {
  private let scout = FocusFilter.Bot(gatewayKey: keyA, handle: "scout")
  private let ops = FocusFilter.Bot(gatewayKey: keyA, handle: "ops")

  @Test("no filter lets everything through, and is not active")
  func unfiltered() {
    let filter = FocusFilter.unfiltered

    #expect(!filter.isActive)
    #expect(filter.allows(gatewayKey: keyA, bot: "scout", urgent: false))
    #expect(filter.allows(gatewayKey: keyB, bot: "anyone", urgent: true))
  }

  @Test("all bots lets every bot through")
  func allBots() {
    let filter = FocusFilter(scope: .all, bots: [scout], urgentOnly: false)

    #expect(filter.allows(gatewayKey: keyA, bot: "ops", urgent: false))
    #expect(filter.allows(gatewayKey: keyB, bot: "ops", urgent: true))
  }

  @Test("chosen bots lets only those through, by gateway and handle")
  func chosenBots() {
    let filter = FocusFilter(scope: .chosen, bots: [scout], urgentOnly: false)

    #expect(filter.isActive)
    #expect(filter.allows(gatewayKey: keyA, bot: "scout", urgent: false))
    #expect(!filter.allows(gatewayKey: keyA, bot: "ops", urgent: true))
    #expect(!filter.allows(gatewayKey: keyB, bot: "scout", urgent: true), "the same handle on another gateway is another bot")
    #expect(!filter.allows(gatewayKey: keyA, bot: "Scout", urgent: false), "handles are exact")
  }

  @Test("chosen with nobody chosen lets nothing through")
  func chosenNobody() {
    let filter = FocusFilter(scope: .chosen, bots: [], urgentOnly: false)

    #expect(!filter.allows(gatewayKey: keyA, bot: "scout", urgent: true))
  }

  @Test("no bots lets nothing through, urgent or not")
  func noBots() {
    let filter = FocusFilter(scope: .none, bots: [scout], urgentOnly: false)

    #expect(filter.isActive)
    #expect(!filter.allows(gatewayKey: keyA, bot: "scout", urgent: false))
    #expect(!filter.allows(gatewayKey: keyA, bot: "scout", urgent: true))
  }

  @Test("only urgent requests lets urgent ones through from every bot")
  func urgentOnly() {
    let filter = FocusFilter(scope: .all, bots: [], urgentOnly: true)

    #expect(filter.isActive)
    #expect(filter.allows(gatewayKey: keyA, bot: "ops", urgent: true))
    #expect(!filter.allows(gatewayKey: keyA, bot: "ops", urgent: false))
  }

  @Test("chosen bots and only urgent requests must both hold")
  func chosenAndUrgent() {
    let filter = FocusFilter(scope: .chosen, bots: [scout], urgentOnly: true)

    #expect(filter.allows(gatewayKey: keyA, bot: "scout", urgent: true))
    #expect(!filter.allows(gatewayKey: keyA, bot: "scout", urgent: false))
    #expect(!filter.allows(gatewayKey: keyA, bot: "ops", urgent: true))
  }

  @Test("only urgent requests with no bots still lets nothing through")
  func noneAndUrgent() {
    #expect(!FocusFilter(scope: .none, bots: [], urgentOnly: true).allows(gatewayKey: keyA, bot: "scout", urgent: true))
  }
}

@Suite("Focus filter storage")
struct FocusFilterStoreTests {
  @Test("nothing stored is no filter")
  func nothing() throws {
    let store = FocusFilterStore(directory: try scratch())

    #expect(store.load() == .unfiltered)
  }

  @Test("a filter is stored and read back")
  func roundTrip() throws {
    let store = FocusFilterStore(directory: try scratch())
    let filter = FocusFilter(
      scope: .chosen, bots: [FocusFilter.Bot(gatewayKey: keyA, handle: "scout")], urgentOnly: true)

    #expect(store.save(filter))
    #expect(store.load() == filter)
  }

  @Test("the unfiltered state removes the file, so no filter and never set are the same")
  func unfilteredRemoves() throws {
    let store = FocusFilterStore(directory: try scratch())

    #expect(store.save(FocusFilter(scope: .none)))
    #expect(FileManager.default.fileExists(atPath: store.fileURL.path))

    #expect(store.save(.unfiltered))
    #expect(!FileManager.default.fileExists(atPath: store.fileURL.path))
    #expect(store.load() == .unfiltered)
    #expect(store.clear(), "clearing what is not there is fine")
  }

  @Test("what cannot be read is no filter, never a request swallowed")
  func unreadable() throws {
    let store = FocusFilterStore(directory: try scratch())

    try Data("not json".utf8).write(to: store.fileURL)
    #expect(store.load() == .unfiltered)

    try Data(#"{"version":2,"scope":"none"}"#.utf8).write(to: store.fileURL)
    #expect(store.load() == .unfiltered, "a version this build does not know")

    try Data(#"{"scope":"none"}"#.utf8).write(to: store.fileURL)
    #expect(store.load() == .unfiltered, "no version")

    try Data(repeating: 0x20, count: FocusFilterStore.maxBytes + 1).write(to: store.fileURL)
    #expect(store.load() == .unfiltered, "too large")
  }

  @Test("a field that is missing or wrong takes its default")
  func tolerant() throws {
    let store = FocusFilterStore(directory: try scratch())

    try Data(#"{"version":1,"scope":"chosen"}"#.utf8).write(to: store.fileURL)
    #expect(store.load() == FocusFilter(scope: .chosen, bots: [], urgentOnly: false))

    try Data(#"{"version":1,"scope":"everyone","urgentOnly":true,"bots":"x"}"#.utf8).write(to: store.fileURL)
    #expect(store.load() == FocusFilter(scope: .all, bots: [], urgentOnly: true))
  }

  @Test("the file lives in the container under the name the app and the intent share")
  func fileName() throws {
    let directory = try scratch()

    #expect(FocusFilterStore(directory: directory).fileURL.lastPathComponent == "focus-filter.json")
    #expect(SharedContainer.focusFilterFile == "focus-filter.json")
  }
}

/// What the Focus filter intent does when the system performs it: `perform()` is
/// `FocusFilterStore.system()?.apply(scope:botIdentifiers:urgentOnly:)` over what was picked.
@Suite("Focus filter intent")
struct FocusFilterIntentTests {
  @Test("performing with the chosen bots stores them, by gateway and handle")
  func storesTheChoice() throws {
    let store = FocusFilterStore(directory: try scratch())

    #expect(store.apply(scope: .chosen, botIdentifiers: ["\(keyA)/scout", "\(keyB)/ops"], urgentOnly: false))

    #expect(
      store.load()
        == FocusFilter(
          scope: .chosen,
          bots: [FocusFilter.Bot(gatewayKey: keyA, handle: "scout"), FocusFilter.Bot(gatewayKey: keyB, handle: "ops")],
          urgentOnly: false))
  }

  @Test("performing with no bots, or only urgent requests, stores that")
  func storesTheOthers() throws {
    let store = FocusFilterStore(directory: try scratch())

    store.apply(scope: .none, botIdentifiers: [], urgentOnly: false)
    #expect(store.load() == FocusFilter(scope: .none))

    store.apply(scope: .all, botIdentifiers: [], urgentOnly: true)
    #expect(store.load() == FocusFilter(scope: .all, urgentOnly: true))
  }

  @Test("performing again replaces the filter, and the defaults (the Focus turning off) remove it")
  func replacesAndClears() throws {
    let store = FocusFilterStore(directory: try scratch())

    store.apply(scope: .none, botIdentifiers: [], urgentOnly: false)
    store.apply(scope: .chosen, botIdentifiers: ["\(keyA)/scout"], urgentOnly: false)
    #expect(store.load().scope == .chosen)

    store.apply(scope: .all, botIdentifiers: [], urgentOnly: false)
    #expect(store.load() == .unfiltered)
    #expect(!FileManager.default.fileExists(atPath: store.fileURL.path))
  }

  @Test("an identifier that names no bot is dropped, and a bot named twice is kept once")
  func dropsWhatIsNotABot() throws {
    let store = FocusFilterStore(directory: try scratch())

    store.apply(
      scope: .chosen,
      botIdentifiers: ["scout", "nokey/scout", "\(keyA)/", "\(keyA)/a..b/c", "\(keyA)/scout", "\(keyA)/scout"],
      urgentOnly: false)

    #expect(store.load().bots == [FocusFilter.Bot(gatewayKey: keyA, handle: "scout")])
  }

  @Test("a bot's identifier is its gateway key, a slash and its handle, and reads back")
  func identifiers() {
    let bot = FocusFilter.Bot(gatewayKey: keyA, handle: "scout")

    #expect(bot.id == "\(keyA)/scout")
    #expect(FocusFilter.Bot(id: bot.id) == bot)
    #expect(FocusFilter.Bot(id: "\(keyA)/") == nil)
    #expect(FocusFilter.Bot(id: "ABCDEF0123456789/scout") == nil, "a gateway key is lowercase hex")
  }
}

@Suite("Focus filter bots")
struct FocusBotChoicesTests {
  @Test("the picker lists the roster of the snapshot, in its order, by gateway and handle")
  func listsTheRoster() {
    let choices = FocusBotChoices.list(in: snapshot(["scout", "ops", "researcher"]))

    #expect(choices.map(\.id) == ["\(keyA)/scout", "\(keyA)/ops", "\(keyA)/researcher"])
    #expect(choices.map(\.displayName) == ["Scout", "Ops", "Researcher"])
    #expect(choices.allSatisfy { $0.bot.gatewayKey == keyA })
  }

  @Test("a snapshot without a gateway, or no snapshot, lists nobody")
  func nothingToList() {
    #expect(FocusBotChoices.list(in: nil).isEmpty)
    #expect(FocusBotChoices.list(in: snapshot(key: nil, ["scout"])).isEmpty)
    #expect(FocusBotChoices.list(in: snapshot(key: "not-a-key", ["scout"])).isEmpty)
  }

  @Test("a handle a link could not carry is left out, and a repeated one is listed once")
  func leavesOutWhatIsNotABot() {
    let choices = FocusBotChoices.list(in: snapshot(["scout", "a/b", "", "..", "scout"]))

    #expect(choices.map(\.bot.handle) == ["scout"])
  }

  @Test("a bot with no display name shows its handle")
  func displayNameFallsBack() {
    #expect(FocusBotChoice(bot: FocusFilter.Bot(gatewayKey: keyA, handle: "scout"), displayName: "").displayName == "scout")
  }

  @Test("the roster is read from the container's widget snapshot, and an unreadable one lists nobody")
  func loadsFromTheContainer() throws {
    let directory = try scratch()

    #expect(FocusBotChoices.load(container: directory).isEmpty, "the app has not run yet")
    #expect(FocusBotChoices.load(container: nil).isEmpty, "no App Group")

    let file = directory.appendingPathComponent(SharedContainer.widgetSnapshotFile)
    try snapshot(["scout", "ops"]).encoded().write(to: file)
    #expect(FocusBotChoices.load(container: directory).map(\.id) == ["\(keyA)/scout", "\(keyA)/ops"])

    try Data("{".utf8).write(to: file)
    #expect(FocusBotChoices.load(container: directory).isEmpty)

    try Data(#"{"version":99,"bots":[]}"#.utf8).write(to: file)
    #expect(FocusBotChoices.load(container: directory).isEmpty, "a snapshot of another version")
  }

  @Test("identifiers resolve to the roster's bots, and a bot the roster lost is kept under its handle")
  func resolves() {
    let choices = FocusBotChoices.list(in: snapshot(["scout"]))
    let resolved = FocusBotChoices.resolve(["\(keyA)/scout", "\(keyB)/gone", "garbage"], in: choices)

    #expect(resolved.map(\.id) == ["\(keyA)/scout", "\(keyB)/gone"])
    #expect(resolved.map(\.displayName) == ["Scout", "gone"])
  }
}
