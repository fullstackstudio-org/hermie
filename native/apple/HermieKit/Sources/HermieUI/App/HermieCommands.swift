import HermieCore
import SwiftUI

/**
 The menu commands, with their keyboard shortcuts: the Mac's menu bar, and the iPad's menu bar and
 shortcut overlay. They act on the router of the window in front (`FocusedValues.appRouter`).

 Settings is not here: the Mac's `Settings` scene brings its own ⌘, and on iPad the toolbar's
 Settings button carries it. The Mac's menu bar item (the quick ask, `QuickAskMenuBar`) is a scene of its
 own and opens chats through `ShellRequests.openChat`.

 On the Mac the gateways have a menu of their own in the menu bar (`GatewayMenu`), where a Mac app
 keeps such a choice, instead of a toolbar button; it needs the launch, which the app hands in. On
 iPad the toolbar's switcher and Switch Gateway (⌃⌘G) stay.
 */
public struct HermieCommands: Commands {
  @FocusedValue(\.appRouter) private var router
  @FocusedValue(\.chatListFocus) private var chatList
  @Environment(\.openWindow) private var openWindow
  private let launch: AppLaunch?

  /// - Parameter launch: the app's launch, for the Mac's Gateway menu (its gateways and switching).
  public init(launch: AppLaunch? = nil) {
    self.launch = launch
  }

  public var body: some Commands {
    CommandGroup(after: .newItem) {
      Button(NativeStrings.Commands.newChatWindow) {
        if let chat = router?.selectedChat {
          openWindow(value: chat)
        }
      }
      .keyboardShortcut("n", modifiers: [.command, .shift])
      .disabled(router?.selectedChat == nil)

      Button(NativeStrings.NewBot.menuTitle) {
        router?.present(.newBot)
      }
      .disabled(router == nil)
    }

    CommandGroup(after: .textEditing) {
      Button(NativeStrings.Commands.find) {
        router?.requestFind()
      }
      .keyboardShortcut("f", modifiers: .command)
      .disabled(router == nil)

      Button(NativeStrings.Commands.searchEverywhere) {
        router?.presentSearch()
      }
      .keyboardShortcut("f", modifiers: [.command, .shift])
      .disabled(router == nil)
    }

    #if os(macOS)
      CommandMenu(NativeStrings.Commands.gatewayMenu) {
        if let launch {
          GatewayMenu(launch: launch, router: router)
        }
      }
    #else
      CommandGroup(after: .sidebar) {
        Button(NativeStrings.Commands.switchGateway) {
          router?.present(.gatewayPicker)
        }
        .keyboardShortcut("g", modifiers: [.command, .control])
        .disabled(router == nil)
      }
    #endif

    CommandMenu(NativeStrings.Commands.chatMenu) {
      chatCommands
    }
  }

  /**
   Needs You (⌘⇧I), Agents Overview (⌘⇧A) and Stop All Running Turns… (⌘⇧.), which are about every chat, then Pin, mute and
   archive for the selected chat, so each is one keystroke or a walk through the menu
   bar away (the row's context menu needs a pointer). Archive takes Mail's ⌃⌘A. Disabled with no chat
   selected, or while the chat list's arrangement cannot be written yet.
   */
  @ViewBuilder private var chatCommands: some View {
    Button(NativeStrings.NeedsYou.title) {
      router?.present(.needsYou)
    }
    .keyboardShortcut("i", modifiers: [.command, .shift])
    .disabled(router == nil)

    // What every bot is doing now (⌘⇧A; ⌘⇧I, ⌘⇧., ⌘⇧F and ⌘⇧N are taken, and ⌃⌘A archives).
    Button(NativeStrings.Agents.command) {
      router?.present(.agents)
    }
    .keyboardShortcut("a", modifiers: [.command, .shift])
    .disabled(router == nil)

    // Every running turn of every bot, at once: ⌘⇧. is where a hand already is when something runs away.
    Button(NativeStrings.EmergencyStop.command) {
      router?.present(.emergencyStop)
    }
    .keyboardShortcut(".", modifiers: [.command, .shift])
    .disabled(router == nil)

    Divider()

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

    reorderCommands(target)

    Divider()

    Button(archived ? Strings.App.Layout.unarchive : Strings.App.Layout.archive) {
      withAnimation { arrangement?.setArchived(name, !archived) }
    }
    .keyboardShortcut("a", modifiers: [.command, .control])
    .disabled(target == nil)

    Divider()

    Button(Strings.Chat.Sessions.conversations) {
      if let chat = router?.selectedChat {
        router?.showConversations(chat)
      }
    }
    .disabled(router?.selectedChat == nil)
  }

  /**
   Move Up and Move Down (⌃⌘↑ and ⌃⌘↓) step the selected chat within its folder or the top level, and
   Move to Folder puts it in another or takes it out: the keyboard's way to the order the pointer drags
   on the list.
   */
  @ViewBuilder private func reorderCommands(_ target: (arrangement: ChatArrangementModel, name: String)?) -> some View {
    let name = target?.name ?? ""
    let steps: (up: ChatListArrangement.Anchor?, down: ChatListArrangement.Anchor?) =
      target == nil ? (nil, nil) : chatList?.steps(name) ?? (nil, nil)
    let layout = target?.arrangement.arrangement.layout
    let current = layout?.folderID(of: name)
    let roster = chatList?.roster ?? []

    Button(Strings.App.Layout.moveUp) {
      if let up = steps.up {
        withAnimation { target?.arrangement.move(name, to: up, roster: roster) }
      }
    }
    .keyboardShortcut(.upArrow, modifiers: [.command, .control])
    .disabled(steps.up == nil)

    Button(Strings.App.Layout.moveDown) {
      if let down = steps.down {
        withAnimation { target?.arrangement.move(name, to: down, roster: roster) }
      }
    }
    .keyboardShortcut(.downArrow, modifiers: [.command, .control])
    .disabled(steps.down == nil)

    Menu(Strings.App.Layout.moveToFolderMenu) {
      if current != nil {
        Button(Strings.App.Layout.topGroup) {
          withAnimation { target?.arrangement.move(name, toFolder: nil, roster: roster) }
        }
      }

      ForEach(layout?.folders.filter { $0.id != current } ?? []) { folder in
        Button(ChatFolderText.title(folder)) {
          withAnimation { target?.arrangement.move(name, toFolder: folder.id, roster: roster) }
        }
      }

      if let ask = chatList?.askNewFolder {
        Divider()
        Button(ChatFolderText.newFolderAction) { ask(name) }
          .keyboardShortcut("n", modifiers: [.command, .option])
      }
    }
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

#if os(macOS)
  /**
   The Mac's Gateway menu: every configured gateway, the one the window in front shows checked, ⌘1
   to ⌘9 for the first nine (in the order Settings lists them), then Add Gateway… and Gateway
   Settings…. A long name is cut in the middle (`MenuTitle`), so a host name keeps its start and
   its domain.

   Switching acts on the window in front (`FocusedValues.appRouter`); with no main window in front
   the gateways are listed but disabled.
   */
  struct GatewayMenu: View {
    let launch: AppLaunch
    let router: AppRouter?

    @Environment(\.openSettings) private var openSettings

    var body: some View {
      let entries = launch.gateways.entries

      ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
        Toggle(
          isOn: Binding(
            get: { entry.id == router?.selectedGatewayId },
            set: { on in
              if on, let router { perform(router.switchGateway(to: entry.id), on: launch) }
            }
          )
        ) {
          Text(MenuTitle.fitted(entry.displayLabel, typeSize: .large))
        }
        .modifier(GatewayShortcut(index: index))
        .disabled(router == nil)
        .accessibilityLabel(entry.displayLabel == entry.address ? entry.displayLabel : "\(entry.displayLabel), \(entry.address)")
      }

      if !entries.isEmpty {
        Divider()
      }

      Button(NativeStrings.Commands.addGateway) {
        router?.present(.onboarding(.additionalGateway))
      }
      .disabled(router == nil)

      Button(NativeStrings.Commands.gatewaySettings) {
        ShellRequests.shared.settingsCategory = .gateways
        openSettings()
      }
    }

    /// The shortcut of the gateway at `index`: ⌘1 to ⌘9, none after the ninth.
    static func shortcut(at index: Int) -> KeyEquivalent? {
      guard (0..<9).contains(index) else { return nil }
      return KeyEquivalent(Character(String(index + 1)))
    }
  }

  private struct GatewayShortcut: ViewModifier {
    let index: Int

    func body(content: Content) -> some View {
      if let key = GatewayMenu.shortcut(at: index) {
        content.keyboardShortcut(key, modifiers: .command)
      } else {
        content
      }
    }
  }
#endif
