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
private func optionsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
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
private func withOptionsGateway(
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

extension Integration {
  /// The per-chat options against the real fake gateway, over real sockets: `config.set` for fast
  /// mode, reasoning effort and the model, the gateway's "expensive model" answer that waits for the
  /// reader, the model list, and the usage the session reports.
  @Suite("Chat options") @MainActor
  struct ChatOptionsIntegrationTests {
    @Test("fast mode, reasoning effort and the model go through config.set and the chat follows the session's info")
    func switching() async throws {
      try await withOptionsGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(
          id: "g-options", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        let model = session.chat(researcher)

        await session.start()
        try await optionsWait("the socket and the roster") {
          session.status.phase == .ready && session.chatList.rows[researcher] != nil
        }
        try await session.open(researcher)
        try await optionsWait("the chat to accept a message") { model.canSend }
        #expect(model.options.fast == false)
        #expect(model.options.reasoningEffort == "medium", "from the resume's info")
        #expect(model.options.contextUsage != nil, "the fake reports usage inside the resume's info")

        #expect(await model.setFast(true) == .applied(warning: nil))
        try await optionsWait("the chat to show fast mode on") { model.options.fast }
        #expect(await model.setFast(false) == .applied(warning: nil))
        try await optionsWait("the chat to show fast mode off") { !model.options.fast }

        #expect(await model.setReasoningEffort("high") == .applied(warning: nil))
        try await optionsWait("the chat to show the new effort") { model.options.reasoningEffort == "high" }

        guard case .success(let choices) = await model.modelChoices() else {
          Issue.record("the fake gateway lists its models")
          return
        }

        let mini = try #require(choices.first { $0.model == "example-model-mini" })
        #expect(await model.setModel(mini) == .applied(warning: nil))
        try await optionsWait("the chat to show the new model") { model.options.model == mini.sessionValue }
        #expect(model.lastError == nil)

        await session.shutdown()
      }
    }

    @Test("an expensive model is handed back, writes nothing, and goes through only when confirmed")
    func expensiveModel() async throws {
      try await withOptionsGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(
          id: "g-expensive", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        let model = session.chat(researcher)

        await session.start()
        try await optionsWait("the socket and the roster") {
          session.status.phase == .ready && session.chatList.rows[researcher] != nil
        }
        try await session.open(researcher)
        try await optionsWait("the chat to accept a message") { model.canSend }
        let before = model.options.model

        guard case .success(let choices) = await model.modelChoices() else {
          Issue.record("the fake gateway lists its models")
          return
        }

        let expensive = try #require(choices.first { $0.model == "expensive-model" })

        guard case .needsConfirmation(let message) = await model.setModel(expensive) else {
          Issue.record("the gateway should have asked first")
          return
        }

        #expect(message?.isEmpty == false, "the gateway's own words come back")
        #expect(await session.store.state(of: researcher)?.info?.model == before, "nothing was written")

        #expect(await model.setModel(expensive, confirmExpensive: true) == .applied(warning: nil))
        try await optionsWait("the chat to show the expensive model") { model.options.model == expensive.sessionValue }

        await session.shutdown()
      }
    }

    @Test("a chat resumed without usage reads it from session.usage")
    func usage() async throws {
      try await withOptionsGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(
          id: "g-usage", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        let model = session.chat(researcher)

        await session.start()
        try await optionsWait("the socket and the roster") {
          session.status.phase == .ready && session.chatList.rows[researcher] != nil
        }
        try await session.open(researcher)
        try await optionsWait("the chat to accept a message") { model.canSend }

        // Whatever the resume said, `session.usage` answers with the window and what fills it.
        await model.refreshUsage()
        try await optionsWait("the usage") { model.options.contextUsage != nil }
        let usage = try #require(model.options.contextUsage)
        #expect(usage.limit > 0)
        #expect(usage.used > 0)
        #expect(usage.fraction > 0 && usage.fraction < 1)

        await session.shutdown()
      }
    }
  }
}
#endif
