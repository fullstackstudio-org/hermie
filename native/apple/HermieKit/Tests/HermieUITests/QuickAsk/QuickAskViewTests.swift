#if os(macOS)
  import AppKit
  import HermieCore
  import SwiftUI
  import Testing

  @testable import HermieUI

  /// The quick ask's view laid out in a hosting controller that is never shown: it is the width it
  /// says it is, with no gateway, with a roster, and with an answer under way, and it does not stand
  /// taller than a menu bar window can. (The window itself is not driven by UI tests.)
  @MainActor
  @Suite struct QuickAskViewTests {
    private func size(of system: QuickAskSystem, launch: AppLaunch) -> CGSize {
      let host = NSHostingController(rootView: QuickAskView(system: system).environment(launch))

      return host.sizeThatFits(in: CGSize(width: 400, height: 1000))
    }

    @Test func withNoGatewayItSaysSoAtTheWindowsWidth() async throws {
      let fixture = try await QuickAskSystemFixture()
      await fixture.live.shutdown()

      let size = size(of: fixture.system, launch: fixture.launch)

      #expect(size.width == QuickAskView.width)
      #expect(size.height > 0)
      #expect(size.height < 200, "just the header and a sentence: \(size.height)")
    }

    @Test func withBotsItIsTheHeaderAndTheComposerAtTheWindowsWidth() async throws {
      let fixture = try await QuickAskSystemFixture()
      try fixture.addBots()
      fixture.system.model.sync()

      let size = size(of: fixture.system, launch: fixture.launch)

      #expect(size.width == QuickAskView.width)
      #expect(size.height > 60)
      #expect(size.height < 400)
      #expect(fixture.system.model.composer?.bot == "researcher")
      await fixture.live.shutdown()
    }

    @Test func aLongPileOfWordsInTheFieldDoesNotGrowTheWindowPastItsLimit() async throws {
      let fixture = try await QuickAskSystemFixture()
      try fixture.addBots()
      fixture.system.model.sync()
      let short = size(of: fixture.system, launch: fixture.launch).height

      fixture.system.model.composer?.type(String(repeating: "a line of words\n", count: 200))
      let long = size(of: fixture.system, launch: fixture.launch).height

      #expect(long > short, "the field grows with its words")
      #expect(long < short + 220, "up to six lines, then it scrolls: \(short) to \(long)")
      fixture.system.model.composer?.type("")
      await fixture.live.shutdown()
    }
  }
#endif
