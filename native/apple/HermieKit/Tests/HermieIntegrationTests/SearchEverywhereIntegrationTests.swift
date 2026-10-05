#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func everywhereWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway with the researcher's chat open, as the app holds one.
@MainActor
private func everywhereSession(_ gateway: FakeGateway, id: String) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(id: id, name: id, address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await everywhereWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
      && session.searchableBots.count > 1
  }
  try await session.open(researcher)

  return session
}

/// Branch the researcher's live chat the way the web client's chat menu does, answering the child's
/// stored id.
@MainActor
private func everywhereBranch(_ session: GatewaySession, name: String, count: Int) async throws -> String {
  let runtime = try #require(await session.store.sessionIDs()[researcher]?.runtime)
  let reply = try await session.link.requestReply(
    RPC.SessionBranch.name,
    params: .object(SessionBranchParams(sessionID: runtime, profile: researcher, name: name, count: count).json)
  )

  return try #require(SessionBranchResult(json: reply.result.objectValue ?? [:]).storedSessionID)
}

private func withEverywhereSession(
  _ body: @escaping @MainActor @Sendable (GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    let session = try await everywhereSession(gateway, id: "g-everywhere")

    do {
      try await body(session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

/// Two fake gateways, each with a session of its own.
private func withTwoEverywhereSessions(
  _ body: @escaping @MainActor @Sendable (GatewaySession, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { first in
    try await FakeGateway.with(FakeGateway.Options()) { second in
      let one = try await everywhereSession(first, id: "g-one")
      let two = try await everywhereSession(second, id: "g-two")

      do {
        try await body(one, two)
      } catch {
        await one.shutdown()
        await two.shutdown()
        throw error
      }

      await one.shutdown()
      await two.shutdown()
    }
  }
}

extension Integration {
  /// Search Everywhere against the real fake gateway, over real HTTP: every conversation of a bot (not only
  /// its Bot Chat), the gateway's hits merged with this device's own copy, more than one gateway at a time,
  /// a gateway that cannot be asked, and the row the words are in found in the conversation a hit names.
  @Suite("Search everywhere") @MainActor
  struct SearchEverywhereIntegrationTests {
    private func model(_ gateways: [SearchGateway]) -> EverywhereSearchModel {
      EverywhereSearchModel(debounce: .zero, gateways: { gateways })
    }

    @Test("a bot's Bot Chat and its branch are both found, each as what it is")
    func everyConversationOfABot() async throws {
      try await withEverywhereSession { session in
        let child = try await everywhereBranch(session, name: "Branch · the first idea", count: 2)
        let search = model([session.searchGateway(key: "", name: "Fake")])

        await search.run(query: "introduce")

        let mine = search.results.filter { $0.bot == researcher }

        #expect(!search.failed)
        #expect(search.unreachable.isEmpty)
        #expect(mine.count == 2)
        #expect(Set(mine.map(\.kind)) == [.botChat, .branch])

        let branch = try #require(mine.first { $0.kind == .branch })

        #expect(branch.title == "Branch · the first idea")
        #expect(branch.sessionID == child)
        #expect(branch.destination.target == .conversation(id: child, resolvedID: child, title: branch.title))
        #expect(branch.gatewayID == session.gatewayID)

        let chat = try #require(mine.first { $0.kind == .botChat })

        #expect(chat.destination.target == .botChat)
        #expect(chat.sessionID == session.chatList.rows[researcher]?.bot.canonical?.id)
        // The gateway's own snippet, with what matched marked.
        #expect(MessageSnippet.runs(chat.snippet).filter(\.match).map { $0.text.lowercased() }.contains("introduce"))
      }
    }

    @Test("the chat this session holds and the gateway's hit for it are one result that both saw")
    func mergedWithTheLocalCopy() async throws {
      try await withEverywhereSession { session in
        let search = model([session.searchGateway(key: "", name: "Fake")])

        await search.run(query: "introduce")

        let chat = try #require(search.results.first { $0.bot == researcher && $0.kind == .botChat })

        #expect(chat.origins == [.server, .cache])
        #expect(search.results.filter { $0.bot == researcher && $0.kind == .botChat }.count == 1)
      }
    }

    @Test("a hit's words are found again in the conversation it names")
    func findsTheRowInTheConversationAHitNames() async throws {
      try await withEverywhereSession { session in
        let child = try await everywhereBranch(session, name: "Branch · the first idea", count: 2)
        let search = model([session.searchGateway(key: "", name: "Fake")])

        await search.run(query: "introduce")

        let branch = try #require(search.results.first { $0.kind == .branch })
        guard case let .conversation(id, resolvedID, title) = branch.destination.target else {
          Issue.record("a branch did not open in the viewer")
          return
        }

        #expect(id == child)

        let viewer = session.conversationViewer(
          bot: researcher, conversation: Conversation(id: id, resolvedID: resolvedID, title: title, kind: .branch))

        await viewer.load()
        #expect(viewer.phase == .ready)

        var revealed: [String] = []
        var settled: [ChatFindWalk.Outcome] = []
        let walk = ChatFindWalk(
          query: search.query,
          hooks: .conversation(
            viewer,
            reveal: { itemID in
              revealed.append(itemID)
              return true
            },
            revision: { viewer.revision }),
          onSettled: { settled.append($0) })

        walk.step()

        try await everywhereWait("the walk to settle") { !settled.isEmpty }

        let found = try #require(revealed.first)
        #expect(settled == [.found(itemID: found)])
        #expect(
          viewer.items.contains { FindInChat.text(of: $0.item).lowercased().contains("introduce") && $0.item.id == found })
      }
    }

    @Test("more than one gateway is searched at once, and each result names its own")
    func twoGateways() async throws {
      try await withTwoEverywhereSessions { one, two in
        let search = EverywhereSearchModel(
          debounce: .zero,
          gateways: { [one.searchGateway(key: "", name: "One"), two.searchGateway(key: "", name: "Two")] })

        await search.run(query: "introduce")

        let gateways = Set(search.results.map(\.gatewayID))

        #expect(gateways == ["g-one", "g-two"])
        // The same bot on two gateways is two results, and each opens on its own gateway.
        #expect(search.results.filter { $0.bot == researcher }.count == 2)
        #expect(Set(search.results.filter { $0.bot == researcher }.map(\.destination.gatewayID)) == gateways)
        #expect(search.unreachable.isEmpty)
      }
    }

    @Test("a gateway that cannot be asked is named, and what this device kept of its chats still answers")
    func aGatewayThatIsDown() async throws {
      try await withEverywhereSession { session in
        let live = session.searchGateway(key: "", name: "Fake")
        var down = live
        down.id = "g-down"
        down.name = "Down"
        down.search = { _, _, _, _ in throw GatewayError(.network, "unreachable") }

        let search = model([live, down])

        await search.run(query: "introduce")

        #expect(search.unreachable == ["Down"])
        #expect(!search.failed)
        // The live gateway answered, and the dead one's copy of the chat answers for it.
        let results = search.results.filter { $0.bot == researcher && $0.kind == .botChat }

        #expect(Set(results.map(\.gatewayID)) == ["g-everywhere", "g-down"])
        #expect(results.first { $0.gatewayID == "g-down" }?.cacheOnly == true)
      }
    }

    @Test("nothing found is none, and a blank query never leaves the device")
    func nothingFound() async throws {
      try await withEverywhereSession { session in
        let search = model([session.searchGateway(key: "", name: "Fake")])

        await search.run(query: "zzzqqqxxx")

        #expect(search.query == "zzzqqqxxx")
        #expect(search.results.isEmpty)
        #expect(!search.failed)
        #expect(!search.searching)

        await search.run(query: "   ")
        #expect(search.query.isEmpty)
      }
    }
  }
}
#endif
