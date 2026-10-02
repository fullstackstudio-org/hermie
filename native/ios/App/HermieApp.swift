import HermieCore
import HermieUI
import SwiftUI

/// The iPhone and iPad app. Everything it shows lives in HermieKit; this file
/// only declares the scenes.
///
/// The launch runs here, in `init`, so the local store is open and the lock
/// decided before the first frame. Push is attached here too, before the system
/// can deliver a token or a notification response to the delegate.
@main
struct HermieApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
  @State private var launch: AppLaunch
  /// Who is signed in where; fills the setup and sign-in seams and forgets a removed gateway's secrets.
  @State private var accounts: GatewayAccounts

  init() {
    let launch = AppLaunch(environment: .live(), pushSystem: SystemPushBridge())
    _launch = State(initialValue: launch)
    _accounts = State(initialValue: .app(launch))
    PushInbox.shared.attach(launch.push)
  }

  var body: some Scene {
    WindowGroup(id: ShellScene.main) {
      MainWindow()
        .environment(launch)
        .environment(accounts)
        .environment(\.shellComponents, .gatewaySetup(accounts: accounts))
    }
    .commands {
      HermieCommands()
    }

    // An extra window for one chat, opened by the New Chat Window command.
    WindowGroup(for: ChatRef.self) { $chat in
      ChatWindow(chat: $chat)
        .environment(launch)
        .environment(accounts)
        .environment(\.shellComponents, .gatewaySetup(accounts: accounts))
    }
  }
}
