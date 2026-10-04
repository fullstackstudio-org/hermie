#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
func capabilityWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// A session on the fake gateway, connected and with its roster read, as the app holds one: what the
/// capability pages (Memory, Skills, MCP servers, Connectors, Boards) read their gateway through.
@MainActor
func connectedCapabilitySession(_ gateway: FakeGateway) async throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }
  let record = GatewayRecord(
    id: "g-capabilities", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
  let session = try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    database: try SQLiteStore(.inMemory),
    options: options
  )

  await session.start()
  try await capabilityWait("the socket and the roster") {
    session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows["researcher"] != nil
  }

  return session
}

/// A fake gateway started with `options`, a connected session, and a body on the main actor where the
/// models live; the session is shut down after it, however it ends.
func withCapabilitySession(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (GatewaySession, FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in
    let session = try await connectedCapabilitySession(gateway)

    do {
      try await body(session, gateway)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}
#endif
