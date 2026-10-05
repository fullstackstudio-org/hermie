#if os(macOS)
  import AppKit
  import SwiftUI

  /**
   The Mac's windows for the quick ask, in AppKit.

   SwiftUI has no way to open a `MenuBarExtra`'s window from code, so the shortcut presses the menu
   bar item's button: the app's own `NSStatusBarButton`, found among the app's own windows. That is
   `performClick` on a control of this process, which needs no permission (no Accessibility, no
   events posted to the system). When the item is not there, or is not found, the panel is shown:
   the same view in a small floating window that takes the keyboard without bringing the app's other
   windows forward.
   */
  @MainActor
  final class QuickAskWindows: QuickAskWindowing {
    private let content: @MainActor () -> AnyView
    private var panel: NSPanel?

    /// - Parameter content: the quick ask's root view, for the panel (the menu bar item has its own).
    init(content: @escaping @MainActor () -> AnyView) {
      self.content = content
    }

    // MARK: The menu bar item's window

    var menuBarWindowIsOpen: Bool {
      NSApp.windows.contains { $0.isVisible && Self.isMenuBarWindow($0) }
    }

    func openMenuBarWindow() -> Bool {
      guard let button = Self.statusButton() else {
        return false
      }

      button.performClick(nil)
      return true
    }

    func closeMenuBarWindow() {
      // The item's own toggle, so the item and its window do not disagree about whether it is open.
      Self.statusButton()?.performClick(nil)
    }

    /// The window `MenuBarExtra` shows for the window style. Its class is SwiftUI's own, found by name.
    static func isMenuBarWindow(_ window: NSWindow) -> Bool {
      window.className.contains("MenuBarExtraWindow")
    }

    /// The button of this app's status item, in the status bar window the item lives in.
    static func statusButton() -> NSButton? {
      for window in NSApp.windows where window.className.contains("NSStatusBarWindow") {
        if let button = button(in: window.contentView) {
          return button
        }
      }

      return nil
    }

    /// The first button below `view`, depth first.
    static func button(in view: NSView?) -> NSButton? {
      guard let view else {
        return nil
      }

      if let button = view as? NSButton {
        return button
      }

      for child in view.subviews {
        if let found = button(in: child) {
          return found
        }
      }

      return nil
    }

    // MARK: The panel

    var panelIsOpen: Bool { panel?.isVisible ?? false }

    func openPanel() {
      let panel = self.panel ?? makePanel()
      self.panel = panel

      if !panel.isVisible {
        panel.center()
      }

      panel.makeKeyAndOrderFront(nil)
    }

    func closePanel() {
      panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
      let panel = NSPanel(contentViewController: NSHostingController(rootView: content()))

      panel.styleMask = [.titled, .closable, .fullSizeContentView, .nonactivatingPanel]
      panel.title = NativeStrings.QuickAsk.title
      panel.titleVisibility = .hidden
      panel.titlebarAppearsTransparent = true
      panel.isMovableByWindowBackground = true
      panel.level = .floating
      panel.hidesOnDeactivate = false
      panel.isReleasedWhenClosed = false
      panel.becomesKeyOnlyIfNeeded = false
      panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]

      return panel
    }

    // MARK: The main window

    func showMainWindow() {
      NSApp.activate()

      if let window = NSApp.windows.first(where: Self.isMainWindow) {
        if window.isMiniaturized {
          window.deminiaturize(nil)
        }

        window.makeKeyAndOrderFront(nil)
        return
      }

      // None is open: opening the app again is how the system asks it for a window.
      NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: NSWorkspace.OpenConfiguration())
    }

    /// A window of the main group (SwiftUI names it after the scene's id), not a panel or Settings.
    static func isMainWindow(_ window: NSWindow) -> Bool {
      !(window is NSPanel) && window.identifier?.rawValue.hasPrefix(ShellScene.main) == true
    }
  }
#endif
