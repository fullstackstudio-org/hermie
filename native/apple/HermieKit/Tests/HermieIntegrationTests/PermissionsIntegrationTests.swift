#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let researcher = "researcher"
private let writer = "writer"

/// Wait for a condition the runtime reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func permissionsWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

private func withPermissionsSession(
  log: DecisionLog? = nil,
  _ body: @escaping @MainActor @Sendable (FakeGateway, GatewaySession) async throws -> Void
) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    options.decisions = log
    let record = GatewayRecord(
      id: "g-permissions", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try await MainActor.run {
      try GatewaySession(
        record: record,
        credentials: SessionTokenCredentials(token: ""),
        database: try SQLiteStore(.inMemory),
        options: options
      )
    }

    await session.start()

    do {
      try await permissionsWait("the socket and the roster") {
        session.status.phase == .ready && session.chatList.refreshed && session.chatList.rows[researcher] != nil
      }
      try await body(gateway, session)
    } catch {
      await session.shutdown()
      throw error
    }

    await session.shutdown()
  }
}

extension FakeGateway {
  /// `POST /__fake/approvals`: stage the standing and session approvals, the mode, `clear` or `unsupported`.
  @discardableResult
  fileprivate func stageApprovals(_ fields: JSONObject) async throws -> JSONValue {
    try await control("POST", "/__fake/approvals", body: .object(fields))
  }

  /// `GET /__fake/approvals`: what the gateway holds (labels) and every approval call's method, profile and keys.
  fileprivate func approvalContents() async throws -> JSONValue {
    try await control("GET", "/__fake/approvals")
  }
}

private func labels(_ value: JSONValue?) -> [String] {
  (value?.arrayValue ?? []).compactMap(\.stringValue).sorted()
}

extension Integration {
  /// A bot's permissions against the real fake gateway, over a real socket: what is listed for the bot's own
  /// profile and nobody else's, that a revoke asks first, takes effect on the gateway and is read back, and
  /// that a refusal is told apart.
  @Suite("Permissions") @MainActor
  struct PermissionsIntegrationTests {
    @Test("the page lists the bot's own standing and session approvals and the mode, and no other bot's")
    func listsTheBotsOwn() async throws {
      try await withPermissionsSession { gateway, session in
        try await gateway.stageApprovals([
          "mode": .string("smart"),
          "permanent": .array([
            .object(["profile": .string(researcher), "kind": .string("pattern"), "label": .string("recursive delete; force delete")]),
            .object(["profile": .string(researcher), "kind": .string("glob"), "label": .string("podman *")]),
            .object(["profile": .string(writer), "kind": .string("command"), "label": .string("the writer's own")])
          ]),
          "session": .array([
            .object(["profile": .string(researcher), "label": .string("script execution via heredoc")]),
            .object(["profile": .string(writer), "label": .string("the writer's session rule")])
          ])
        ])

        let model = session.permissions(for: researcher)
        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.mode == .smart)
        #expect(model.permanent.map(\.label).sorted() == ["force delete; recursive delete", "podman *"])
        #expect(model.permanent.contains { $0.kind == .glob && $0.label == "podman *" })
        #expect(model.sessions.count == 1)
        #expect(model.sessions.first?.grants.map(\.label) == ["script execution via heredoc"])
        #expect(model.sessions.first?.yolo == false)
        #expect(model.count == 3)
        #expect(model.sessions.first?.sessionKey.isEmpty == false, "the stored id comes with the session")

        // Every call named the bot's profile.
        let calls = try await gateway.approvalContents()["calls"]?.arrayValue ?? []
        #expect(!calls.isEmpty && calls.allSatisfy { $0["profile"]?.stringValue == researcher })

        let other = session.permissions(for: writer)
        await other.load()
        #expect(other.permanent.map(\.label) == ["the writer's own"])
        #expect(other.sessions.first?.grants.map(\.label) == ["the writer's session rule"])
      }
    }

    @Test("nothing staged is empty lists and the manual mode")
    func empty() async throws {
      try await withPermissionsSession { _, session in
        let model = session.permissions(for: researcher)

        await model.load()

        #expect(model.phase == .loaded)
        #expect(model.mode == .manual)
        #expect(model.permanent.isEmpty)
        #expect(model.sessions.isEmpty)
        #expect(model.count == 0)
      }
    }

    @Test("a standing approval is revoked only after the confirmation, on the gateway, and the list is read again")
    func revokesOne() async throws {
      let log = try DecisionLog(store: SQLiteStore(.inMemory))

      try await withPermissionsSession(log: log) { gateway, session in
        try await gateway.stageApprovals([
          "permanent": .array([
            .object(["profile": .string(researcher), "label": .string("one rule")]),
            .object(["profile": .string(researcher), "label": .string("another rule")]),
            .object(["profile": .string(writer), "label": .string("one rule")])
          ])
        ])
        let model = session.permissions(for: researcher)
        await model.load()
        let first = try #require(model.permanent.first { $0.label == "one rule" })
        let question = PermissionRevocation(scope: .permanent, grant: first)

        model.ask(question)
        model.cancel()
        #expect(labels(try await gateway.approvalContents()["permanent"]?[researcher]) == ["another rule", "one rule"])

        // As SwiftUI does it: the dialog dismisses itself, then the yes runs with what it presented.
        model.ask(question)
        model.cancel()
        #expect(await model.confirm(question))

        #expect(model.permanent.map(\.label) == ["another rule"])
        let held = try await gateway.approvalContents()
        #expect(labels(held["permanent"]?[researcher]) == ["another rule"])
        #expect(labels(held["permanent"]?[writer]) == ["one rule"], "another bot's grants are not touched")

        // The decision log has the revoke, with the label.
        let entries = await log.entries()
        #expect(entries.count == 1)
        #expect(entries.first?.kind == .permissionRevoked)
        #expect(entries.first?.summary == "one rule")
        #expect(entries.first?.bot == researcher)
        #expect(entries.first?.gatewayID == "g-permissions")

        // An id the gateway no longer has revokes nothing and is not an error.
        #expect(!(await model.confirm(question)))
        #expect(model.actionFailure == nil)
        #expect(await log.count() == 1)
      }
    }

    @Test("revoke all takes the bot's standing approvals and only those")
    func revokesAll() async throws {
      try await withPermissionsSession { gateway, session in
        try await gateway.stageApprovals([
          "permanent": .array([
            .object(["profile": .string(researcher), "label": .string("one")]),
            .object(["profile": .string(researcher), "label": .string("two")]),
            .object(["profile": .string(writer), "label": .string("one")])
          ]),
          "session": .array([.object(["profile": .string(researcher), "label": .string("a session rule")])])
        ])
        let model = session.permissions(for: researcher)
        await model.load()

        #expect(await model.confirm(PermissionRevocation(scope: .permanent, grant: nil)))

        #expect(model.permanent.isEmpty)
        #expect(model.sessions.first?.grants.count == 1, "the session's approvals are another scope")
        let held = try await gateway.approvalContents()
        #expect(labels(held["permanent"]?[researcher]) == [])
        #expect(labels(held["permanent"]?[writer]) == ["one"])
      }
    }

    @Test("a session approval is revoked on the session, one or all, and the others stay")
    func revokesSessionGrants() async throws {
      try await withPermissionsSession { gateway, session in
        try await gateway.stageApprovals([
          "session": .array([
            .object(["profile": .string(researcher), "label": .string("rule one")]),
            .object(["profile": .string(researcher), "label": .string("rule two")]),
            .object(["profile": .string(writer), "label": .string("writer rule")])
          ])
        ])
        let model = session.permissions(for: researcher)
        await model.load()
        let chat = try #require(model.sessions.first)
        let one = try #require(chat.grants.first { $0.label == "rule one" })

        #expect(await model.confirm(PermissionRevocation(scope: .session(chat.sessionID), grant: one)))
        #expect(model.sessions.first?.grants.map(\.label) == ["rule two"])

        #expect(await model.confirm(PermissionRevocation(scope: .session(chat.sessionID), grant: nil)))
        #expect(model.sessions.first?.grants.isEmpty ?? true)

        let other = session.permissions(for: writer)
        await other.load()
        #expect(other.sessions.first?.grants.map(\.label) == ["writer rule"])
      }
    }

    @Test("an agent's refusal (4033) is told apart, and nothing is taken off the page")
    func refused() async throws {
      try await withPermissionsSession { gateway, session in
        try await gateway.stageApprovals([
          "permanent": .array([.object(["profile": .string(researcher), "label": .string("one rule")])])
        ])
        let model = session.permissions(for: researcher)
        await model.load()

        try await gateway.control(
          "POST", "/__fake/deny",
          body: .object([
            "methods": ["approval.revoke"], "code": 4033, "message": "an agent may not revoke an approval"
          ]))

        #expect(!(await model.confirm(PermissionRevocation(scope: .permanent, grant: model.permanent[0]))))
        #expect(model.actionFailure == .refused)
        #expect(model.permanent.map(\.label) == ["one rule"])

        try await gateway.control("POST", "/__fake/deny", body: .object(["clear": true]))
        try await gateway.control(
          "POST", "/__fake/deny", body: .object(["methods": ["approval.grants"], "code": 4033]))

        let fresh = session.permissions(for: researcher)
        await fresh.load()

        #expect(fresh.phase == .failed(.refused))
      }
    }

    @Test("a profile the gateway does not serve is told apart (4064)")
    func unknownProfile() async throws {
      try await withPermissionsSession { _, session in
        let model = session.permissions(for: "nobody")

        await model.load()

        #expect(model.phase == .failed(.unknownProfile))
      }
    }

    @Test("a gateway without the approval methods says so")
    func unsupported() async throws {
      try await withPermissionsSession { gateway, session in
        try await gateway.stageApprovals(["unsupported": .bool(true)])
        let model = session.permissions(for: researcher)

        await model.load()

        #expect(model.phase == .failed(.unsupported))
      }
    }
  }
}
#endif
