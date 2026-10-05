#if os(macOS)
  import AppKit
  import Foundation
  import HermieCore
  import Testing

  @testable import HermieUI

  /// Where the quick ask is shown, and what "Open in Hermie" and the Services menu ask of the app.
  /// The windows are fakes that record: nothing is shown and nothing is clicked.
  @MainActor
  @Suite struct QuickAskPresenterTests {
    private func make(showInMenuBar: Bool = true, hasMenuBarItem: Bool = true) -> (
      QuickAskPresenter, FakeQuickAskWindows, QuickAskFixture
    ) {
      let fixture = QuickAskFixture()
      fixture.settings.setShowInMenuBar(showInMenuBar)

      let windows = FakeQuickAskWindows()
      windows.hasMenuBarItem = hasMenuBarItem
      let presenter = QuickAskPresenter(model: fixture.model, settings: fixture.settings, windows: windows)

      return (presenter, windows, fixture)
    }

    // MARK: Where it opens

    @Test func theShortcutOpensTheMenuBarWindowAndPressedAgainClosesIt() {
      let (presenter, windows, _) = make()

      presenter.toggle()
      #expect(windows.log == ["openMenuBar"])
      #expect(windows.menuBarWindowIsOpen)
      #expect(!windows.panelIsOpen)

      presenter.toggle()
      #expect(windows.log == ["openMenuBar", "closeMenuBar"])
      #expect(!windows.menuBarWindowIsOpen)
    }

    @Test func theShortcutPutsTheCaretInTheFieldAndAsksTheModelToSyncItself() {
      let (presenter, _, fixture) = make()
      let serial = fixture.model.focusSerial

      presenter.toggle()

      #expect(fixture.model.focus == .field)
      #expect(fixture.model.focusSerial == serial + 1)
      #expect(fixture.model.composer?.bot == "researcher", "the model is ready before the window is")
    }

    @Test func withTheMenuBarItemSwitchedOffThePanelIsShownInstead() {
      let (presenter, windows, _) = make(showInMenuBar: false)

      presenter.toggle()
      #expect(windows.log == ["openPanel"], "the item is not asked for")
      #expect(windows.panelIsOpen)

      presenter.toggle()
      #expect(windows.log == ["openPanel", "closePanel"])
    }

    @Test func aMenuBarItemThatCannotBeOpenedFallsBackToThePanel() {
      let (presenter, windows, _) = make(hasMenuBarItem: false)

      presenter.toggle()
      #expect(windows.log == ["openMenuBar", "openPanel"])
      #expect(windows.panelIsOpen)
    }

    // MARK: The Services menu

    @Test func textFromTheServicesMenuIsInTheFieldWithTheBotPickerFocused() throws {
      let (presenter, windows, fixture) = make()
      let handoff = try #require(QuickAskHandoff.service(text: "a selected sentence", files: []))

      presenter.present(handoff)

      #expect(fixture.model.composer?.draft == "a selected sentence")
      #expect(fixture.model.focus == .botPicker)
      #expect(windows.menuBarWindowIsOpen)
    }

    @Test func aHandoverWhileTheWindowIsOpenIsOnlyGivenToTheModel() throws {
      let (presenter, windows, fixture) = make()

      presenter.toggle()
      presenter.present(try #require(QuickAskHandoff.service(text: "more", files: [])))

      #expect(windows.log == ["openMenuBar"], "not opened, not toggled closed")
      #expect(fixture.model.composer?.draft == "more")
    }

    // MARK: Open in Hermie

    @Test func openInHermieAsksForTheChatOfTheBotAskedBringsTheMainWindowAndClosesTheQuickAsk() {
      let (presenter, windows, fixture) = make()
      var opened: [QuickAskTarget] = []
      fixture.model.onOpenChat = { opened.append($0) }

      presenter.toggle()
      fixture.model.select("writer")
      presenter.openInHermie()

      #expect(opened == [QuickAskTarget(gatewayID: "g1", bot: "writer")])
      #expect(windows.log == ["openMenuBar", "showMain", "closeMenuBar"])
    }

    @Test func theSystemTurnsTheRequestIntoAChatForTheMainWindowToOpen() async throws {
      let fixture = try await QuickAskSystemFixture()
      let system = fixture.system
      ShellRequests.shared.openChat = nil
      defer { ShellRequests.shared.openChat = nil }

      // No bot on the roster yet: there is no chat to open, and the main window comes forward all the same.
      system.model.openInApp()
      #expect(ShellRequests.shared.openChat == nil)

      try fixture.addBots()
      system.model.sync()
      system.model.select("writer")
      system.presenter.openInHermie()

      #expect(ShellRequests.shared.openChat == ChatRef(gatewayId: fixture.gatewayID, bot: "writer"))
      #expect(fixture.windows.log == ["showMain"])
      await fixture.live.shutdown()
    }
  }
#endif
