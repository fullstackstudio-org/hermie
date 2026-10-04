import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

// MARK: - The title family

struct OwnChatTitleTests {
  @Test func theLeadIsTheDisplayNameElseTheUserID() {
    #expect(OwnChatTitle.lead(for: OwnChatIdentity(userID: "u-1", displayName: "Ada Lovelace")) == "Chat · Ada Lovelace")
    #expect(OwnChatTitle.lead(for: OwnChatIdentity(userID: "u-1", displayName: "  ")) == "Chat · u-1")
    #expect(OwnChatTitle.lead(for: OwnChatIdentity(userID: "owner")) == "Chat · owner")
  }

  @Test func withNobodyNamedThereIsNoLead() {
    #expect(OwnChatTitle.lead(for: nil) == "")
    #expect(OwnChatTitle.lead(for: OwnChatIdentity(userID: "  ", displayName: "Ada")) == "")
  }

  @Test func whitespaceInANameIsCollapsedSoTwoDevicesWriteTheSameTitle() {
    #expect(OwnChatTitle.lead(for: OwnChatIdentity(userID: "u", displayName: "Ada \n  Lovelace")) == "Chat · Ada Lovelace")
  }

  @Test func aLongNameIsCutOnAWordAndAnEndlessWordOnTheBudget() {
    let words = Array(repeating: "wordy", count: 20).joined(separator: " ")
    let cut = OwnChatTitle.lead(for: OwnChatIdentity(userID: "u", displayName: words))

    #expect(cut.hasPrefix("Chat · wordy wordy"))
    #expect(cut.count <= OwnChatTitle.leadPrefix.count + OwnChatTitle.leadNameLimit)
    #expect(!cut.hasSuffix(" "))

    let endless = OwnChatTitle.lead(for: OwnChatIdentity(userID: "u", displayName: String(repeating: "x", count: 80)))

    #expect(endless == OwnChatTitle.leadPrefix + String(repeating: "x", count: OwnChatTitle.leadNameLimit))
  }

  @Test func aTitleIsTheLeadAndALabelAndABareLeadIsLegal() {
    #expect(OwnChatTitle.title(lead: "Chat · Ada", label: "Trip planning") == "Chat · Ada · Trip planning")
    #expect(OwnChatTitle.title(lead: "Chat · Ada", label: "  ") == "Chat · Ada")
    #expect(OwnChatTitle.title(lead: "", label: "Trip") == "")
  }

  @Test func theSeparatorKeepsOneReadersChatsFromAnothers() {
    #expect(OwnChatTitle.isOwn("Chat · Ada", lead: "Chat · Ada"))
    #expect(OwnChatTitle.isOwn("Chat · Ada · Trip planning", lead: "Chat · Ada"))
    #expect(!OwnChatTitle.isOwn("Chat · Adam", lead: "Chat · Ada"))
    #expect(!OwnChatTitle.isOwn("Chat · Adam · Trip", lead: "Chat · Ada"))
    #expect(!OwnChatTitle.isOwn("Bot Chat", lead: "Chat · Ada"))
    #expect(!OwnChatTitle.isOwn("Chat · Ada", lead: ""))
  }

  @Test func theLabelIsReadBackAndTheBareLeadHasNone() {
    #expect(OwnChatTitle.label(of: "Chat · Ada · Trip planning", lead: "Chat · Ada") == "Trip planning")
    #expect(OwnChatTitle.label(of: "Chat · Ada", lead: "Chat · Ada") == "")
    #expect(OwnChatTitle.label(of: "Chat · Adam · Trip", lead: "Chat · Ada") == "")
  }

  @Test func aLabelIsCutAndNumbered() {
    #expect(OwnChatTitle.cutLabel("  Trip   planning ") == "Trip planning")
    #expect(OwnChatTitle.cutLabel(String(repeating: "a", count: 80)).count == OwnChatTitle.labelLimit)
    #expect(OwnChatTitle.numbered("Ideas", 2) == "Ideas (2)")
    #expect(OwnChatTitle.numbered(String(repeating: "a", count: 60), 2).count == OwnChatTitle.labelLimit)
  }

  @Test func theStampIsTheMinuteAndAClashAddsTheSeconds() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    // 2026-09-21 23:16:08 UTC.
    let moment = 1_790_032_568_000.0

    #expect(OwnChatTitle.stamp(at: moment, calendar: calendar) == "2026-09-21 23:16")
    #expect(OwnChatTitle.stamp(at: moment, seconds: true, calendar: calendar) == "2026-09-21 23:16:08")
  }
}

// MARK: - Where the reader's memory puts a bot

struct OwnChatMemoryTests {
  @Test func theMemoryIsReadOffTheAppSection() {
    let arrangement = ChatListArrangement(
      documents: UIMetaDocuments(
        app: [
          "v": 1, "current": ["writer": "stored-9", "": "x", "bad": 3, "empty": ""],
          "myChats": ["writer", "scout", 4, ""]
        ]))

    #expect(arrangement.target(of: "writer") == .chat("stored-9"))
    // A build that kept no id: the bare-lead chat, found by its title.
    #expect(arrangement.target(of: "scout") == .legacy)
    #expect(arrangement.target(of: "researcher") == .shared)
    #expect(arrangement.target(of: "bad") == .shared)
    #expect(arrangement.target(of: "empty") == .shared)
  }

  @Test func choosingAnOwnChatWritesTheIDAndTheProjectionOlderBuildsRead() {
    var app: JSONObject = ["v": 1, "pinned": ["writer"]]

    ChatListArrangement.setCurrent("writer", storedID: "stored-9", in: &app)
    ChatListArrangement.setCurrent("scout", storedID: "stored-3", in: &app)

    #expect(app["current"] == ["writer": "stored-9", "scout": "stored-3"])
    #expect(app["myChats"] == ["writer", "scout"])
    #expect(app["pinned"] == ["writer"])

    // Another chat on the same bot moves the id and leaves the projection as it is.
    ChatListArrangement.setCurrent("writer", storedID: "stored-10", in: &app)
    #expect(app["current"] == ["writer": "stored-10", "scout": "stored-3"])
    #expect(app["myChats"] == ["writer", "scout"])
  }

  @Test func theSharedChatIsTheAbsenceOfAChoiceAndClearsALegacyEntryToo() {
    var app: JSONObject = ["v": 1, "current": ["writer": "stored-9"], "myChats": ["writer", "scout"]]

    ChatListArrangement.setCurrent("writer", storedID: nil, in: &app)
    ChatListArrangement.setCurrent("scout", storedID: nil, in: &app)

    #expect(app["current"] == [:])
    #expect(app["myChats"] == [])
  }

  @MainActor
  @Test func theChoiceReachesTheOtherDeviceAndTheSameAnswerIsNoChange() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })

    phone.attach(phoneSync)
    mac.attach(macSync)
    await phoneSync.reconcile()
    await macSync.reconcile()

    phone.setCurrent("writer", "stored-9")
    #expect(phone.target(of: "writer") == .chat("stored-9"), "painted at once")

    await phoneSync.reconcile()
    await macSync.reconcile()
    await botSettingsEventually("the Mac to follow") { mac.target(of: "writer") == .chat("stored-9") }

    // Back to the shared chat on the Mac; the phone follows.
    mac.setCurrent("writer", nil)
    await macSync.reconcile()
    await phoneSync.reconcile()
    await botSettingsEventually("the phone to follow") { phone.target(of: "writer") == .shared }
  }

  @MainActor
  @Test func withoutASyncNothingIsRemembered() {
    let model = ChatArrangementModel(now: { noon })

    model.setCurrent("writer", "stored-9")

    #expect(model.target(of: "writer") == .shared)
  }
}

// MARK: - Telling an own chat from the rest in a listing

struct OwnChatClassifierTests {
  private func row(_ id: String, _ title: String, started: Double = 0) -> SessionListRow {
    SessionListRow(json: ["id": .string(id), "title": .string(title), "started_at": .number(started)])
  }

  @Test func theReadersOwnChatsAreAGroupOfTheirOwnNewestFirst() {
    let groups = ConversationClassifier.classify(
      rows: [
        row("s-bot", "Bot Chat", started: 5),
        row("s-mine-1", "Chat · Ada", started: 10),
        row("s-mine-2", "Chat · Ada · Trip planning", started: 30),
        row("s-other", "Chat · Adam · Trip", started: 20),
        row("s-branch", "Branch · an idea", started: 15)
      ],
      ownLead: "Chat · Ada")

    #expect(groups.canonical?.id == "s-bot")
    #expect(groups.mine.map(\.id) == ["s-mine-2", "s-mine-1"])
    #expect(groups.mine.allSatisfy { $0.kind == .mine })
    // Somebody else's chat is a past conversation to this reader.
    #expect(groups.past.map(\.id) == ["s-other"])
    #expect(groups.branches.map(\.id) == ["s-branch"])
    #expect(groups.all.count == 5)
  }

  @Test func withNobodyNamedNoRowIsOwn() {
    let groups = ConversationClassifier.classify(rows: [row("s-1", "Chat · Ada")], ownLead: "")

    #expect(groups.mine.isEmpty)
    #expect(groups.past.map(\.id) == ["s-1"])
  }

  @Test func theCanonicalRowIsNeverOwnWhateverItsTitle() {
    let groups = ConversationClassifier.classify(
      rows: [row("s-1", "Chat · Ada")], canonicalID: "s-1", ownLead: "Chat · Ada")

    #expect(groups.canonical?.id == "s-1")
    #expect(groups.mine.isEmpty)
  }

  @Test func anOwnChatCanBeOpenedContinuedAndDeletedButNeverRenamedOrMadeTheBotChat() {
    let own = Conversation(id: "s-1", title: "Chat · Ada · Trip", kind: .mine)

    #expect(own.actions == [.open, .delete, .useHere])
    #expect(!own.allows(.adopt))
    #expect(!own.allows(.rename))
  }
}

// MARK: - The calls

private final class OwnChatLink: Sendable {
  let link = ScriptedLink()

  var service: OwnChatService {
    OwnChatService(link: link, resolver: ChatResolver(link: link))
  }
}

private let lead = "Chat · Ada"
private let nowMs = 1_790_032_568_000.0

struct OwnChatServiceTests {
  @Test func aTitleLookupIsExactIncludesHiddenAndFindsTheChat() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(
      to: RPC.SessionList.name,
      with: ["sessions": [["id": "s-1", "resolved_id": "s-tip", "title": "Chat  ·  Ada", "message_count": 3, "preview": "hi"]]])

    let found = try await gateway.service.lookup(profile: "researcher", title: lead)

    #expect(found == CanonicalSession(id: "s-1", resolvedID: "s-tip", preview: "hi", lastActive: 0, messageCount: 3))
    let call = try #require(gateway.link.calls(RPC.SessionList.name).first)
    #expect(call.params["title"] == .string(lead))
    #expect(call.params["profile"] == "researcher")
    #expect(call.params["include_hidden"] == true)
    #expect(call.params["limit"] == 200)
  }

  @Test func aLookupThatFailsThrowsRatherThanReadingAsNoChat() async throws {
    let gateway = OwnChatLink()
    gateway.link.refuse(RPC.SessionList.name) { _ in GatewayRPCError(.rejected, "registry down", code: 5000) }

    await #expect(throws: ChatResolver.ResolutionError.self) {
      try await gateway.service.lookup(profile: "researcher", title: lead)
    }
  }

  @Test func anIDLookupCountsOnlyWhileTheRowStillWearsTheReadersTitleFamily() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(
      to: RPC.SessionList.name,
      with: [
        "sessions": [
          ["id": "s-1", "title": "Chat · Ada · Trip"],
          ["id": "s-2", "title": "Bot Chat"],
          ["id": "s-3", "resolved_id": "s-3-tip", "title": "Chat · Ada"],
          ["id": "s-4", "title": "Chat · Adam"]
        ]
      ])
    let service = gateway.service

    #expect(try await service.lookup(profile: "researcher", lead: lead, storedID: "s-1")?.id == "s-1")
    #expect(try await service.lookup(profile: "researcher", lead: lead, storedID: "s-3-tip")?.id == "s-3")
    // After an adopt, an id that now names the Bot Chat, or another reader's chat, is not theirs.
    #expect(try await service.lookup(profile: "researcher", lead: lead, storedID: "s-2") == nil)
    #expect(try await service.lookup(profile: "researcher", lead: lead, storedID: "s-4") == nil)
    #expect(try await service.lookup(profile: "researcher", lead: lead, storedID: "gone") == nil)
    // An id lookup is one profile listing, with no title filter.
    #expect(gateway.link.calls(RPC.SessionList.name).first?.params["title"] == nil)
  }

  @Test func anIDLookupThatFailsThrowsSoAGatewayThatIsRestartingForgetsNoChat() async throws {
    let gateway = OwnChatLink()
    gateway.link.refuse(RPC.SessionList.name) { _ in GatewayRPCError(.notConnected, "offline") }

    await #expect(throws: ChatResolver.ResolutionError.self) {
      try await gateway.service.lookup(profile: "researcher", lead: lead, storedID: "s-1")
    }
  }

  @Test func theFirstChatIsFoundAgainBeforeItIsMade() async throws {
    let gateway = OwnChatLink()
    let empty: JSONValue = ["sessions": []]
    let made: JSONValue = ["sessions": [["id": "s-made-elsewhere", "title": .string(lead)]]]
    let answers = Mutex2([empty, made])
    gateway.link.respond(to: RPC.SessionList.name) { _ in answers.next() }

    let chat = try await gateway.service.resolve(profile: "researcher", lead: lead, parentSessionID: "bot-chat")

    #expect(chat.id == "s-made-elsewhere")
    #expect(gateway.link.calls(RPC.SessionList.name).count == 2)
    #expect(gateway.link.calls(RPC.SessionCreate.name).isEmpty, "the same person on another device made it in between")
  }

  @Test func theFirstChatIsMadeVisibleUnderTheBotChatAndTitledAtOnce() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(to: RPC.SessionList.name, with: ["sessions": []])
    gateway.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-new", "stored_session_id": "s-new"])
    gateway.link.respond(to: RPC.SessionTitle.name) { ["title": $0["title"] ?? .null] }

    let chat = try await gateway.service.resolve(profile: "researcher", lead: lead, parentSessionID: "bot-chat")

    #expect(chat == CanonicalSession(id: "s-new", resolvedID: "s-new"))
    let create = try #require(gateway.link.calls(RPC.SessionCreate.name).first)
    #expect(create.params["profile"] == "researcher")
    #expect(create.params["hidden"] == false, "hidden marks the one canonical row")
    #expect(create.params["parent_session_id"] == "bot-chat")
    #expect(create.params["follow_profile_config"] == true)
    #expect(create.params["source"] == "hermie")
    // The first chat carries the bare lead: the one title a lookup on another device finds it by, so the
    // switch never makes a second one. It is made with its title; nothing is renamed afterwards.
    #expect(create.params["title"] == .string(lead))
    #expect(gateway.link.calls(RPC.SessionTitle.name).isEmpty)
  }

  @Test func withNobodyNamedNothingIsLookedUpOrMade() async throws {
    let gateway = OwnChatLink()

    await #expect(throws: ChatResolver.ResolutionError.self) {
      try await gateway.service.resolve(profile: "researcher", lead: "", parentSessionID: nil)
    }
    #expect(gateway.link.calls.isEmpty)
  }

  @Test func aNamedChatCarriesItsNameAndANewOneTheStamp() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-1", "stored_session_id": "s-1"])
    gateway.link.respond(to: RPC.SessionTitle.name) { ["title": $0["title"] ?? .null] }

    let named = try await gateway.service.make(
      profile: "researcher", lead: lead, label: "  Trip   planning ", parentSessionID: "bot-chat", now: nowMs)

    #expect(named.title == "Chat · Ada · Trip planning")
    #expect(gateway.link.calls(RPC.SessionCreate.name).first?.params["title"] == "Chat · Ada · Trip planning")

    let unnamed = try await gateway.service.make(
      profile: "researcher", lead: lead, label: "", parentSessionID: nil, now: nowMs)

    #expect(unnamed.title.hasPrefix("Chat · Ada · 20"))
    #expect(gateway.link.calls(RPC.SessionCreate.name).last?.params["parent_session_id"] == nil)
  }

  @Test func aTitleClashIsRetriedOnceWithTheNameNumberedOrTheStampSecondsLong() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-1", "stored_session_id": "s-1"])
    let attempts = Mutex2([String]())
    gateway.link.refuse(RPC.SessionTitle.name) { params in
      let count = attempts.append(params["title"]?.stringValue ?? "")

      return count == 1 ? GatewayRPCError(.rejected, "title taken", code: 4022) : nil
    }
    gateway.link.respond(to: RPC.SessionTitle.name) { ["title": $0["title"] ?? .null] }

    let made = try await gateway.service.make(
      profile: "researcher", lead: lead, label: "Ideas", parentSessionID: nil, now: nowMs)

    #expect(made.title == "Chat · Ada · Ideas (2)")
    #expect(attempts.values == ["Chat · Ada · Ideas", "Chat · Ada · Ideas (2)"])
    #expect(gateway.link.calls(RPC.SessionClose.name).isEmpty)
  }

  @Test func aChatWhoseTitleCannotBeWrittenIsClosedAgain() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-1", "stored_session_id": "s-1"])
    gateway.link.refuse(RPC.SessionTitle.name) { _ in GatewayRPCError(.rejected, "no", code: 5000) }
    gateway.link.respond(to: RPC.SessionClose.name, with: [:])

    await #expect(throws: GatewayRPCError.self) {
      try await gateway.service.make(profile: "researcher", lead: lead, label: "Ideas", parentSessionID: nil, now: nowMs)
    }

    #expect(gateway.link.calls(RPC.SessionClose.name).first?.params["session_id"] == "rt-1")
  }

  @Test func aGatewayThatMadeNoIDIsReportedNotOpened() async throws {
    let gateway = OwnChatLink()
    gateway.link.respond(to: RPC.SessionCreate.name, with: [:])

    await #expect(throws: ChatResolver.ResolutionError.self) {
      try await gateway.service.make(profile: "researcher", lead: lead, label: "x", parentSessionID: nil, now: nowMs)
    }
  }
}

/// A little state a responder can keep: answers handed out in order, and values collected.
private final class Mutex2<Value: Sendable>: @unchecked Sendable {
  // The test is the only writer, one call at a time, through a lock.
  private let lock = NSLock()
  private var items: [Value]
  private var served = 0

  init(_ items: [Value]) {
    self.items = items
  }

  var values: [Value] {
    lock.withLock { items }
  }

  /// The next answer; the last one repeats.
  func next() -> Value {
    lock.withLock {
      defer { served += 1 }
      return items[min(served, items.count - 1)]
    }
  }

  /// Collect a value; answers how many there are now.
  @discardableResult
  func append(_ value: Value) -> Int {
    lock.withLock {
      items.append(value)
      return items.count
    }
  }
}
