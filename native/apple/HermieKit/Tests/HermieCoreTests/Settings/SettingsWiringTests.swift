import Foundation
import HermieTranscript
import Testing

@testable import HermieCore

/// The settings model on the live wiring: the session's default chat view follows it.
@MainActor
@Suite("Settings wiring")
struct SettingsWiringTests {
  typealias Fixture = LiveGatewayTests.Fixture

  @Test("the live session's default chat view follows Settings › Chats")
  func defaultsReachTheSession() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let wiring = LiveWiring(
      launch: fixture.launch,
      accounts: fixture.accounts,
      live: live,
      surfaces: nil,
      installLock: InstalledLock().install
    )

    wiring.start()
    live.start()
    try await eventually("the session") { await MainActor.run { live.phase == .live } }

    let session = try #require(live.session)
    let chat = session.chat("researcher")
    #expect(chat.visibility == SyncedSettings.defaultChatView)

    let verbose = VisibilityOptions(level: .verbose, showBotToBot: false, showThinking: true)
    fixture.launch.settings.setDefaults(verbose)

    try await eventually("the chat follows") { await MainActor.run { chat.visibility == verbose } }

    await live.shutdown()
  }
}
