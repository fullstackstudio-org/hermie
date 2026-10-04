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
private func yoloWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
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
private func withYoloGateway(
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

extension Integration {
  /// YOLO mode against the real fake gateway, over real sockets: `config.set` scoped to the session,
  /// and the chat reading the answer back from the session's info.
  @Suite("YOLO mode") @MainActor
  struct YoloIntegrationTests {
    @Test("switching it on and off goes through config.set and the chat follows the session's info")
    func switching() async throws {
      try await withYoloGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(
          id: "g-yolo", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        let model = session.chat(researcher)

        await session.start()
        try await yoloWait("the socket and the roster") {
          session.status.phase == .ready && session.chatList.rows[researcher] != nil
        }
        try await session.open(researcher)
        try await yoloWait("the chat to accept a message") { model.canSend }
        #expect(model.yolo == false)

        #expect(await model.setYolo(true) == .switched(true))
        try await yoloWait("the chat to show YOLO mode on") { model.yolo }
        #expect(await session.store.state(of: researcher)?.info?.yolo == true, "the gateway's own word")

        #expect(await model.setYolo(false) == .switched(false))
        try await yoloWait("the chat to show YOLO mode off") { !model.yolo }
        #expect(await session.store.state(of: researcher)?.info?.yolo == false)
        #expect(model.lastError == nil)

        await session.shutdown()
      }
    }
  }
}
#endif
