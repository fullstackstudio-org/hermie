#if os(macOS)
  import AppKit
  import HermieCore
  import SwiftUI

  extension EnvironmentValues {
    /// The Mac's quick ask: its settings, its shortcut and its windows. Set by the app shell on the
    /// scenes that need it (Settings).
    @Entry public var quickAsk: QuickAskSystem?
  }

  /**
   The quick ask as the Mac app has it: the menu bar item, the global shortcut, the Services menu and
   the small window they all open, over one `QuickAskModel`.

   The app shell makes one beside the other launch objects and calls `start()` once. It follows the
   live gateway; it keeps nothing of its own but the settings (`QuickAskSettings`).
   */
  @MainActor
  public final class QuickAskSystem {
    public let settings: QuickAskSettings
    let model: QuickAskModel
    public let hotKey: GlobalHotKeyController
    let presenter: QuickAskPresenter

    private let launch: AppLaunch
    private let services: QuickAskServicesProvider
    private var started = false

    /// - Parameters:
    ///   - registrar: where the shortcut is asked of the system; a test hands in its own.
    ///   - windows: the windows it is shown in; a test hands in its own.
    init(
      launch: AppLaunch,
      live: LiveGateway,
      settings: QuickAskSettings = QuickAskSettings(),
      registrar: any GlobalHotKeyRegistering,
      windows: (any QuickAskWindowing)?
    ) {
      self.launch = launch
      self.settings = settings

      let model = QuickAskModel(
        live: live, settings: settings,
        // A chat screen's own lease: a chat that is open in a window keeps its model when this lets go.
        hold: { session, bot in
          let (chat, lease) = ChatLeases.acquire(session, bot)
          return (chat, { ChatLeases.release(lease, from: session) })
        })
      self.model = model

      let host = QuickAskWindowsHost()
      let presenter = QuickAskPresenter(model: model, settings: settings, windows: windows ?? host)
      self.presenter = presenter
      hotKey = GlobalHotKeyController(settings: settings, registrar: registrar) { presenter.toggle() }
      services = QuickAskServicesProvider { handoff in presenter.present(handoff) }
      model.onOpenChat = { target in
        ShellRequests.shared.openChat = ChatRef(gatewayId: target.gatewayID, bot: target.bot)
      }
      host.system = self
    }

    /// The app's own: the Carbon shortcut and the AppKit windows.
    public convenience init(launch: AppLaunch, live: LiveGateway) {
      self.init(launch: launch, live: live, registrar: CarbonHotKeyRegistrar(), windows: nil)
    }

    /// Register the shortcut and the Services provider. Idempotent.
    public func start() {
      guard !started else {
        return
      }

      started = true
      hotKey.apply()
      NSApplication.shared.servicesProvider = services
    }

    /// The quick ask's root view, for a window to show: behind the app lock, in the reader's theme.
    func root() -> some View {
      QuickAskRoot(system: self, launch: launch)
    }
  }

  /// The windows `QuickAskSystem` builds before `self` exists: the panel's content needs the system, which needs the windows.
  @MainActor
  private final class QuickAskWindowsHost: QuickAskWindowing {
    weak var system: QuickAskSystem?

    private lazy var windows = QuickAskWindows { [weak self] in
      guard let system = self?.system else {
        return AnyView(EmptyView())
      }

      return AnyView(system.root())
    }

    var menuBarWindowIsOpen: Bool { windows.menuBarWindowIsOpen }
    var panelIsOpen: Bool { windows.panelIsOpen }
    func openMenuBarWindow() -> Bool { windows.openMenuBarWindow() }
    func closeMenuBarWindow() { windows.closeMenuBarWindow() }
    func openPanel() { windows.openPanel() }
    func closePanel() { windows.closePanel() }
    func showMainWindow() { windows.showMainWindow() }
  }

  /**
   The menu bar item: a button in the menu bar that opens the quick ask in a small window, as
   Messages' or a clipboard manager's does. It is there unless the reader switched it off (Settings,
   General), or took it out of the menu bar by dragging it away, which switches it off the same way.
   */
  public struct QuickAskMenuBar: Scene {
    private let system: QuickAskSystem
    private let launch: AppLaunch

    public init(system: QuickAskSystem, launch: AppLaunch) {
      self.system = system
      self.launch = launch
    }

    public var body: some Scene {
      // Read here, so a switch in Settings is followed (a binding's getter is not observed).
      let inserted = system.settings.showInMenuBar
      let settings = system.settings

      MenuBarExtra(
        isInserted: Binding(get: { inserted }, set: { settings.setShowInMenuBar($0) })
      ) {
        QuickAskRoot(system: system, launch: launch)
      } label: {
        Image(systemName: "bubble.left.and.bubble.right")
          .accessibilityLabel(NativeStrings.QuickAsk.menuBarLabel)
      }
      .menuBarExtraStyle(.window)
    }
  }

  /// What both homes of the quick ask show: its view behind the app lock, in the reader's theme.
  struct QuickAskRoot: View {
    let system: QuickAskSystem
    let launch: AppLaunch

    var body: some View {
      LockGate {
        QuickAskView(system: system)
      }
      .appAppearance(launch.settings)
      .environment(launch)
      .task {
        ApplicationActivity.follow(launch.lock)
        await launch.start()
      }
    }
  }
#endif
