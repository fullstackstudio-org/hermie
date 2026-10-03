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
  @FocusedValue(\.chatListFocus) private var chatList
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

    CommandMenu(NativeStrings.Commands.chatMenu) {
      chatCommands
    }
  }

  /**
   Pin, mute and archive for the selected chat, so each is one keystroke or a walk through the menu
   bar away (the row's context menu needs a pointer). Archive takes Mail's ⌃⌘A. Disabled with no chat
   selected, or while the chat list's arrangement cannot be written yet.
   */
  @ViewBuilder private var chatCommands: some View {
    let target = chatTarget
    let arrangement = target?.arrangement
    let name = target?.name ?? ""
    let pinned = arrangement?.isPinned(name) ?? false
    let archived = arrangement?.isArchived(name) ?? false
    let muted = arrangement?.isMuted(name) ?? false

    Button(pinned ? Strings.App.Layout.unpin : Strings.App.Layout.pin) {
      withAnimation { arrangement?.setPinned(name, !pinned) }
    }
    .disabled(target == nil)

    if muted {
      Button(Strings.App.Layout.unmute) {
        withAnimation { arrangement?.setMute(name, until: nil) }
      }
      .disabled(target == nil)
    } else {
      Menu(Strings.App.Layout.mute) {
        ForEach(MuteDuration.allCases, id: \.self) { duration in
          Button(ChatListFormat.muteTitle(duration)) {
            withAnimation { arrangement?.mute(name, for: duration) }
          }
        }
      }
      .disabled(target == nil)
    }

    Divider()

    Button(archived ? Strings.App.Layout.unarchive : Strings.App.Layout.archive) {
      withAnimation { arrangement?.setArchived(name, !archived) }
    }
    .keyboardShortcut("a", modifiers: [.command, .control])
    .disabled(target == nil)
  }

  /// The selected chat, when the chat list in front shows its gateway and can write.
  private var chatTarget: (arrangement: ChatArrangementModel, name: String)? {
    guard let chat = router?.selectedChat, let focus = chatList, focus.gatewayID == chat.gatewayId,
      focus.arrangement.canEdit
    else {
      return nil
    }

    return (focus.arrangement, chat.bot)
  }
}
