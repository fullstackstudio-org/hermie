import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

private func row(_ name: String, isDefault: Bool = false, advert: JSONValue? = nil) -> JSONValue {
  var json: JSONObject = ["name": .string(name), "is_default": .bool(isDefault), "canonical_session": ["id": .string("s-\(name)")]]

  if let advert {
    json["ui_meta"] = ["hermie-plugin": advert]
  }

  return .object(json)
}

struct PluginAdvertTests {
  @Test func theDefaultProfilesAdvertWinsAndItsVersionIsKept() {
    let rows = [
      row("scout", advert: ["v": 1, "version": "0.1.0", "capabilities": ["push.relay"]]),
      row("main", isDefault: true, advert: ["v": 1, "version": "0.4.2", "capabilities": ["ui_meta.per_user", "push.relay"]])
    ]

    let advert = PluginCapabilities.advert(in: rows)

    #expect(advert == PluginAdvert(version: "0.4.2", capabilities: ["ui_meta.per_user", "push.relay"]))
    #expect(PluginCapabilities.of(rows) == ["ui_meta.per_user", "push.relay"])
  }

  @Test func withoutADefaultTheFirstAdvertWins() {
    let rows = [
      row("plain"),
      row("scout", advert: ["v": 1, "version": "0.1.0"]),
      row("other", advert: ["v": 1, "version": "0.2.0"])
    ]

    #expect(PluginCapabilities.advert(in: rows)?.version == "0.1.0")
  }

  @Test func anAdvertThatNamesNoVersionHasAnEmptyOne() {
    #expect(PluginCapabilities.advert(in: [row("a", advert: ["v": 1])]) == PluginAdvert())
  }

  @Test func anAdvertNewerThanThisBuildReadsIsNoAdvert() {
    #expect(PluginCapabilities.advert(in: [row("a", advert: ["v": 99, "version": "9.0.0"])]) == nil)
    #expect(PluginCapabilities.advert(in: [row("a", advert: ["v": 0])]) == nil)
    #expect(PluginCapabilities.advert(in: [row("a", advert: ["v": 1.5])]) == nil)
    #expect(PluginCapabilities.advert(in: [row("a", advert: "not an object")]) == nil)
    #expect(PluginCapabilities.advert(in: [row("a")]) == nil)
    #expect(PluginCapabilities.of([row("a", advert: ["v": 99])]).isEmpty)
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct PluginPresenceTests {
  @Test func notLookedYetIsNotNotInstalled() async throws {
    let harness = SessionHarness()

    #expect(harness.session.pluginPresence == .unknown)
    await harness.session.shutdown()
  }

  @Test func aRosterThatCarriesTheAdvertSaysInstalledWithItsVersion() async throws {
    let harness = SessionHarness()
    try await harness.start(
      roster: ["profiles": [row("researcher", isDefault: true, advert: ["v": 1, "version": "0.4.2", "capabilities": []])]])

    #expect(harness.session.pluginPresence == .installed(version: "0.4.2"))
    await harness.session.shutdown()
  }

  @Test func aRosterWithoutOneSaysAbsent() async throws {
    let harness = SessionHarness()
    try await harness.start()

    #expect(harness.session.pluginPresence == .absent)
    await harness.session.shutdown()
  }

  @Test func theNextRosterCanTakeItAway() async throws {
    let harness = SessionHarness()
    try await harness.start(
      roster: ["profiles": [row("researcher", isDefault: true, advert: ["v": 1, "version": "0.4.2"])]])
    #expect(harness.session.pluginPresence == .installed(version: "0.4.2"))

    harness.link.respond(to: RPC.ProfilesList.name, with: ["profiles": [row("researcher", isDefault: true)]])
    _ = try await harness.session.roster.refresh()
    try await eventually("the plugin gone") { await MainActor.run { harness.session.pluginPresence == .absent } }
    await harness.session.shutdown()
  }
}
