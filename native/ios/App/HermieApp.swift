import HermieCore
import HermieUI
import SwiftUI

/// The iPhone and iPad app. Everything it shows lives in HermieKit; this file
/// only declares the scenes.
///
/// The launch runs here, in `init`, so the local store is open and the lock
/// decided before the first frame. An app delegate adaptor is added with push
/// (APNs registration), which is a later task.
@main
struct HermieApp: App {
  @State private var launch = AppLaunch(environment: .live())

  var body: some Scene {
    WindowGroup(id: ShellScene.main) {
      MainWindow()
        .environment(launch)
    }
    .commands {
      HermieCommands()
    }

    // An extra window for one chat, opened by the New Chat Window command.
    WindowGroup(for: ChatRef.self) { $chat in
      ChatWindow(chat: $chat)
        .environment(launch)
    }
  }
}
