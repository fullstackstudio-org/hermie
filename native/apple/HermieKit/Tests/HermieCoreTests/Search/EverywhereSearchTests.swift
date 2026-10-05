import Foundation
import Synchronization
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

// Searching every conversation of every bot on every signed-in gateway: how the gateway's hits and
// this device's own become one list (dedup, order, kind), where a tap goes, and what the model does
// with several gateways, a failing bot, a signed-out gateway and a query that is replaced.

private let now = 1_790_000_000.0

private func hit(
  _ session: String, root: String? = nil, title: String = "", snippet: String = ">>>word<<<", at: Double? = now
) -> SessionSearchHit {
  SessionSearchHit(sessionID: session, lineageRoot: root, snippet: snippet, role: "assistant", title: title, at: at)
}

private func gateway(
  _ id: String, name: String? = nil, bots: [SearchBot], ownLead: String = "", search: SearchGateway.Search?,
  cached: [String: [CachedMessage]] = [:]
) -> SearchGateway {
  SearchGateway(
    id: id, key: "", name: name ?? id, ownLead: ownLead, bots: bots, search: search,
    cachedChat: { cached[$0] })
}

private func researcher(canonical: [String] = ["chat-r", "tip-r"]) -> SearchBot {
  SearchBot(name: "researcher", displayName: "Researcher", canonicalIDs: canonical)
}

// MARK: Kinds, identity and destination

@Suite struct SearchResultKindTests {
  private let bot = researcher()
  private let source = gateway("g1", bots: [researcher()], ownLead: "Chat · Ada", search: nil)

  @Test func theBotChatIsRecognisedByAnyOfItsIds() {
    #expect(SearchMerge.kind(of: hit("chat-r"), bot: bot, ownLead: "") == .botChat)
    #expect(SearchMerge.kind(of: hit("tip-r"), bot: bot, ownLead: "") == .botChat)
    // The search answers with the tip and the root the tip was found from.
    #expect(SearchMerge.kind(of: hit("newer-tip", root: "chat-r"), bot: bot, ownLead: "") == .botChat)
  }

  @Test func aBotWithoutAResolvedChatHasNoneToRecognise() {
    let bare = SearchBot(name: "x")

    #expect(SearchMerge.kind(of: hit("chat-r", title: "Bot Chat"), bot: bare, ownLead: "") == .past)
  }

  @Test func theTitleTellsTheOtherConversationsApart() {
    #expect(SearchMerge.kind(of: hit("s1", title: "Chat · Ada · Ideas"), bot: bot, ownLead: "Chat · Ada") == .ownChat)
    #expect(SearchMerge.kind(of: hit("s2", title: "Branch · Why"), bot: bot, ownLead: "Chat · Ada") == .branch)
    #expect(SearchMerge.kind(of: hit("s3", title: "Bot Chat · 2026-10-01 10:00"), bot: bot, ownLead: "") == .past)
    #expect(SearchMerge.kind(of: hit("s4"), bot: bot, ownLead: "") == .past)
    // Nobody named: no chat is the reader's own, whatever its title.
    #expect(SearchMerge.kind(of: hit("s5", title: "Chat · Ada"), bot: bot, ownLead: "") == .past)
  }

  @Test func aResultCarriesTheGatewayTheBotAndTheNameTheReaderGaveIt() {
    let result = SearchMerge.result(of: hit("s1", title: "Branch · Why"), bot: bot, in: source)

    #expect(result.gatewayID == "g1")
    #expect(result.bot == "researcher")
    #expect(result.botName == "Researcher")
    #expect(result.kind == .branch)
    #expect(result.origins == .server)
  }
}

@Suite struct SearchRoutingTests {
  private func result(_ kind: SearchResultKind, session: String = "tip", root: String? = nil, title: String = "T")
    -> SearchResult
  {
    SearchResult(
      gatewayID: "g2", bot: "researcher", sessionID: session, lineageRoot: root, title: title, kind: kind, snippet: "")
  }

  @Test func theBotChatOpensTheBotsOwnChat() {
    #expect(
      result(.botChat).destination == SearchDestination(gatewayID: "g2", bot: "researcher", target: .botChat))
  }

  @Test func anotherConversationOpensInTheViewerUnderItsStoredAndItsTipId() {
    let destination = result(.past, session: "tip", root: "root", title: "Old one").destination

    #expect(destination.gatewayID == "g2")
    #expect(destination.target == .conversation(id: "root", resolvedID: "tip", title: "Old one"))
    // No root named: the session is its own.
    #expect(
      result(.branch, session: "only").destination.target == .conversation(id: "only", resolvedID: "only", title: "T"))
  }

  @Test func everyKindThatIsNotTheBotChatIsAConversationToRead() {
    for kind in [SearchResultKind.ownChat, .branch, .past] {
      guard case .conversation = result(kind).destination.target else {
        Issue.record("\(kind) did not open in the viewer")
        continue
      }
    }
  }
}

// MARK: Merging and dedup

@Suite struct SearchMergeTests {
  private func result(
    _ id: String = "g1", bot: String = "researcher", session: String = "s1", root: String? = nil,
    kind: SearchResultKind = .past, snippet: String = "server", at: Double? = now, origins: SearchOrigins = .server,
    title: String = "", gatewayName: String = "One"
  ) -> SearchResult {
    SearchResult(
      gatewayID: id, gatewayName: gatewayName, bot: bot, sessionID: session, lineageRoot: root, title: title,
      kind: kind, snippet: snippet, at: at, origins: origins)
  }

  @Test func theSameBotChatFoundTwiceIsOneResultThatBothSaw() {
    let server = result(session: "tip-r", kind: .botChat, snippet: ">>>server<<<", at: now)
    let local = result(session: "chat-r", kind: .botChat, snippet: ">>>local<<<", at: now - 500, origins: .cache)

    let merged = SearchMerge.merge(server: [server], local: [local])

    #expect(merged.count == 1)
    #expect(merged[0].snippet == ">>>server<<<")
    #expect(merged[0].at == now)
    #expect(merged[0].origins == [.server, .cache])
    #expect(!merged[0].cacheOnly)
  }

  @Test func theLocalOneFillsInADateTheGatewayLeftOut() {
    let server = result(kind: .botChat, at: nil)
    let local = result(kind: .botChat, snippet: "local", at: now - 10, origins: .cache)

    #expect(SearchMerge.merge(server: [server], local: [local])[0].at == now - 10)
  }

  @Test func aChatOnlyThisDeviceKnowsIsKeptAndSaysSo() {
    let local = result(kind: .botChat, origins: .cache)
    let merged = SearchMerge.merge(server: [], local: [local])

    #expect(merged.count == 1)
    #expect(merged[0].cacheOnly)
  }

  @Test func theSameBotOnAnotherGatewayIsAnotherResult() {
    let one = result("g1", kind: .botChat)
    let two = result("g2", kind: .botChat, gatewayName: "Two")

    #expect(SearchMerge.merge(server: [one, two], local: []).count == 2)
  }

  @Test func twoSessionsOfOneLineageAreOneConversation() {
    let older = result(session: "tip-1", root: "root", at: now - 100)
    let newer = result(session: "tip-2", root: "root", at: now)

    let merged = SearchMerge.merge(server: [older, newer], local: [])

    #expect(merged.count == 1)
    #expect(merged[0].sessionID == "tip-2")
  }

  @Test func differentConversationsOfOneBotAreAllKept() {
    let results = [
      result(session: "a", kind: .botChat), result(session: "b", kind: .past), result(session: "c", kind: .branch)
    ]

    #expect(SearchMerge.merge(server: results, local: []).count == 3)
  }

  @Test func newestFirstThenByGatewayAndBotSoTheOrderNeverDependsOnArrival() {
    let a = result("g1", bot: "alpha", session: "a", at: now)
    let b = result("g1", bot: "beta", session: "b", at: now)
    let c = result("g1", bot: "gamma", session: "c", at: now + 5)
    let d = result("g1", bot: "delta", session: "d", at: nil)

    for permutation in [[a, b, c, d], [d, c, b, a], [b, d, a, c]] {
      #expect(SearchMerge.merge(server: permutation, local: []).map(\.bot) == ["gamma", "alpha", "beta", "delta"])
    }
  }

  @Test func theListIsBounded() {
    let many = (0..<30).map { result(session: "s\($0)", at: now + Double($0)) }

    #expect(SearchMerge.merge(server: many, local: [], limit: 10).count == 10)
    #expect(SearchMerge.merge(server: many, local: [], limit: 10).first?.sessionID == "s29")
  }
}

// MARK: The local half

@Suite struct LocalChatSearchTests {
  private func messages() -> [CachedMessage] {
    [
      CachedMessage(id: "a", text: "We should send the invoice on Friday", at: now - 300),
      CachedMessage(id: "b", text: "Sure. Which invoice, the March one?", at: now - 200),
      CachedMessage(id: "c", text: "Totally unrelated", at: now - 100)
    ]
  }

  @Test func theNewestMessageWithEveryWordIsTheHit() throws {
    let found = try #require(LocalChatSearch.hit(in: messages(), query: "invoice"))

    #expect(found.messageID == "b")
    #expect(found.at == now - 200)
  }

  @Test func everyTermHasToLandInOneMessage() throws {
    #expect(try #require(LocalChatSearch.hit(in: messages(), query: "invoice friday")).messageID == "a")
    #expect(LocalChatSearch.hit(in: messages(), query: "invoice banana") == nil)
    #expect(LocalChatSearch.hit(in: messages(), query: "   ") == nil)
  }

  @Test func theSnippetMarksWhatMatchedInTheGatewaysOwnShape() throws {
    let found = try #require(LocalChatSearch.hit(in: messages(), query: "invoic"))
    let runs = MessageSnippet.runs(found.snippet)

    // A bare term is a word prefix, so the whole word is marked.
    #expect(runs.filter(\.match).map(\.text) == ["invoice"])
    #expect(found.snippet.contains(">>>invoice<<<"))
  }

  @Test func aQuotedTermMarksTheSubstringAndASnippetIsCutAroundIt() {
    let long = String(repeating: "lorem ipsum ", count: 30) + "the due date is near " + String(repeating: "dolor ", count: 30)
    let snippet = LocalChatSearch.snippet(of: long, terms: FindInChat.terms("\"due date\""))

    #expect(snippet.contains(">>>due date<<<"))
    #expect(snippet.hasPrefix("..."))
    #expect(snippet.hasSuffix("..."))
    #expect(snippet.count < 140)
  }

  @Test func everyTermIsMarkedInsideTheWindow() {
    let snippet = LocalChatSearch.snippet(
      of: "send the invoice to the accountant", terms: FindInChat.terms("invoice account"))

    #expect(snippet == "send the >>>invoice<<< to the >>>accountant<<<")
  }

  @Test func whitespaceIsCollapsedLikeTheGatewaysSnippetDoes() {
    let snippet = LocalChatSearch.snippet(of: "one\n\n  two\tinvoice\n", terms: FindInChat.terms("invoice"))

    #expect(snippet == "one two >>>invoice<<<")
  }

  @Test func theCachedChatOfABotIsReadFromTheStoreAndSearched() async throws {
    let store = try SQLiteStore(.inMemory)
    let cache = SQLiteChatCache(store: store, gatewayId: "g1")
    let items: [TranscriptItem] = [
      .user(UserItem(base: ItemBase(id: "u1", seq: 1, ts: now - 50, origin: .history, version: 1), text: "Remind me about the invoice")),
      .assistant(
        AssistantItem(
          base: ItemBase(id: "a1", seq: 2, origin: .history, version: 1), text: "I will.", streaming: false, interim: false))
    ]
    let snapshot = HermieTranscript.CachedTranscript(
      format: cacheFormat, items: items, subagents: [], lastSeq: 2, updatedAt: (now - 10) * 1000)

    try await cache.write(
      HermieStore.CachedTranscript(
        bot: "researcher", itemsJSON: try snapshot.jsonValue.canonicalString(), lastRowId: nil, lastSeq: 2,
        epoch: nil, updatedAt: Int64((now - 10) * 1000)))

    let messages = try #require(await LocalChatSearch.read(cache: cache, bot: "researcher"))

    #expect(messages.map(\.id) == ["u1", "a1"])
    // An item with no stamp of its own takes the snapshot's.
    #expect(messages[0].at == now - 50)
    #expect(messages[1].at == now - 10)
    #expect(LocalChatSearch.hit(in: messages, query: "invoice")?.messageID == "u1")

    #expect(await LocalChatSearch.read(cache: cache, bot: "nobody") == nil)
  }

  @Test func aCacheThatCannotBeReadIsNothingToSearch() async throws {
    let store = try SQLiteStore(.inMemory)
    let cache = SQLiteChatCache(store: store, gatewayId: "g1")

    try await cache.write(
      HermieStore.CachedTranscript(bot: "x", itemsJSON: "not json", lastRowId: nil, lastSeq: nil, epoch: nil, updatedAt: 1))

    #expect(await LocalChatSearch.read(cache: cache, bot: "x") == nil)
  }
}

// MARK: The model

@MainActor
@Suite struct EverywhereSearchModelTests {
  private func model(
    _ sources: [SearchGateway], debounce: Duration = .zero, concurrency: Int = 4
  ) -> EverywhereSearchModel {
    EverywhereSearchModel(debounce: debounce, concurrency: concurrency, gateways: { sources })
  }

  @Test func everyBotOfEveryGatewayIsAskedAndTheResultsAreOneList() async {
    let one = SearchScript(answers: [
      "researcher": .success([hit("tip-r", title: "Bot Chat", at: now), hit("old", title: "Old one", at: now - 50)]),
      "writer": .success([hit("w1", at: now - 20)])
    ])
    let two = SearchScript(answers: ["researcher": .success([hit("g2-chat", at: now + 10)])])
    let model = model([
      gateway("g1", name: "One", bots: [researcher(), SearchBot(name: "writer", canonicalIDs: ["w1"])], search: one.search),
      gateway("g2", name: "Two", bots: [researcher(canonical: ["g2-chat"])], search: two.search)
    ])

    await model.run(query: "word")

    #expect(model.query == "word")
    #expect(!model.searching)
    #expect(!model.failed)
    #expect(model.unreachable.isEmpty)
    #expect(Set(one.calls.map(\.profile)) == ["researcher", "writer"])
    #expect(two.calls.map(\.profile) == ["researcher"])
    #expect(one.calls.allSatisfy { $0.query == "word" && $0.limit == EverywhereSearchTuning.limitPerBot })
    // More than one conversation of a bot, and more than one gateway, newest first.
    #expect(model.results.map(\.sessionID) == ["g2-chat", "tip-r", "w1", "old"])
    #expect(model.results.map(\.gatewayID) == ["g2", "g1", "g1", "g1"])
    #expect(model.results.map(\.kind) == [.botChat, .botChat, .botChat, .past])
  }

  @Test func oneBotsFailureIsOneMissingBotAndNotAFailedSearch() async {
    let script = SearchScript(answers: [
      "researcher": .success([hit("tip-r")]), "writer": .failure(SearchRefused())
    ])
    let model = model([
      gateway("g1", bots: [researcher(), SearchBot(name: "writer")], search: script.search)
    ])

    await model.run(query: "word")

    #expect(model.results.count == 1)
    #expect(model.unreachable.isEmpty)
    #expect(!model.failed)
  }

  @Test func aGatewayEveryBotOfWhichFailedIsNamedAndTheOthersStillAnswer() async {
    let down = SearchScript(answers: ["researcher": .failure(SearchRefused())])
    let up = SearchScript(answers: ["researcher": .success([hit("g2-chat")])])
    let model = model([
      gateway("g1", name: "Down", bots: [researcher()], search: down.search),
      gateway("g2", name: "Up", bots: [researcher(canonical: ["g2-chat"])], search: up.search)
    ])

    await model.run(query: "word")

    #expect(model.unreachable == ["Down"])
    #expect(!model.failed)
    #expect(model.results.map(\.gatewayID) == ["g2"])
  }

  @Test func aSignedOutGatewayIsNamedAndItsLocalCopyStillAnswers() async {
    let model = model([
      gateway(
        "g1", name: "Signed out", bots: [researcher()], search: nil,
        cached: ["researcher": [CachedMessage(id: "m", text: "the word is here", at: now)]])
    ])

    await model.run(query: "word")

    #expect(model.unreachable == ["Signed out"])
    #expect(model.failed)
    #expect(model.results.count == 1)
    #expect(model.results[0].cacheOnly)
    #expect(model.results[0].kind == .botChat)
    #expect(model.results[0].destination.target == .botChat)
  }

  @Test func theGatewaysAnswerAndTheLocalCopyOfOneChatAreOneResult() async {
    let script = SearchScript(answers: ["researcher": .success([hit("tip-r", snippet: "the >>>word<<<", at: now)])])
    let model = model([
      gateway(
        "g1", bots: [researcher()], search: script.search,
        cached: ["researcher": [CachedMessage(id: "m", text: "the word", at: now - 5)]])
    ])

    await model.run(query: "word")

    #expect(model.results.count == 1)
    #expect(model.results[0].origins == [.server, .cache])
    #expect(model.results[0].snippet == "the >>>word<<<")
  }

  @Test func whatThisDeviceFoundIsShownWhileTheGatewaysAreStillBeingAsked() async {
    let script = SearchScript(gated: true, answers: ["researcher": .success([hit("tip-r")])])
    let model = model([
      gateway(
        "g1", bots: [researcher()], search: script.search,
        cached: ["researcher": [CachedMessage(id: "m", text: "the word", at: now - 5)]])
    ])

    let task = Task { await model.run(query: "word") }

    await waitUntil("the local answer") { model.query == "word" && !model.results.isEmpty }

    #expect(model.searching)
    #expect(model.results[0].cacheOnly)

    script.gate.open()
    await task.value

    #expect(!model.searching)
    #expect(model.results[0].origins == [.server, .cache])
  }

  @Test func aBlankQueryAsksNobodyAndAnEmptiedFieldClearsAtOnce() async {
    let script = SearchScript(answers: ["researcher": .success([hit("tip-r")])])
    let model = model([gateway("g1", bots: [researcher()], search: script.search)])

    await model.run(query: "   ")
    #expect(script.calls.isEmpty)
    #expect(model.results.isEmpty)

    await model.run(query: "word")
    #expect(!model.results.isEmpty)

    await model.run(query: "")
    #expect(model.results.isEmpty)
    #expect(model.query.isEmpty)
    #expect(!model.searching)
  }

  @Test func aSupersededQueryIsAbandonedAndNeverPaintsOverTheNewerOne() async {
    // The first query's gateway answers late, and with the old words; the second's at once.
    let gate = SearchGate()
    let started = Mutex(0)
    let search: SearchGateway.Search = { _, query, _, _ in
      if query == "first" {
        started.withLock { $0 += 1 }
        try await gate.wait()
        return [hit("tip-r", snippet: "OLD")]
      }

      return [hit("tip-r", snippet: "NEW")]
    }
    let model = model([gateway("g1", bots: [researcher()], search: search)])

    let first = Task { await model.run(query: "first") }

    await waitUntil("the first search to go out") { started.withLock { $0 } == 1 }

    await model.run(query: "second")
    gate.open()
    await first.value

    #expect(model.query == "second")
    #expect(model.results.map(\.snippet) == ["NEW"])
    #expect(!model.searching)
  }

  @Test func searchesAreBoundedAcrossEveryGateway() async {
    let script = SearchScript(gated: true)
    let bots = (0..<6).map { SearchBot(name: "bot\($0)") }
    let model = model(
      [gateway("g1", bots: bots, search: script.search), gateway("g2", bots: bots, search: script.search)],
      concurrency: 3)

    let task = Task { await model.run(query: "word") }

    await waitUntil("three searches in flight") { script.calls.count >= 3 }
    try? await Task.sleep(for: .milliseconds(50))
    #expect(script.peak == 3)

    script.gate.open()
    await task.value

    #expect(script.calls.count == 12)
    #expect(script.peak <= 3)
  }

  @Test func theQueryIsSentTrimmedAndWithoutAGatewayWithNothingToAsk() async {
    let script = SearchScript()
    let model = model([
      gateway("g1", bots: [researcher()], search: script.search), gateway("g2", bots: [], search: script.search)
    ])

    await model.run(query: "  word  ")

    #expect(script.calls.map(\.query) == ["word"])
    #expect(model.results.isEmpty)
    // A gateway with no bots was not "unreachable": there was nothing to ask.
    #expect(model.unreachable.isEmpty)
  }
}
