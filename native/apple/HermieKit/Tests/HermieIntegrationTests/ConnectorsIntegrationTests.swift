#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// What a connect walk opens the link with: records it. A class, because a closure that mutates a local
/// across the walk's suspensions is what the Swift 6.4 runtime crashes on.
@MainActor
private final class Browser {
  var opened: [URL] = []

  func open(_ url: URL) -> Bool {
    opened.append(url)

    return true
  }
}

extension Integration {
  /// The Connectors page's model against the real fake gateway, over a real socket: the account's list,
  /// a connect that is followed until it settles, and the gateway with connectors switched off.
  @Suite("Connectors") @MainActor
  struct ConnectorsIntegrationTests {
    private func withModel(
      _ options: FakeGateway.Options = FakeGateway.Options(),
      profile: String? = "researcher",
      _ body: @escaping @MainActor @Sendable (GatewaySession, ConnectorsModel, FakeGateway) async throws -> Void
    ) async throws {
      try await withCapabilitySession(options) { session, gateway in
        let model = ConnectorsModel(
          service: ConnectorsService(gateway: .link(session.link)), profile: profile, pollInterval: .milliseconds(10))
        await model.load()

        try await body(session, model, gateway)
      }
    }

    @Test("the account's connectors are listed with how each stands, and no chat is open")
    func lists() async throws {
      try await withModel { _, model, _ in
        #expect(model.phase == .ready)
        #expect(model.connectors.map(\.slug) == ["gmail", "notion", "slack"])
        #expect(model.connector("gmail")?.connected == true)
        #expect(model.connector("notion")?.connected == false)
        #expect(model.connector("slack")?.enabled == false)
        #expect(model.connector("slack")?.statusReason == "the workspace revoked the token")
        #expect(model.connector("slack")?.connectionStatus == "failed")
      }
    }

    @Test("a connect opens the vendor's link, follows the operation and reads the list after")
    func connects() async throws {
      try await withModel { _, model, _ in
        let browser = Browser()

        let done = await model.connect("notion", open: browser.open)

        #expect(done)
        #expect(browser.opened.count == 1)
        #expect(browser.opened.first?.host == "vendor.test")
        #expect(model.notice == .connected("notion"))
        #expect(model.connecting == nil)
      }
    }

    @Test("a connector the vendor refuses is told in the vendor's words")
    func aRefusedConnect() async throws {
      try await withModel { _, model, _ in
        #expect(await model.connect("slack", open: Browser().open) == false)
        #expect(model.notice == .failed("the workspace refused the grant"))
      }
    }

    @Test("a connector the gateway does not know is refused as an unknown target")
    func unknownConnector() async throws {
      try await withModel { _, model, _ in
        #expect(await model.connect("nowhere", open: Browser().open) == false)

        if case .failed(let words)? = model.notice {
          #expect(words.contains("no such connector"))
        } else {
          Issue.record("expected a failure, got \(String(describing: model.notice))")
        }
      }
    }

    @Test("connectors switched off are a state, and a connect is refused")
    func switchedOff() async throws {
      try await withModel(FakeGateway.Options(extraArguments: ["--no-connectors"])) { _, model, _ in
        #expect(model.phase == .unavailable)
        #expect(model.connectors.isEmpty)

        #expect(await model.connect("notion", open: Browser().open) == false)
        #expect(model.notice == .failed("Connectors are not available in this session."))
      }
    }
  }
}
#endif
