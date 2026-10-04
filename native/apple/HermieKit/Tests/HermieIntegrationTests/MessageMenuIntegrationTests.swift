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
private func menuWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a body on the main actor, where the models live.
private func withMenuGateway(
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

extension Integration {
  /// The message menu's Branch from here against the real fake gateway, over real sockets:
  /// `session.branch` with the runtime id and the message count, and the branch listed afterwards.
  @Suite("Message menu") @MainActor
  struct MessageMenuIntegrationTests {
    @Test("Branch from here forks the chat at the message and the branch is listed under Branches")
    func branchFromHere() async throws {
      try await withMenuGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(
          id: "g-menu", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        let model = session.chat(researcher)

        await session.start()
        try await menuWait("the socket and the roster") {
          session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
        }
        try await session.open(researcher)
        try await menuWait("the chat to hold its history") { model.canSend && !model.items.isEmpty }

        // Any message of the chat: the first one has the shortest history behind it.
        let message = try #require(model.items.first { MessageMenu.words(of: $0.item) != nil })
        let state = try #require(await session.store.state(of: researcher))
        let expected = BranchPoint.messageCount(
          in: state.order.compactMap { state.items[$0] }.map { (id: $0.id, rowID: $0.rowID) }, upTo: message.item.id)

        let outcome = await model.branch(from: message.item.id)
        guard case .branched(let branch) = outcome else {
          Issue.record("expected a branch, got \(outcome)")
          await session.shutdown()
          return
        }

        #expect(branch.kind == .branch)
        #expect(branch.title.hasPrefix("Branch"))
        #expect(model.lastError == nil)

        let conversations = session.conversations(for: researcher)
        await conversations.load()
        let groups = try #require(conversations.groups)
        let listed = try #require(groups.branches.first { $0.id == branch.id }, "the branch is listed")
        #expect(listed.title == branch.title)
        #expect(listed.messageCount == max(1, expected), "the gateway kept the rows up to the message")
        #expect(groups.canonical != nil, "the chat the branch came from is still there")

        await session.shutdown()
      }
    }
  }
}
#endif
