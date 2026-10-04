import HermieCore
import SwiftUI

/**
 What a chat row can do: mark it read, pin it, mute it, archive it. One list of intentions, drawn
 four ways: the context menu (iOS and the Mac), the swipe actions (iOS), the VoiceOver actions (the
 Mac; on iOS VoiceOver offers the swipe actions as its own), and the Chat menu's commands
 (`HermieCommands`, the Mac's menu bar and the iPad's).

 The order is the Expo app's (`row-menu-items.ts`): Mark as read, then Pin above Mute because it is
 the more used of the two, and Archive last with nothing under it.

 Every change is animated, so a row that is pinned slides to the top and one that is archived
 leaves the list instead of vanishing.
 */
@MainActor
struct ChatRowActions {
  let session: GatewaySession
  /// Open the bot's settings page; nil where the list cannot navigate (the line is then not offered).
  var openSettings: (@MainActor (String) -> Void)?

  /// Ask for the name of a new folder to put this chat in; nil where the list cannot ask (the
  /// "New folder…" line is then not offered).
  var askNewFolder: (@MainActor (String) -> Void)?

  var arrangement: ChatArrangementModel { session.arrangement }

  /// Every bot the gateway has, for a move that may have to place a chat first.
  var roster: [String] { session.chatList.names }

  // MARK: The intentions

  func markRead(_ name: String) {
    Task { await session.markRead(name) }
  }

  func setArchived(_ name: String, _ archived: Bool) {
    withAnimation { arrangement.setArchived(name, archived) }
  }

  func setPinned(_ name: String, _ pinned: Bool) {
    withAnimation { arrangement.setPinned(name, pinned) }
  }

  func mute(_ name: String, for duration: MuteDuration) {
    withAnimation { arrangement.mute(name, for: duration) }
  }

  func unmute(_ name: String) {
    withAnimation { arrangement.setMute(name, until: nil) }
  }

  /// Put the chat in a folder, or out of any folder (`nil`).
  func moveToFolder(_ name: String, _ folder: String?) {
    withAnimation { arrangement.move(name, toFolder: folder, roster: roster) }
  }

  // MARK: The context menu

  @ViewBuilder func menu(_ row: ChatListRow) -> some View {
    let name = row.bot.name

    markReadButton(row)
    settingsButton(name)

    if arrangement.canEdit {
      pinButton(name)
      muteItems(name)
      folderMenu(name)
      Divider()
      archiveButton(name)
    }
  }

  @ViewBuilder func markReadButton(_ row: ChatListRow) -> some View {
    if row.unread || row.unreadCount > 0 {
      Button {
        markRead(row.bot.name)
      } label: {
        Label(Strings.App.Layout.markRead, systemImage: "checkmark.message")
      }
      .tint(.blue)
    }
  }

  @ViewBuilder func settingsButton(_ name: String) -> some View {
    if let openSettings {
      Button {
        openSettings(name)
      } label: {
        Label(NativeStrings.BotSettings.title, systemImage: "slider.horizontal.3")
      }
      .accessibilityIdentifier("hermie.chatList.action.settings")
    }
  }

  func pinButton(_ name: String) -> some View {
    let pinned = arrangement.isPinned(name)

    return Button {
      setPinned(name, !pinned)
    } label: {
      Label(pinned ? Strings.App.Layout.unpin : Strings.App.Layout.pin, systemImage: pinned ? "pin.slash" : "pin")
    }
    .accessibilityIdentifier("hermie.chatList.action.pin")
  }

  func archiveButton(_ name: String) -> some View {
    let archived = arrangement.isArchived(name)

    return Button {
      setArchived(name, !archived)
    } label: {
      Label(
        archived ? Strings.App.Layout.unarchive : Strings.App.Layout.archive,
        systemImage: archived ? "tray.and.arrow.up" : "archivebox"
      )
    }
    .accessibilityIdentifier(archived ? "hermie.chatList.action.unarchive" : "hermie.chatList.action.archive")
  }

  /// Not muted: Mute and its four durations. Muted: a line saying until when (the mute may have
  /// been set on another device, days ago), then Unmute.
  @ViewBuilder func muteItems(_ name: String) -> some View {
    if let until = arrangement.mutedUntil(name) {
      Button(ChatListFormat.mutedState(until)) {}
        .disabled(true)
      Button {
        unmute(name)
      } label: {
        Label(Strings.App.Layout.unmute, systemImage: "bell")
      }
    } else {
      Menu {
        ForEach(MuteDuration.allCases, id: \.self) { duration in
          Button(ChatListFormat.muteTitle(duration)) {
            mute(name, for: duration)
          }
        }
      } label: {
        Label(Strings.App.Layout.mute, systemImage: "bell.slash")
      }
    }
  }

  /// Move to folder: No folder (when it is in one), each other folder, and a new one.
  @ViewBuilder func folderMenu(_ name: String) -> some View {
    let layout = arrangement.arrangement.layout
    let current = layout.folderID(of: name)
    let others = layout.folders.filter { $0.id != current }

    if current != nil || !others.isEmpty || askNewFolder != nil {
      Menu {
        if current != nil {
          Button {
            moveToFolder(name, nil)
          } label: {
            Label(Strings.App.Layout.topGroup, systemImage: "tray")
          }
        }

        ForEach(others) { folder in
          Button {
            moveToFolder(name, folder.id)
          } label: {
            Label(ChatFolderText.title(folder), systemImage: "folder")
          }
        }

        if let askNewFolder {
          Divider()
          Button {
            askNewFolder(name)
          } label: {
            Label(ChatFolderText.newFolderAction, systemImage: "folder.badge.plus")
          }
        }
      } label: {
        Label(Strings.App.Layout.moveToFolderMenu, systemImage: "folder")
      }
      .accessibilityIdentifier("hermie.chatList.action.folder")
    }
  }

  // MARK: The swipe actions (iOS)

  @ViewBuilder func leadingSwipe(_ row: ChatListRow) -> some View {
    markReadButton(row)

    if arrangement.canEdit {
      pinButton(row.bot.name).tint(.orange)
    }
  }

  /// Archive on the full swipe; Mute asks for a duration (`muteDialog`), Unmute is one tap.
  @ViewBuilder func trailingSwipe(_ row: ChatListRow, askMute: @escaping () -> Void) -> some View {
    let name = row.bot.name

    if arrangement.canEdit {
      archiveButton(name).tint(.indigo)

      if arrangement.isMuted(name) {
        Button {
          unmute(name)
        } label: {
          Label(Strings.App.Layout.unmute, systemImage: "bell")
        }
        .tint(.purple)
      } else {
        Button(action: askMute) {
          Label(Strings.App.Layout.mute, systemImage: "bell.slash")
        }
        .tint(.purple)
        .accessibilityIdentifier("hermie.chatList.action.mute")
      }
    }
  }

  // MARK: VoiceOver (the Mac)

  /// Every intention as a flat action, the durations spelt out, so the actions rotor reaches all of
  /// them without a submenu.
  @ViewBuilder func accessibilityActions(_ row: ChatListRow) -> some View {
    let name = row.bot.name

    if row.unread || row.unreadCount > 0 {
      Button(Strings.App.Layout.markRead) { markRead(name) }
    }

    if let openSettings {
      Button(NativeStrings.BotSettings.title) { openSettings(name) }
    }

    if arrangement.canEdit {
      Button(arrangement.isPinned(name) ? Strings.App.Layout.unpin : Strings.App.Layout.pin) {
        setPinned(name, !arrangement.isPinned(name))
      }

      if arrangement.isMuted(name) {
        Button(Strings.App.Layout.unmute) { unmute(name) }
      } else {
        ForEach(MuteDuration.allCases, id: \.self) { duration in
          Button("\(Strings.App.Layout.mute): \(ChatListFormat.muteTitle(duration))") {
            mute(name, for: duration)
          }
        }
      }

      let layout = arrangement.arrangement.layout
      let current = layout.folderID(of: name)

      if current != nil {
        Button(Strings.App.Layout.moveToFolder(folder: Strings.App.Layout.topGroup)) { moveToFolder(name, nil) }
      }

      ForEach(layout.folders.filter { $0.id != current }) { folder in
        Button(Strings.App.Layout.moveToFolder(folder: ChatFolderText.title(folder))) { moveToFolder(name, folder.id) }
      }

      Button(arrangement.isArchived(name) ? Strings.App.Layout.unarchive : Strings.App.Layout.archive) {
        setArchived(name, !arrangement.isArchived(name))
      }
    }
  }
}

extension View {
  /// The row's context menu, swipe actions (iOS) and VoiceOver actions (the Mac).
  func chatRowActions(_ row: ChatListRow, actions: ChatRowActions, muting: Binding<ChatListRow?>) -> some View {
    contextMenu { actions.menu(row) }
      #if os(iOS)
        .swipeActions(edge: .leading) { actions.leadingSwipe(row) }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          actions.trailingSwipe(row) { muting.wrappedValue = row }
        }
      #else
        .accessibilityActions { actions.accessibilityActions(row) }
      #endif
  }

  /// The durations a swipe's Mute offers, as an action sheet.
  func muteDialog(_ muting: Binding<ChatListRow?>, actions: ChatRowActions) -> some View {
    confirmationDialog(
      NativeStrings.ChatList.muteTitle(name: muting.wrappedValue?.bot.displayName ?? ""),
      isPresented: Binding(get: { muting.wrappedValue != nil }, set: { if !$0 { muting.wrappedValue = nil } }),
      titleVisibility: .visible,
      presenting: muting.wrappedValue
    ) { row in
      ForEach(MuteDuration.allCases, id: \.self) { duration in
        Button(ChatListFormat.muteTitle(duration)) {
          actions.mute(row.bot.name, for: duration)
        }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    }
  }
}

/// The chat list of the window in front, for the Chat menu's commands: which gateway it shows and
/// the arrangement they change.
struct ChatListFocus {
  let gatewayID: String
  let arrangement: ChatArrangementModel
  /// Every bot the gateway has.
  var roster: [String] = []
  /// Where one step up and one step down land for a chat; nothing while the order cannot be written
  /// (a search is narrowing the list).
  var steps: (String) -> (up: ChatListArrangement.Anchor?, down: ChatListArrangement.Anchor?) = { _ in (nil, nil) }
  /// Ask for the name of a new folder, with this chat in it.
  var askNewFolder: (@MainActor (String) -> Void)?
}

extension FocusedValues {
  @Entry var chatListFocus: ChatListFocus?
}
