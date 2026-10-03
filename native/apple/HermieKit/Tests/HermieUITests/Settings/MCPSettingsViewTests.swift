import Foundation
import HermieCore
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieUI

/// The parts of the MCP page that are plain functions: which one thing it says, the lines of a client,
/// the words for a change, and where the category sits in Settings. (The views themselves are not
/// driven by UI tests.)
struct MCPSettingsViewTests {
  // MARK: Where the page stands

  @Test func theStateIsChosenFromThePhaseAndWhetherAnythingWasRead() {
    typealias State = MCPPageState

    #expect(State.from(phase: .loading, hasSettings: false) == .loading)
    #expect(State.from(phase: .ready, hasSettings: true) == .on)
    #expect(State.from(phase: .notOffered, hasSettings: false) == .notOffered)
    #expect(State.from(phase: .noIdentity, hasSettings: false) == .noIdentity)
    #expect(State.from(phase: .signedOut, hasSettings: false) == .signedOut)
    #expect(State.from(phase: .unreadable, hasSettings: false) == .unreadable)
    // A failed refresh keeps the old answer, and says it may be out of date.
    #expect(State.from(phase: .unreadable, hasSettings: true) == .stale)
  }

  @Test func onlyAnAnswerShowsTheEndpointTheCommandAndTheClients() {
    let showing = [MCPPageState.on, .stale]
    let all: [MCPPageState] = [.noGateway, .loading, .notOffered, .noIdentity, .signedOut, .unreadable, .on, .stale]

    #expect(all.filter(\.showsSettings) == showing)
  }

  @Test func everyStateHasItsOwnSentenceAndSymbol() {
    let all: [MCPPageState] = [.noGateway, .loading, .notOffered, .noIdentity, .signedOut, .unreadable, .on, .stale]
    let sentences = all.map { MCPText.state($0).text }

    #expect(!sentences.contains(""))
    #expect(Set(sentences).count == all.count, "no two states share a sentence")
    #expect(!all.map { MCPText.state($0).symbol }.contains(""))
  }

  // MARK: A client's lines

  private func format(_ unix: Double) -> String { "t\(Int(unix))" }

  private func grant(_ fields: JSONObject) -> MCPGrant {
    var json: JSONObject = ["id": "mcg_1", "client_name": "Example Agent"]
    json.merge(fields) { _, new in new }
    return MCPGrant(json: json)
  }

  @Test func aClientRowSaysWhenItWasAllowedAndWhenItLastCame() {
    let lines = MCPText.lines(
      for: grant([
        "created_at": 100, "created_ip": "203.0.113.7", "last_used_at": 200, "last_used_ip": "198.51.100.9", "expires_at": 300
      ]),
      format: format
    )

    #expect(lines.name == "Example Agent")
    #expect(lines.allowed == "Allowed t100 from 203.0.113.7")
    #expect(lines.lastUsed == "Last used t200 from 198.51.100.9")
    #expect(lines.expires == "Expires t300")
    #expect(lines.spoken == "Example Agent, Allowed t100 from 203.0.113.7, Last used t200 from 198.51.100.9, Expires t300")
  }

  @Test func whatTheGatewayDidNotRecordIsLeftOutNotInvented() {
    let lines = MCPText.lines(
      for: grant(["created_at": 100, "created_ip": .null, "last_used_at": .null, "last_used_ip": .null]), format: format)

    #expect(lines.allowed == "Allowed t100")
    #expect(lines.lastUsed == "Never used")
    #expect(lines.expires == nil)

    let bare = MCPText.lines(for: MCPGrant(json: ["id": "mcg_2"]), format: format)
    #expect(bare.name == "Unnamed client")
    #expect(bare.allowed == "Allowed at an unknown time")
  }

  @Test func aClientsNameAndAddressAreOneCleanLineEach() {
    let lines = MCPText.lines(
      for: grant([
        "client_name": "Ex\u{202E}ample\u{200B}\nAgent", "created_at": 1, "created_ip": "203.0.113.7\n\u{2028}evil",
        "last_used_at": 2, "last_used_ip": "\u{202E}x"
      ]),
      format: format
    )

    #expect(lines.name == "Example Agent")
    #expect(lines.allowed == "Allowed t1 from 203.0.113.7 evil")
    #expect(lines.lastUsed == "Last used t2 from x")
    #expect(![lines.name, lines.allowed, lines.lastUsed].joined().contains("\n"))
  }

  @Test func aNameOfNothingButControlsReadsAsUnnamed() {
    #expect(MCPText.lines(for: grant(["client_name": "\u{202E}\u{200B}"]), format: format).name == "Unnamed client")
  }

  // MARK: Changes from elsewhere

  @Test func aChangeNamesTheClientWhenTheFrameDid() {
    let granted = noticeText(.granted, "Example Agent")
    let revoked = noticeText(.revoked, "Example Agent")

    #expect(granted == "Example Agent was allowed to connect.")
    #expect(revoked == "Example Agent was revoked.")
    #expect(noticeText(.revoked, "") == "The list of clients changed.")
    #expect(noticeText(.unknown("renamed"), "Example Agent") == "The list of clients changed.")
  }

  private func noticeText(_ change: MCPChange, _ name: String) -> String {
    MCPText.notice(.init(id: 1, change: change, clientName: name, at: 0))
  }

  // MARK: The command

  @Test func theCommandIsDrawnWithItsInvisibleCharactersMarkedAndCopiedAsReceived() {
    let command = "claude mcp add --transport http example https://gateway.example/mcp\u{200B}   evil"
    let drawn = ConfirmDetailMarkup(command).text

    #expect(drawn.contains("[U+200B]"))
    #expect(drawn != command)
    // What the page copies is `command` itself: the markup is only ever drawn.
    #expect(command.contains("\u{200B}"))
  }

  // MARK: Settings

  @Test func theCategoryIsListedBesideGatewaysAndLosesNoOther() {
    let listed = SettingsCategory.groups.flatMap { $0 }

    #expect(Set(listed) == Set(SettingsCategory.allCases))
    #expect(listed.count == SettingsCategory.allCases.count)

    let group = SettingsCategory.groups.first { $0.contains(.mcp) }
    #expect(group?.contains(.gateways) == true)
    #expect(SettingsCategory.mcp.title == "MCP")
    #expect(!SettingsCategory.mcp.blurb.isEmpty)
  }
}
