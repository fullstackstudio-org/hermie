#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

extension Integration {
  /// The Skills page's model against the real fake gateway, over a real socket: what a bot has
  /// installed with its switches, the hub browsed and searched, a skill's details, and an install.
  @Suite("Skills") @MainActor
  struct SkillsIntegrationTests {
    private func withModel(
      profile: String?,
      _ body: @escaping @MainActor @Sendable (GatewaySession, SkillsModel) async throws -> Void
    ) async throws {
      try await withCapabilitySession { session, _ in
        let model = session.skills(for: profile)
        await model.load()

        try await body(session, model)
      }
    }

    @Test("a bot's installed skills are listed with the switch positions profiles.describe gives them")
    func installedWithSwitches() async throws {
      try await withModel(profile: "writer") { _, model in
        #expect(model.phase == .ready)
        #expect(model.installed.map(\.name) == ["docx", "pdf"])
        #expect(model.installed.first { $0.name == "pdf" }?.enabled == false, "writer has pdf switched off")
        #expect(model.installed.first { $0.name == "docx" }?.enabled == true)
        #expect(model.installed.allSatisfy { $0.category == "bundled" })
      }
    }

    @Test("a bot nobody has edited has every skill on")
    func aFreshBotHasEverythingOn() async throws {
      try await withModel(profile: "researcher") { _, model in
        #expect(model.installed.map(\.name) == ["docx", "pdf", "web-search"])
        #expect(model.installed.allSatisfy { $0.enabled == true })
      }
    }

    @Test("the hub is browsed, searched, and a skill's details are read")
    func hub() async throws {
      try await withModel(profile: "researcher") { _, model in
        await model.searchHub("")
        #expect(model.hubPhase == .ready)
        #expect(model.hub.map(\.name) == ["pdf", "docx", "web-search", "xlsx", "changelog-video"])
        #expect(model.hub.first { $0.name == "xlsx" }?.trust == "community")
        #expect(model.canLoadMore == false, "five skills are one page")

        await model.searchHub("spreadsheet")
        #expect(model.hub.map(\.name) == ["xlsx"])

        let xlsx = try #require(model.hub.first)

        await model.inspect(xlsx)

        if case .loaded(let info) = model.inspected[xlsx.id] {
          #expect(info.preview.contains("# xlsx"))
        } else {
          Issue.record("expected the details, got \(String(describing: model.inspected[xlsx.id]))")
        }

        await model.inspect(HubSkill(name: "nowhere"))
        #expect(model.inspected["nowhere"] == .unknown)
      }
    }

    @Test("an install puts the skill under the bot, and the list shows it")
    func install() async throws {
      try await withModel(profile: "writer") { session, model in
        let xlsx = HubSkill(name: "xlsx", identifier: "xlsx")

        #expect(await model.install(xlsx))
        #expect(model.notice == .installed("xlsx"))
        #expect(model.installed.map(\.name).contains("xlsx"))
        #expect(model.installed.first { $0.name == "xlsx" }?.category == "installed")

        // The other bot has not got it.
        let researcher = session.skills(for: "researcher")
        await researcher.load()
        #expect(researcher.installed.map(\.name).contains("xlsx") == false)

        #expect(await model.install(xlsx) == false, "an installed skill is not installed again")
      }
    }

    @Test("a skill the hub does not have is refused in the gateway's words")
    func refusedInstall() async throws {
      try await withModel(profile: "writer") { _, model in
        #expect(await model.install(HubSkill(name: "ghost")) == false)
        #expect(model.notice == .installFailed("skill 'ghost' not found in the hub"))
      }
    }

    @Test("a model about no bot reads the gateway's own skills")
    func gatewaysOwn() async throws {
      try await withModel(profile: nil) { _, model in
        #expect(model.phase == .ready)
        #expect(model.installed.allSatisfy { $0.enabled == nil }, "nobody was asked about, so nothing says it is on")
      }
    }
  }
}
#endif
