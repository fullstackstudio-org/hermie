#if os(macOS)
  import HermieCore

  /// The windows the quick ask can be shown in. `QuickAskWindows` is the Mac's; a test hands in a
  /// fake that records, so no test opens a window.
  @MainActor
  protocol QuickAskWindowing: AnyObject {
    /// The menu bar item's window is open.
    var menuBarWindowIsOpen: Bool { get }
    /// The panel that stands in for it, when the menu bar item is not there, is open.
    var panelIsOpen: Bool { get }

    /// Open the menu bar item's window. False when there is no item to open it from.
    func openMenuBarWindow() -> Bool
    func closeMenuBarWindow()
    func openPanel()
    func closePanel()
    /// Bring Hermie's main window forward, making one when there is none.
    func showMainWindow()
  }

  /**
   Shows the quick ask: where the global shortcut, the Services menu and "Open in Hermie" meet the
   windows. It decides nothing about what the quick ask holds (`QuickAskModel`).

   The menu bar item's window is the quick ask's home. When the item is switched off, or the system
   would not open it, the same view is shown in a small panel instead, so the shortcut and the
   Services menu work whether or not the menu bar item is there.
   */
  @MainActor
  final class QuickAskPresenter {
    let model: QuickAskModel
    private let settings: QuickAskSettings
    private let windows: any QuickAskWindowing

    init(model: QuickAskModel, settings: QuickAskSettings, windows: any QuickAskWindowing) {
      self.model = model
      self.settings = settings
      self.windows = windows
    }

    /// The global shortcut: open the quick ask, or close it when it is open already.
    func toggle() {
      if isOpen {
        hide()
      } else {
        present(QuickAskHandoff())
      }
    }

    /// Open the quick ask with `handoff` in it. Already open, it is only given what was handed over.
    func present(_ handoff: QuickAskHandoff) {
      model.accept(handoff)

      guard !isOpen else {
        return
      }

      if settings.showInMenuBar, windows.openMenuBarWindow() {
        return
      }

      windows.openPanel()
    }

    func hide() {
      if windows.menuBarWindowIsOpen {
        windows.closeMenuBarWindow()
      }

      if windows.panelIsOpen {
        windows.closePanel()
      }
    }

    /// "Open in Hermie": the chat of the bot asked, in the main window; the quick ask closes.
    func openInHermie() {
      model.openInApp()
      windows.showMainWindow()
      hide()
    }

    private var isOpen: Bool {
      windows.menuBarWindowIsOpen || windows.panelIsOpen
    }
  }
#endif
