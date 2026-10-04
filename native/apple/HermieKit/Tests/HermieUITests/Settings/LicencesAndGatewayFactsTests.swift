import Foundation
import HermieCore
import Testing

@testable import HermieUI

@Suite("Licences")
struct LicencesTests {
  /// The repository's root, from this file's place in it; nil when the tests run somewhere else.
  private static var repository: URL? {
    var url = URL(fileURLWithPath: #filePath)

    for _ in 0..<7 {
      url.deleteLastPathComponent()
    }

    return FileManager.default.fileExists(atPath: url.appendingPathComponent("LICENSE").path) ? url : nil
  }

  @Test("every entry has its licence text in the bundle")
  func textsAreBundled() throws {
    for entry in LicenceCatalogue.entries {
      let text = try #require(LicenceCatalogue.text(of: entry), "\(entry.name) has no text")

      #expect(text.hasPrefix("MIT License"))
      #expect(text.contains(entry.copyright), "the text names who holds the copyright")
    }

    #expect(Set(LicenceCatalogue.entries.map(\.id)).count == LicenceCatalogue.entries.count)
  }

  @Test("a text that is not in the bundle is not made up")
  func missingText() {
    let ghost = LicenceEntry(
      id: "ghost", name: "Ghost", licence: "MIT", copyright: "Nobody", source: nil, resource: "Licence-Ghost")

    #expect(LicenceCatalogue.text(of: ghost) == nil)
  }

  @Test("Hermie's licence is the repository's, word for word")
  func hermieLicenceMatchesTheRepository() throws {
    let root = try #require(Self.repository, "not run from a checkout")
    let original = try String(contentsOf: root.appendingPathComponent("LICENSE"), encoding: .utf8)
    let entry = try #require(LicenceCatalogue.entries.first { $0.id == "hermie" })

    #expect(LicenceCatalogue.text(of: entry) == original.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  @Test("Hermes Agent's licence is the vendored one, word for word")
  func hermesAgentLicenceMatchesTheRepository() throws {
    let root = try #require(Self.repository, "not run from a checkout")
    let original = try String(
      contentsOf: root.appendingPathComponent("packages/hermes-shared/LICENSE"), encoding: .utf8)
    let entry = try #require(LicenceCatalogue.entries.first { $0.id == "hermes-agent" })

    #expect(LicenceCatalogue.text(of: entry) == original.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  @Test("each entry says what it is, in words")
  func notes() {
    let notes = LicenceCatalogue.entries.map(LicenceCatalogue.note(of:))

    #expect(Set(notes).count == notes.count)
    #expect(notes.allSatisfy { !$0.hasPrefix("native.") })
  }

  @Test(arguments: [
    "native.licences.summary", "native.licences.hermie", "native.licences.hermesAgent",
    "native.licences.unreadable", "native.licences.licence"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}

@Suite("Gateway facts")
struct GatewayFactsTests {
  @Test("a version nobody kept is unknown, one that was kept is shown as it is")
  func version() {
    #expect(LiveGatewayFactsSection.versionText(nil) == Strings.App.Settings.unknown)
    #expect(LiveGatewayFactsSection.versionText("  ") == Strings.App.Settings.unknown)
    #expect(LiveGatewayFactsSection.versionText("0.9.2") == "0.9.2")
  }

  @Test("the plugin is checking until a roster has said, and only then installed or absent")
  func plugin() {
    #expect(LiveGatewayFactsSection.pluginText(.unknown) == Strings.App.Settings.pluginUnknown)
    #expect(LiveGatewayFactsSection.pluginText(.absent) == Strings.App.Settings.pluginAbsent)
    #expect(LiveGatewayFactsSection.pluginText(.installed(version: "0.4.0")).contains("0.4.0"))
    #expect(
      Set([
        LiveGatewayFactsSection.pluginText(.unknown), LiveGatewayFactsSection.pluginText(.absent),
        LiveGatewayFactsSection.pluginText(.installed(version: "1"))
      ]).count == 3)
  }
}
