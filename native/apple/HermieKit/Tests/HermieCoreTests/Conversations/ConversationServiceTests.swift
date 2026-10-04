import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// The researcher's chat open on `stored-1` (`rt-1`), the roster knowing it as the bot's canonical chat.
private func opened() async throws -> (StoreHarness, ConversationService) {
  let harness = StoreHarness()
  await harness.attach()
  await harness.store.connectionChanged(ConnectionStatus(.ready))
  harness.link.respond(to: RPC.ProfilesList.name, with: [
    "profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored)]]]
  ])
  _ = try await harness.roster.refresh()
  try await harness.open()

  return (harness, ConversationService(link: harness.link, store: harness.store, roster: harness.roster))
}

private func past(_ id: String = "stored-2", _ title: String = "Trip planning") -> Conversation {
  ConversationFixture.conversation(id, title)
}

/// A gateway that answers a resume with a runtime id of its own per stored id, and everything the
/// swap and the re-open after it ask for.
private func answerEverything(_ link: ScriptedLink) {
  link.respond(to: RPC.SessionResume.name) { params in
    let stored = params["session_id"]?.stringValue ?? ""

    return Fixture.resume(runtime: "rt-\(stored.dropFirst("stored-".count))", stored: stored)
  }
  link.respond(to: RPC.SessionHistory.name, with: ["count": 0, "messages": []])
  link.respond(to: RPC.SessionEventsSince.name, with: Fixture.since(latest: 0))

  for method in [RPC.SessionSetHidden.name, RPC.SessionClose.name] {
    link.respond(to: method, with: [:])
  }

  link.respond(to: RPC.SessionTitle.name) { params in ["title": params["title"] ?? .null] }
  // Nothing is live but the chat itself.
  link.respond(to: RPC.SessionActiveList.name, with: ["sessions": []])
}

@Suite(.timeLimit(.minutes(1))) struct ConversationServiceTests {
  // MARK: Listing

  @Test func listsTheProfilesSessionsHiddenOnesIncludedAndGroupsThemByTheRostersCanonicalID() async throws {
    let (harness, service) = try await opened()
    harness.link.respond(to: RPC.SessionList.name, with: [
      "sessions": [
        ["id": "stored-1", "title": "Bot Chat", "message_count": 40, "started_at": 300],
        ["id": "stored-3", "title": "Branch · an idea", "started_at": 200],
        ["id": "stored-2", "title": "Trip planning", "started_at": 100, "preview": "Where to?"]
      ]
    ])

    let groups = try await service.list(bot: bot)

    let call = try #require(harness.link.calls(RPC.SessionList.name).first)
    #expect(call.params["profile"] == .string(bot))
    #expect(call.params["include_hidden"] == true)
    #expect(call.params["limit"] == 200)
    #expect(call.params["title"] == nil, "all of them, not the one called Bot Chat")
    #expect(groups.canonical?.id == "stored-1")
    #expect(groups.canonical?.messageCount == 40)
    #expect(groups.branches.map(\.id) == ["stored-3"])
    #expect(groups.past.map(\.id) == ["stored-2"])
    #expect(groups.past.first?.preview == "Where to?")
    await harness.shutdown()
  }

  @Test func aListThatFailsThrowsRatherThanReadingAsNoConversations() async throws {
    let (harness, service) = try await opened()
    let failing = Task { try await service.list(bot: bot) }
    let call = try await harness.link.pendingCall(RPC.SessionList.name)
    harness.link.fail(call, GatewayRPCError(.rejected, "no registry"))

    await #expect(throws: GatewayRPCError.self) { try await failing.value }
    await harness.shutdown()
  }

  // MARK: Rename

  @Test func renamingAConversationNothingRunsResumesItNamesItOnTheRuntimeIDAndPutsItAway() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)

    let settled = try await service.rename(bot: bot, conversation: past(), title: "Lisbon trip")

    let methods = harness.link.calls.map(\.method).filter {
      [RPC.SessionResume.name, RPC.SessionTitle.name, RPC.SessionClose.name].contains($0)
    }
    // The first resume is the chat's own open; the rename's three follow.
    #expect(methods.suffix(3) == ["session.resume", "session.title", "session.close"])
    let resume = try #require(harness.link.calls(RPC.SessionResume.name).last)
    #expect(resume.params["session_id"] == "stored-2", "a listing hands out STORED ids")
    #expect(resume.params["omit_messages"] == true)
    let title = try #require(harness.link.calls(RPC.SessionTitle.name).last)
    #expect(title.params["session_id"] == "rt-2", "session.title takes the RUNTIME id")
    #expect(title.params["title"] == "Lisbon trip")
    #expect(harness.link.calls(RPC.SessionClose.name).last?.params["session_id"] == "rt-2")
    #expect(settled == "Lisbon trip")
    await harness.shutdown()
  }

  @Test func theTitleTheGatewaySettledOnIsTheOneAnswered() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionTitle.name, with: ["title": "Lisbon trip (2)"])

    #expect(try await service.rename(bot: bot, conversation: past(), title: "Lisbon trip") == "Lisbon trip (2)")
    await harness.shutdown()
  }

  @Test func aConversationTheChatHoldsLiveIsRenamedOnItsRuntimeIDWithoutResumingOrClosingIt() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    let before = harness.link.calls(RPC.SessionResume.name).count

    _ = try await service.rename(bot: bot, conversation: past("stored-1", "Bot Chat"), title: "Elsewhere")

    #expect(harness.link.calls(RPC.SessionResume.name).count == before)
    #expect(harness.link.calls(RPC.SessionTitle.name).last?.params["session_id"] == .string(Fixture.runtime))
    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty)
    await harness.shutdown()
  }

  @Test func aRefusedTitleTravelsAndTheSessionResumedForItIsStillPutAway() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.unrespond(RPC.SessionTitle.name)

    let renaming = Task { try await service.rename(bot: bot, conversation: past(), title: "Taken") }
    let call = try await harness.link.pendingCall(RPC.SessionTitle.name)
    harness.link.fail(call, GatewayRPCError(.rejected, "Title 'Taken' is already in use by session s-9"))

    do {
      _ = try await renaming.value
      Issue.record("the refusal must travel")
    } catch {
      #expect(ChatResolver.describe(error) == "Title 'Taken' is already in use by session s-9")
    }

    #expect(harness.link.calls(RPC.SessionClose.name).last?.params["session_id"] == "rt-2")
    await harness.shutdown()
  }

  // MARK: A session another client has live is not this client's to end

  /// The gateway lists the session as live under any of the names it goes by, or cannot say.
  @Test(arguments: [
    ["id": "rt-2"], ["id": "other", "session_key": "stored-2"], ["id": "stored-2"], ["id": "tip-2"]
  ] as [JSONObject])
  func aConversationLiveElsewhereIsRenamedAndLeftRunning(_ live: JSONObject) async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionActiveList.name, with: ["sessions": [.object(live)]])
    let conversation = Conversation(id: "stored-2", resolvedID: "tip-2", title: "Trip planning", kind: .past)

    _ = try await service.rename(bot: bot, conversation: conversation, title: "Lisbon trip")

    #expect(harness.link.calls(RPC.SessionTitle.name).last?.params["session_id"] == "rt-2")
    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty, "another client may rely on it")
    await harness.shutdown()
  }

  @Test func aGatewayThatCannotListItsLiveSessionsLeavesWhatItResumedRunning() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionActiveList.name, with: [:])

    _ = try await service.rename(bot: bot, conversation: past(), title: "Lisbon trip")

    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty, "cannot tell: not closed")
    await harness.shutdown()
  }

  @Test func aSessionThatIsLiveOnlyBecauseThisClientResumedItIsPutAway() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    // Another conversation is live; this one is not.
    harness.link.respond(to: RPC.SessionActiveList.name, with: ["sessions": [["id": "rt-7", "session_key": "stored-7"]]])

    _ = try await service.rename(bot: bot, conversation: past(), title: "Lisbon trip")

    #expect(harness.link.calls(RPC.SessionClose.name).map { $0.params["session_id"] } == ["rt-2"])
    await harness.shutdown()
  }

  @Test func aTranscriptReadOverRPCLeavesALiveSessionRunning() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.setREST { _, _ in nil }
    harness.link.respond(to: RPC.SessionActiveList.name, with: ["sessions": [["id": "rt-2"]]])
    harness.link.respond(to: RPC.SessionHistory.name, with: ["count": 2, "messages": .array(Fixture.rows(2))])

    let page = try await service.transcript(bot: bot, conversation: past(), window: MessageWindow(limit: 200))
    try await Task.sleep(for: .milliseconds(50))

    #expect(page.rows.count == 2)
    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty)
    await harness.shutdown()
  }

  // MARK: Delete

  @Test func deleteTakesTheStoredIDAndTheProfile() async throws {
    let (harness, service) = try await opened()
    harness.link.respond(to: RPC.SessionDelete.name, with: ["deleted": "stored-2"])

    try await service.delete(bot: bot, conversation: past())

    let call = try #require(harness.link.calls(RPC.SessionDelete.name).first)
    #expect(call.params["session_id"] == "stored-2")
    #expect(call.params["profile"] == .string(bot))
    await harness.shutdown()
  }

  // MARK: Make current

  @Test func makingAConversationTheBotChatSwapsTheTitlesInTheOrderTheRegistryKeyNeeds() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    let opens = harness.link.calls(RPC.SessionResume.name).count

    try await service.adopt(bot: bot, conversation: past())
    await harness.settle()

    let methods = harness.link.calls.map { call -> String in
      let session = call.params["session_id"]?.stringValue ?? ""
      let title = call.params["title"]?.stringValue.map { " \($0.hasPrefix("Bot Chat · ") ? "retired" : $0)" } ?? ""
      let hidden = call.params["hidden"]?.boolValue.map { " hidden=\($0)" } ?? ""

      return "\(call.method) \(session)\(title)\(hidden)"
    }
    .filter { $0.hasPrefix("session.resume stored-2") || $0.hasPrefix("session.title") || $0.hasPrefix("session.set_hidden") || $0.hasPrefix("session.close") }

    #expect(methods == [
      "session.resume stored-2",
      "session.set_hidden rt-1 hidden=false",
      "session.title rt-1 retired",
      "session.title rt-2 Bot Chat",
      "session.set_hidden rt-2 hidden=true",
      // The conversation put away is not closed: another client may have it attached.
      // The chat opens on the new conversation.
      "session.resume stored-2"
    ])
    #expect(harness.link.calls(RPC.SessionResume.name).count == opens + 2)

    let state = await harness.state()
    #expect(state.storedSessionID == "stored-2")
    #expect(state.runtimeSessionID == "rt-2")
    #expect(await harness.roster.bot(named: bot)?.canonical?.id == "stored-2")
    await harness.shutdown()
  }

  @Test func theRetiredConversationIsNamedWithTheDateTheWayANewConversationNamesIt() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)

    try await service.adopt(bot: bot, conversation: past())

    let retired = try #require(harness.link.calls(RPC.SessionTitle.name).first?.params["title"]?.stringValue)
    #expect(ConversationClassifier.isRetiredTitle(retired))
    await harness.shutdown()
  }

  @Test func theConversationThatIsAlreadyTheBotChatIsLeftAlone() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    let before = harness.link.calls.count

    try await service.adopt(bot: bot, conversation: past("stored-1", "Bot Chat"))

    #expect(harness.link.calls.count == before)
    await harness.shutdown()
  }

  @Test func aTitleTheGatewayRefusesPutsTheOutgoingChatsNameAndHiddenFlagBack() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.unrespond(RPC.SessionTitle.name)

    let adopting = Task { try await service.adopt(bot: bot, conversation: past()) }
    // Retire the outgoing chat: taken.
    let retire = try await harness.link.pendingCall(RPC.SessionTitle.name)
    #expect(retire.params["session_id"] == "rt-1")
    harness.link.answer(retire, ["title": retire.params["title"] ?? .null])
    // Name the incoming one Bot Chat: refused.
    let take = try await harness.link.pendingCall(RPC.SessionTitle.name) { $0.params["session_id"] == "rt-2" }
    harness.link.fail(take, GatewayRPCError(.rejected, "Title 'Bot Chat' is already in use by session stored-1"))
    // And the outgoing chat gets its name back.
    let undo = try await harness.link.pendingCall(RPC.SessionTitle.name) {
      $0.params["session_id"] == "rt-1" && $0.params["title"] == "Bot Chat"
    }
    harness.link.answer(undo, ["title": "Bot Chat"])

    await #expect(throws: GatewayRPCError.self) { try await adopting.value }

    let hidden = harness.link.calls(RPC.SessionSetHidden.name).map { $0.params["hidden"] }
    #expect(hidden == [false, true], "un-hidden for the retire, hidden again for the undo")
    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty, "nothing was put away")

    let state = await harness.state()
    #expect(state.storedSessionID == Fixture.stored)
    #expect(await harness.roster.bot(named: bot)?.canonical?.id == Fixture.stored)
    await harness.shutdown()
  }

  @Test func aRetireTheGatewayRefusesLeavesEverythingAsItWasAndCarriesTheReason() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.unrespond(RPC.SessionTitle.name)

    let adopting = Task { try await service.adopt(bot: bot, conversation: past()) }
    let retire = try await harness.link.pendingCall(RPC.SessionTitle.name)
    harness.link.fail(retire, GatewayRPCError(.rejected, "cannot rename"))
    // The one retry, with the seconds in the name.
    let again = try await harness.link.pendingCall(RPC.SessionTitle.name) { $0.id != retire.id }
    harness.link.fail(again, GatewayRPCError(.rejected, "cannot rename"))

    do {
      try await adopting.value
      Issue.record("the refusal must travel")
    } catch {
      #expect(ChatResolver.describe(error) == "cannot rename")
    }

    #expect(harness.link.calls(RPC.SessionSetHidden.name).map { $0.params["hidden"] } == [false, true])
    #expect(
      harness.link.calls(RPC.SessionTitle.name).allSatisfy { $0.params["session_id"] == "rt-1" },
      "the incoming conversation was never touched")
    #expect(harness.link.calls(RPC.SessionClose.name).isEmpty)
    await harness.shutdown()
  }

  /// The stamp counts minutes: putting a conversation away twice in a minute meets its own name.
  @Test func aRetireNameAlreadyWornInThisMinuteIsRetriedWithTheSeconds() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.unrespond(RPC.SessionTitle.name)

    let adopting = Task { try await service.adopt(bot: bot, conversation: past()) }
    let first = try await harness.link.pendingCall(RPC.SessionTitle.name)
    harness.link.fail(first, GatewayRPCError(.rejected, "Title 'Bot Chat · 2026-10-04 12:08' is already in use"))
    let second = try await harness.link.pendingCall(RPC.SessionTitle.name) { $0.id != first.id }
    harness.link.answer(second, ["title": second.params["title"] ?? .null])
    let incoming = try await harness.link.pendingCall(RPC.SessionTitle.name) { $0.params["session_id"] == "rt-2" }
    harness.link.answer(incoming, ["title": "Bot Chat"])
    try await adopting.value
    await harness.settle()

    let firstTitle = try #require(first.params["title"]?.stringValue)
    let secondTitle = try #require(second.params["title"]?.stringValue)
    #expect(ConversationClassifier.isRetiredTitle(firstTitle))
    #expect(ConversationClassifier.isRetiredTitle(secondTitle))
    #expect(secondTitle.count == firstTitle.count + 3, "the same stamp with `:ss` after it")
    #expect(secondTitle.hasPrefix(firstTitle))
    #expect(await harness.state().storedSessionID == "stored-2")
    await harness.shutdown()
  }

  @Test func aReplyStreamingIntoTheChatRefusesTheSwapBeforeAnythingMoves() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    _ = try await harness.store.send(bot, text: "working on it")
    await harness.settle()
    let before = harness.link.calls.count

    await #expect(throws: ConversationBusyError.self) { try await service.adopt(bot: bot, conversation: past()) }

    #expect(harness.link.calls.count == before, "the gateway heard nothing")
    #expect(harness.link.calls(RPC.SessionTitle.name).isEmpty)
    await harness.shutdown()
  }

  @Test func theChatIsOpenedFirstWhenItIsNotAndTheSwapThenRuns() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    harness.link.respond(to: RPC.ProfilesList.name, with: [
      "profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored)]]]
    ])
    _ = try await harness.roster.refresh()
    answerEverything(harness.link)
    let service = ConversationService(link: harness.link, store: harness.store, roster: harness.roster)

    try await service.adopt(bot: bot, conversation: past())
    await harness.settle()

    // Open (stored-1), then the swap's resume of stored-2, then the re-open of stored-2.
    #expect(
      harness.link.calls(RPC.SessionResume.name).map { $0.params["session_id"]?.stringValue } == [
        "stored-1", "stored-2", "stored-2"
      ])
    #expect(await harness.state().storedSessionID == "stored-2")
    await harness.shutdown()
  }

  // MARK: A new conversation

  @Test func aNewConversationPutsTheCurrentOneAwayAndStartsTheNext() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.respond(to: RPC.SessionCreate.name, with: ["session_id": "rt-9", "stored_session_id": "stored-9"])

    try await service.startNew(bot: bot)
    await harness.settle()

    #expect(harness.link.calls(RPC.SessionCreate.name).first?.params["parent_session_id"] == .string(Fixture.stored))
    #expect(await harness.state().storedSessionID == "stored-9")
    await harness.shutdown()
  }

  /// The stamp counts minutes: two new conversations in one minute meet the first one's name.
  @Test func twoNewConversationsInOneMinuteDoNotMeetTheSameRetiredName() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    let counter = Mutex(8)
    harness.link.respond(to: RPC.SessionCreate.name) { _ in
      let n = counter.withLock { value -> Int in
        value += 1
        return value
      }

      return ["session_id": .string("rt-\(n)"), "stored_session_id": .string("stored-\(n)")]
    }
    // A gateway that lets each title be worn once, except the Bot Chat's own, which the retire frees.
    let worn = Mutex<Set<String>>([])
    harness.link.refuse(RPC.SessionTitle.name) { params in
      let title = params["title"]?.stringValue ?? ""

      guard title != ChatResolver.canonicalTitle, !worn.withLock({ $0.insert(title).inserted }) else {
        return nil
      }

      return GatewayRPCError(.rejected, "Title '\(title)' is already in use by session stored-9")
    }

    try await service.startNew(bot: bot)
    await harness.settle()
    try await service.startNew(bot: bot)
    await harness.settle()

    let retired = harness.link.calls(RPC.SessionTitle.name).compactMap { $0.params["title"]?.stringValue }.filter {
      ConversationClassifier.isRetiredTitle($0)
    }
    // First: the stamp. Second: the stamp refused, then the stamp with the seconds.
    #expect(retired.count == 3)
    #expect(retired[1] == retired[0])
    #expect(retired[2].hasPrefix(retired[0]) && retired[2].count == retired[0].count + 3)

    let state = await harness.state()
    #expect(state.storedSessionID == "stored-10", "the second conversation started")
    let notice = state.orderedItems.compactMap(\.asNotice).last?.body ?? ""
    #expect(notice.hasPrefix("New conversation started."))
    #expect(notice.contains(retired[2]))
    await harness.shutdown()
  }

  @Test func aNewConversationWhoseRetireNameIsRefusedTwiceChangesNothing() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.refuse(RPC.SessionTitle.name) { _ in GatewayRPCError(.rejected, "no names today") }

    try await service.startNew(bot: bot)
    await harness.settle()

    #expect(harness.link.calls(RPC.SessionTitle.name).count == 2, "the stamp, and once more with the seconds")
    #expect(harness.link.calls(RPC.SessionCreate.name).isEmpty)
    #expect(harness.link.calls(RPC.SessionSetHidden.name).map { $0.params["hidden"] } == [false, true])
    let state = await harness.state()
    #expect(state.storedSessionID == Fixture.stored)
    #expect(state.orderedItems.compactMap(\.asNotice).last?.body?.contains("no names today") == true)
    await harness.shutdown()
  }

  // MARK: Reading a transcript

  @Test func theTranscriptIsReadOverRESTUnderTheLineageTipNewestPageFirst() async throws {
    let (harness, service) = try await opened()
    harness.link.setREST { _, window in
      window.offset == 0 ? ConversationFixture.restRows(200, from: 201) : ConversationFixture.restRows(5)
    }
    let conversation = Conversation(id: "stored-2", resolvedID: "tip-2", title: "Trip", kind: .past)

    let first = try await service.transcript(bot: bot, conversation: conversation, window: MessageWindow(limit: 200))
    let older = try await service.transcript(
      bot: bot, conversation: conversation, window: MessageWindow(limit: 200, offset: 200))

    #expect(first.shape == .rest)
    #expect(first.rows.count == 200)
    #expect(!first.reachedStart, "a full page: there may be more")
    #expect(older.rows.count == 5)
    #expect(older.reachedStart, "a short page is the start")
    #expect(harness.link.restCalls.map(\.0) == ["tip-2", "tip-2"])
    #expect(harness.link.restCalls.map(\.1.offset) == [0, 200])
    await harness.shutdown()
  }

  @Test func withoutARESTTranscriptTheHistoryIsReadOverRPCAndTheSessionPutAway() async throws {
    let (harness, service) = try await opened()
    answerEverything(harness.link)
    harness.link.setREST { _, _ in nil }
    harness.link.respond(to: RPC.SessionHistory.name, with: [
      "count": 2, "messages": .array(Fixture.rows(2))
    ])
    let conversation = past()

    let page = try await service.transcript(bot: bot, conversation: conversation, window: MessageWindow(limit: 200))

    #expect(page.shape == .rpc)
    #expect(page.rows.count == 2)
    #expect(page.reachedStart, "session.history is unpaginated")
    let history = try #require(harness.link.calls(RPC.SessionHistory.name).last)
    #expect(history.params["session_id"] == "rt-2")
    try await eventually("the session read to be put away") {
      harness.link.calls(RPC.SessionClose.name).contains { $0.params["session_id"] == "rt-2" }
    }

    // And there is no older page to ask for.
    let older = try await service.transcript(
      bot: bot, conversation: conversation, window: MessageWindow(limit: 200, offset: 200))
    #expect(older.rows.isEmpty && older.reachedStart)
    await harness.shutdown()
  }
}
