import HermieCore
import HermieUI
import SwiftUI

/// The Mac app: SwiftUI on AppKit, not an iPad build. Everything it shows
/// lives in HermieKit; this file only declares the scenes.
///
/// The launch runs here, in `init`, so the local store is open and the lock
/// decided before the first frame. Push is attached here too, before the system
/// can deliver a token or a notification response to the delegate. A
/// `MenuBarExtra` is a later task; it goes beside the scenes below.
@main
struct HermieApp: App {
  @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
  @State private var launch: AppLaunch

  init() {
    let launch = AppLaunch(environment: .live(), pushSystem: SystemPushBridge())
    _launch = State(initialValue: launch)
    PushInbox.shared.attach(launch.push)
  }

  var body: some Scene {
    WindowGroup(id: ShellScene.main) {
      MainWindow()
        .environment(launch)
        .frame(minWidth: 640, minHeight: 420)
    }
    .defaultSize(width: 1000, height: 680)
    .commands {
      HermieCommands()
    }

    // An extra window for one chat, opened by the New Chat Window command.
    WindowGroup(for: ChatRef.self) { $chat in
      ChatWindow(chat: $chat)
        .environment(launch)
        .frame(minWidth: 420, minHeight: 360)
    }
    .defaultSize(width: 640, height: 720)

    Settings {
      SettingsWindow()
        .environment(launch)
    }
  }
}
