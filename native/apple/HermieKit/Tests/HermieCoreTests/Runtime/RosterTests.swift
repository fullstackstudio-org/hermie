import Foundation
import Synchronization
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// `bots-roster.test.ts`: canonical chat resolution (ADR-0007), the roster, avatars and running state.
@Suite(.timeLimit(.minutes(1))) struct ChatResolverTests {
  private let bare = Bot(name: "researcher")

  @Test func usesTheRosterRowWhenTheGatewayAlreadyResolvedIt() async throws {
    let link = ScriptedLink()
    let resolver = ChatResolver(link: link)

    let canonical = try await resolver.resolveCanonical(Fixture.bot())
    #expect(canonical.id == Fixture.stored)
    #expect(link.calls.isEmpty)
  }

  @Test func looksTheChatUpByExactTitleIncludingHiddenSessions() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.SessionList.name, with: [
      "sessions": [
        ["id": "other", "title": "Branch · notes"],
        ["id": "s-bot", "resolved_id": "s-tip", "title": " Bot Chat ", "message_count": 4, "preview": "hi"]
      ]
    ])

    let canonical = try await ChatResolver(link: link).resolveCanonical(bare)
    #expect(canonical == CanonicalSession(id: "s-bot", resolvedID: "s-tip", preview: "hi", messageCount: 4))

    let params = try #require(link.calls.first?.params)
    #expect(params == ["profile": "researcher", "title": "Bot Chat", "limit": 200, "include_hidden": true])
    #expect(link.calls(RPC.SessionCreate.name).isEmpty)
  }

  @Test func reRunsTheLookupBeforeMintingSoAChatCreatedMeanwhileIsAdopted() async throws {
    let link = ScriptedLink()
    let resolving = Task { try await ChatResolver(link: link).resolveCanonical(bare) }

    try await link.answerNext(RPC.SessionList.name, ["sessions": []])
    try await link.answerNext(RPC.SessionList.name, ["sessions": [["id": "late", "title": "Bot Chat"]]])

    #expect(try await resolving.value.id == "late")
    #expect(link.calls(RPC.SessionCreate.name).isEmpty)
  }

  @Test func createsTheChatHiddenTitledAndFollowingTheProfileConfig() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.SessionList.name, with: ["sessions": []])
    link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-9", "stored_session_id": "stored-9"])

    let canonical = try await ChatResolver(link: link).resolveCanonical(bare)
    #expect(canonical == CanonicalSession(id: "stored-9", resolvedID: "stored-9"))
    #expect(link.calls(RPC.SessionList.name).count == 2)

    let params = try #require(link.calls(RPC.SessionCreate.name).first?.params)
    #expect(
      params == [
        "profile": "researcher", "title": "Bot Chat", "hidden": true, "source": "hermie", "cols": 96,
        "follow_profile_config": true
      ]
    )
  }

  @Test func failsClosedWhenTheRegistryLookupErrorsInsteadOfMintingASecondChat() async throws {
    let link = ScriptedLink()
    let resolving = Task { try await ChatResolver(link: link).resolveCanonical(bare) }
    let call = try await link.pendingCall(RPC.SessionList.name)
    link.fail(call, GatewayRPCError(.timeout, "request timed out after 30s: session.list"))

    await #expect(throws: ChatResolver.ResolutionError.self) { try await resolving.value }
    #expect(link.calls(RPC.SessionCreate.name).isEmpty)
  }

  @Test func resolvesABotOnceEvenWhenTwoTapsLandTogether() async throws {
    let link = ScriptedLink()
    let resolver = ChatResolver(link: link)
    let first = Task { try await resolver.resolveCanonical(bare) }
    let call = try await link.pendingCall(RPC.SessionList.name)
    let second = Task { try await resolver.resolveCanonical(bare) }

    try await eventually("the second tap to join") { await resolver.joined == 1 }
    link.answer(call, ["sessions": [["id": "s-1", "title": "Bot Chat"]]])

    #expect(try await first.value.id == "s-1")
    #expect(try await second.value.id == "s-1")
    #expect(link.calls(RPC.SessionList.name).count == 1)
  }
}

@Suite(.timeLimit(.minutes(1))) struct BotRosterTests {
  static let row: JSONValue = [
    "name": "researcher",
    "display_name": "Researcher",
    "description": "Finds things out.",
    "has_avatar": true,
    "is_default": true,
    "ui_meta_revisions": ["avatar": 3, "name": 7],
    "canonical_session": ["id": "stored-1", "resolved_id": "tip-1", "last_active": 120, "message_count": 8]
  ]

  @Test func aProfileRowKeepsTheDurableIdAndTheLineageTipApart() {
    let bot = Bot(row: ProfileRow(json: Self.row.objectValue!))
    #expect(bot.canonical?.id == "stored-1")
    #expect(bot.canonical?.resolvedID == "tip-1")
    #expect(bot.uiMetaRevision == 7, "the highest revision, so a changed avatar invalidates its cache")
    #expect(bot.displayName == "Researcher")
    #expect(Bot(row: ProfileRow(json: ["name": "writer"])).displayName == "writer")
  }

  @Test func theRosterIsCachedAndPaintedOnTheNextColdStart() async throws {
    let cache = MemoryChatCache()
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesList.name, with: ["profiles": [Self.row, ["display_name": "nameless"]]])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": true, "data": "QUJD"])
    let roster = BotRoster(link: link, gatewayID: "g1", cache: cache)

    let bots = try await roster.refresh()
    #expect(bots.map(\.name) == ["researcher"], "a row without a name is not a bot")
    #expect(link.calls(RPC.ProfilesList.name).first?.params == ["include_sessions": true])
    try await eventually("the roster write") { await !cache.readBots().isEmpty }
    try await eventually("the avatar") { await roster.current.avatars["researcher"] == "QUJD" }

    let later = BotRoster(link: ScriptedLink(), gatewayID: "g1", cache: cache)
    await later.paintFromCache()
    #expect(await later.bots == bots)
    #expect(await later.current.refreshed == false)
    await roster.shutdown()
    await later.shutdown()
  }

  @Test func anAvatarIsFetchedOncePerRevision() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": true, "data": "QUJD"])
    let roster = BotRoster(link: link, gatewayID: "g1")
    let bot = Bot(row: ProfileRow(json: Self.row.objectValue!))

    await roster.loadAvatars([bot])
    await roster.loadAvatars([bot])
    #expect(link.calls(RPC.ProfilesGetAsset.name).count == 1)
    #expect(link.calls(RPC.ProfilesGetAsset.name).first?.params == ["name": "researcher", "asset": "avatar"])

    var bumped = bot
    bumped.uiMetaRevision = 8
    await roster.loadAvatars([bumped])
    #expect(link.calls(RPC.ProfilesGetAsset.name).count == 2)
    await roster.shutdown()
  }

  @Test func anAvatarIsKeptOnDiskPaintedOnTheNextLaunchAndReplacedWhenItChanged() async throws {
    let cache = MemoryChatCache()
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesList.name, with: ["profiles": [Self.row]])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": true, "data": "data:image/png;base64,QUJD"])
    let first = BotRoster(link: link, gatewayID: "g1", cache: cache, keyValues: keyValues)

    _ = try await first.refresh()
    try await eventually("the avatar on disk") {
      (try? await keyValues.string(forKey: GatewayNamespace("g1").key("hermie.avatar.researcher"))) != nil
    }
    try await eventually("the roster write") { await !cache.readBots().isEmpty }
    await first.shutdown()

    // The next launch paints it from disk before the gateway has been asked.
    let later = ScriptedLink()
    later.respond(to: RPC.ProfilesList.name, with: ["profiles": [Self.row]])
    later.respond(to: RPC.ProfilesGetAsset.name, with: ["found": true, "data": "data:image/png;base64,REVG"])
    let second = BotRoster(link: later, gatewayID: "g1", cache: cache, keyValues: keyValues)
    await second.paintFromCache()
    #expect(await second.current.avatars["researcher"] == "data:image/png;base64,QUJD")
    #expect(later.calls(RPC.ProfilesGetAsset.name).isEmpty)

    // And asks once anyway: a changed picture replaces the stored one.
    _ = try await second.refresh()
    try await eventually("the new avatar") { await second.current.avatars["researcher"] == "data:image/png;base64,REVG" }
    try await eventually("the new avatar on disk") {
      (try? await keyValues.string(forKey: GatewayNamespace("g1").key("hermie.avatar.researcher"))) == "data:image/png;base64,REVG"
    }
    await second.shutdown()

    // The picture is taken away: the copy in memory and on disk goes with it.
    var bare = Self.row.objectValue!
    bare["has_avatar"] = false
    bare["ui_meta_revisions"] = ["avatar": 4, "name": 8]
    let third = BotRoster(link: later, gatewayID: "g1", cache: cache, keyValues: keyValues)
    await third.loadAvatars([Bot(row: ProfileRow(json: bare))])
    #expect(await third.current.avatars["researcher"] == nil)
    #expect((try? await keyValues.string(forKey: GatewayNamespace("g1").key("hermie.avatar.researcher"))) == nil)
    await third.shutdown()
  }

  @Test func aBusySessionLightsUpOnlyTheBotThatOwnsIt() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesList.name, with: [
      "profiles": [
        ["name": "researcher", "canonical_session": ["id": "s-r"]],
        ["name": "writer", "canonical_session": ["id": "s-w"]],
        ["name": "editor", "canonical_session": ["id": "s-e"]]
      ]
    ])
    link.respond(to: RPC.SessionActiveList.name, with: [
      "sessions": [
        ["id": "rt-r", "session_key": "s-r", "status": "working", "title": "Bot Chat"],
        ["id": "rt-w", "status": "waiting", "title": "Bot Chat"],
        ["id": "rt-e", "session_key": "s-e", "status": "idle"],
        ["id": "rt-x", "session_key": "s-unknown", "status": "working"]
      ]
    ])
    let roster = BotRoster(link: link, gatewayID: "g1")
    await roster.setSessionIDSource { ["writer": BotRoster.SessionIDs(stored: "s-w", runtime: "rt-w")] }
    _ = try await roster.refresh()

    await roster.refreshRunning()
    #expect(await roster.current.running == ["researcher", "writer"])
    #expect(link.calls(RPC.SessionActiveList.name).count == 1, "one call per poll, not one per bot")
    #expect(link.calls(RPC.SessionActiveList.name).first?.params == [:], "no profile: the call does not scope on one")
    await roster.shutdown()
  }

  @Test func aFailedActiveListReadsAsNothingRunning() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesList.name, with: ["profiles": [["name": "researcher"]]])
    let roster = BotRoster(link: link, gatewayID: "g1")
    _ = try await roster.refresh()

    let refreshing = Task { await roster.refreshRunning() }
    let call = try await link.pendingCall(RPC.SessionActiveList.name)
    link.fail(call, GatewayRPCError(.rejected, "nope"))
    await refreshing.value
    #expect(await roster.current.running.isEmpty)
    await roster.shutdown()
  }

  @Test func aSwitchedCanonicalChatHoldsUntilTheRosterAgrees() async throws {
    let link = ScriptedLink()
    let answer = Mutable<JSONValue>(["profiles": [["name": "researcher", "canonical_session": ["id": "old"]]]])
    link.respond(to: RPC.ProfilesList.name) { _ in answer.value }
    let roster = BotRoster(link: link, gatewayID: "g1")
    _ = try await roster.refresh()

    await roster.setCanonical("researcher", CanonicalSession(id: "new", resolvedID: "new"))
    _ = try await roster.refresh()
    #expect(await roster.bot(named: "researcher")?.canonical?.id == "new", "a poll naming the old chat cannot revert it")

    answer.value = ["profiles": [["name": "researcher", "canonical_session": ["id": "new"]]]]
    _ = try await roster.refresh()
    answer.value = ["profiles": [["name": "researcher", "canonical_session": ["id": "elsewhere"]]]]
    _ = try await roster.refresh()
    #expect(await roster.bot(named: "researcher")?.canonical?.id == "elsewhere", "the pin let go once the gateway agreed")
    await roster.shutdown()
  }

  @Test func theReadWatermarkNeverMovesBackwardsAndSurvivesARelaunch() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)
    let link = ScriptedLink()
    link.respond(to: RPC.ProfilesList.name, with: ["profiles": [Self.row]])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": false])
    let roster = BotRoster(link: link, gatewayID: "g1", keyValues: keyValues)
    _ = try await roster.refresh()

    #expect(await roster.current.isUnread("researcher"))
    #expect(await roster.markSeen("researcher") == 120, "the roster's own last_active")
    #expect(await roster.current.isUnread("researcher") == false)
    #expect(await roster.markSeen("researcher", at: 50) == 120)

    try await eventually("the watermark write") {
      (try? await keyValues.string(forKey: GatewayNamespace("g1").key(StoreKeys.botsLastSeen))) != nil
    }
    await roster.shutdown()

    let relaunched = BotRoster(link: ScriptedLink(), gatewayID: "g1", keyValues: keyValues)
    await relaunched.loadWatermarks()
    #expect(await relaunched.current.lastSeen["researcher"] == 120)
    await relaunched.shutdown()
  }
}

/// A box a responder closure can read while the test changes it.
final class Mutable<Value: Sendable>: Sendable {
  private let storage: Mutex<Value>

  init(_ value: Value) {
    storage = Mutex(value)
  }

  var value: Value {
    get { storage.withLock { $0 } }
    set { storage.withLock { $0 = newValue } }
  }
}
