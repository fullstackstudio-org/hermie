#if os(macOS)
  import Foundation
  import HermieCore
  import Testing

  @testable import HermieCore
  @testable import HermieUI

  /// Windows that record what the presenter asked of them and show nothing.
  @MainActor
  final class FakeQuickAskWindows: QuickAskWindowing {
    var menuBarWindowIsOpen = false
    var panelIsOpen = false
    /// Whether there is a menu bar item to open the window from.
    var hasMenuBarItem = true
    private(set) var log: [String] = []

    func openMenuBarWindow() -> Bool {
      log.append("openMenuBar")

      guard hasMenuBarItem else {
        return false
      }

      menuBarWindowIsOpen = true
      return true
    }

    func closeMenuBarWindow() {
      log.append("closeMenuBar")
      menuBarWindowIsOpen = false
    }

    func openPanel() {
      log.append("openPanel")
      panelIsOpen = true
    }

    func closePanel() {
      log.append("closePanel")
      panelIsOpen = false
    }

    func showMainWindow() {
      log.append("showMain")
    }
  }

  /// A quick ask over a session that has two bots on its roster and never connects: enough for the
  /// composer, its tray and the model's choices, with nothing to send through.
  @MainActor
  struct QuickAskFixture {
    let session = GatewaySession(gatewayID: "g1", link: UnreachableLink())
    let scratch = TemporaryDefaultsForUI()
    let settings: QuickAskSettings
    let model: QuickAskModel

    init(withBots: Bool = true) {
      let session = self.session
      settings = QuickAskSettings(defaults: scratch.defaults)
      model = QuickAskModel(session: { session }, settings: settings)

      if withBots {
        var roster = BotRoster.Snapshot()
        roster.bots = [Bot(name: "researcher"), Bot(name: "writer")]
        session.chatList.apply(roster)
      }
    }
  }

  /// The whole quick ask over a gateway that is live (on a link that never connects), with fake windows
  /// and no shortcut: what the app shell builds, minus the system.
  @MainActor
  struct QuickAskSystemFixture {
    let launch: AppLaunch
    let live: LiveGateway
    let gatewayID: String
    let windows = FakeQuickAskWindows()
    let scratch = TemporaryDefaultsForUI()
    let system: QuickAskSystem

    init() async throws {
      launch = AppLaunch(environment: .inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))
      await launch.start()
      gatewayID = try await launch.sync.addGateway(
        NewGateway(name: "Home", address: "http://127.0.0.1:1", authKind: .sessionToken, sessionToken: "token"))
      await launch.gateways.load()
      live = LiveGateway(
        directory: launch.gateways, connector: { GatewaySession(gatewayID: $0.id, link: UnreachableLink()) })
      await live.follow(gatewayID)
      system = QuickAskSystem(
        launch: launch, live: live, settings: QuickAskSettings(defaults: scratch.defaults),
        registrar: NoHotKeyRegistrar(), windows: windows)
    }

    /// Two bots on the roster, as the gateway would list them.
    func addBots() throws {
      var roster = BotRoster.Snapshot()
      roster.bots = [Bot(name: "researcher"), Bot(name: "writer")]
      try #require(live.session).chatList.apply(roster)
    }
  }

  /// A registrar the system can be given when a test has no use for a shortcut.
  @MainActor
  final class NoHotKeyRegistrar: GlobalHotKeyRegistering {
    func register(_ shortcut: HotKeyShortcut, handler: @escaping @MainActor () -> Void) throws(GlobalHotKeyError) {}
    func unregister() {}
  }

  /// A preferences suite of its own, removed again when the test is done.
  @MainActor
  final class TemporaryDefaultsForUI {
    let suite = "quick-ask-ui-test-\(UUID().uuidString)"
    let defaults: UserDefaults

    init() {
      defaults = UserDefaults(suiteName: suite)!
    }

    isolated deinit {
      defaults.removePersistentDomain(forName: suite)
    }
  }
#endif
