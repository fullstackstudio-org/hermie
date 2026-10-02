import HermieCore
import SwiftUI

/**
 The menu commands, with their keyboard shortcuts: the Mac's menu bar, and the iPad's menu bar and
 shortcut overlay. They act on the router of the window in front (`FocusedValues.appRouter`).

 Settings is not here: the Mac's `Settings` scene brings its own ⌘, and on iPad the toolbar's
 Settings button carries it. A `MenuBarExtra` on the Mac is a later task; it opens chats through
 `openWindow(value: ChatRef)` like the New Chat Window command does.
 */
public struct HermieCommands: Commands {
  @FocusedValue(\.appRouter) private var router
  @Environment(\.openWindow) private var openWindow

  public init() {}

  public var body: some Commands {
    CommandGroup(after: .newItem) {
      Button(NativeStrings.Commands.newChatWindow) {
        if let chat = router?.selectedChat {
          openWindow(value: chat)
        }
      }
      .keyboardShortcut("n", modifiers: [.command, .shift])
      .disabled(router?.selectedChat == nil)
    }

    CommandGroup(after: .textEditing) {
      Button(NativeStrings.Commands.find) {
        router?.requestFind()
      }
      .keyboardShortcut("f", modifiers: .command)
      .disabled(router == nil)
    }

    CommandGroup(after: .sidebar) {
      Button(NativeStrings.Commands.switchGateway) {
        router?.present(.gatewayPicker)
      }
      .keyboardShortcut("g", modifiers: [.command, .control])
      .disabled(router == nil)
    }
  }
}
