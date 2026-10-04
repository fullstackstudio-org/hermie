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
private func searchWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, ready, as the app holds one.
@MainActor
private func readySession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-message-search", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await searchWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.rows[researcher] != nil && session.searchableBots.count > 1
  }
  return session
}

/// What a walk did, held where the main actor's closures can write it.
@MainActor
private final class WalkLog {
  var revealed: [String] = []
  var settled: [ChatFindWalk.Outcome] = []

  func walk(_ query: String, over chat: ChatModel) -> ChatFindWalk {
    ChatFindWalk(
      query: query,
      hooks: .chat(
        chat,
        reveal: { [self] id in
          revealed.append(id)
          return true
        },
        revision: { chat.snapshot?.revision ?? 0 }),
      onSettled: { [self] in settled.append($0) }
    )
  }
}

private func withSearchSession(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in
    let session = try await readySession(gateway)

    do {
      try await body(gateway, session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension Integration {
  /// The message search against the real fake gateway, over real HTTP: `MessageSearchModel` on a
  /// `GatewaySession`'s link (`GET /api/sessions/search`, one request per bot), and the walk that finds the
  /// row a hit is about through the REST transcript's pages.
  @Suite("Message search") @MainActor
  struct MessageSearchIntegrationTests {
    @Test("every bot's chat is searched, and a hit is the bot's own Bot Chat")
    func searchesTheRoster() async throws {
      try await withSearchSession { _, session in
        let model = session.messageSearch()
        let bots = session.searchableBots

        await model.run(query: "introduce", bots: bots, ready: true)

        #expect(model.query == "introduce")
        #expect(!model.failed)
        #expect(model.matches.count > 1)

        for match in model.matches {
          let bot = try #require(bots.first { $0.name == match.bot })
          #expect(match.sessionID == bot.canonical?.id)
          #expect(match.at != nil)
          // The gateway's markers survive to the UI, and what they hold is what was asked for.
          let matched = MessageSnippet.runs(match.snippet).filter(\.match).map { $0.text.lowercased() }
          #expect(matched.contains("introduce"))
        }
      }
    }

    @Test("a partial word, and every word in the one message, as the gateway reads them")
    func readsTheQueryTheWayTheGatewayDoes() async throws {
      try await withSearchSession { _, session in
        let model = session.messageSearch()
        let bots = session.searchableBots

        await model.run(query: "introd", bots: bots, ready: true)
        #expect(!model.matches.isEmpty)

        // Both words are in the roster, in different messages.
        await model.run(query: "introduce service", bots: bots, ready: true)
        #expect(model.matches.isEmpty)
        #expect(!model.failed)
        #expect(model.query == "introduce service")
      }
    }

    @Test("a query nobody's chat holds is none, not a failure")
    func findsNothing() async throws {
      try await withSearchSession { _, session in
        let model = session.messageSearch()

        await model.run(query: "zzzqqqxxx", bots: session.searchableBots, ready: true)

        #expect(model.matches.isEmpty)
        #expect(!model.failed)
        #expect(!model.searching)
      }
    }

    @Test("a profile the gateway does not have costs its own row; all of them missing is a failed search")
    func survivesAnUnknownProfile() async throws {
      try await withSearchSession { _, session in
        let model = session.messageSearch()
        let ghost = Bot(name: "nobody", canonical: CanonicalSession(id: "stored-nobody", resolvedID: "stored-nobody"))

        await model.run(query: "introduce", bots: session.searchableBots + [ghost], ready: true)
        #expect(model.matches.count > 1)
        #expect(!model.failed)
        #expect(!model.matches.contains { $0.bot == "nobody" })

        await model.run(query: "introduce", bots: [ghost], ready: true)
        #expect(model.matches.isEmpty)
        #expect(model.failed)
      }
    }

    @Test("the row a hit is about is found in the chat, and the walk pages back through history to it")
    func walksBackToTheRow() async throws {
      var options = FakeGateway.Options()
      options.extraArguments = ["--history-rows", "450"]

      try await withSearchSession(options) { _, session in
        // The gateway's own answer for words only the oldest rows hold.
        let search = session.messageSearch()
        let query = "\"attempt2 =\""

        await search.run(query: query, bots: session.searchableBots, ready: true)
        let hit = try #require(search.matches.first { $0.bot == researcher })
        #expect(MessageSnippet.runs(hit.snippet).contains { $0.match })

        // Open the chat the hit names. It holds a window of the newest rows; the match is further back.
        try await session.open(researcher)
        let chat = session.chat(researcher)
        try await searchWait("the chat to be live") { chat.hydration == .live }
        let loaded = chat.items.count

        #expect(FindInChat.newestMatch(in: chat.items, query: query) == nil)
        #expect(chat.snapshot?.canLoadOlder == true)

        let log = WalkLog()
        let walk = log.walk(query, over: chat)

        // The screen steps after every rebuild of its rows; here, every few milliseconds.
        try await searchWait("the walk to settle") {
          walk.step()
          return !log.settled.isEmpty
        }

        let id = try #require(log.revealed.first)
        let item = try #require(chat.items.first { $0.item.id == id })
        #expect(log.settled == [.found(itemID: id)])
        #expect(FindInChat.text(of: item.item).contains("attempt2 ="))
        // It took history that was not there to begin with.
        #expect(chat.items.count > loaded)
        #expect(walk.pages >= 1)
      }
    }

    @Test("words no row of the chat holds end the walk with a miss, and the list is left alone")
    func missesWhatIsNotVisible() async throws {
      try await withSearchSession { _, session in
        try await session.open(researcher)
        let chat = session.chat(researcher)
        try await searchWait("the chat to be live") { chat.hydration == .live }

        let log = WalkLog()
        let walk = log.walk("qqqnotthere", over: chat)

        try await searchWait("the walk to settle") {
          walk.step()
          return !log.settled.isEmpty
        }

        #expect(log.settled == [.notFound])
      }
    }
  }
}
#endif
