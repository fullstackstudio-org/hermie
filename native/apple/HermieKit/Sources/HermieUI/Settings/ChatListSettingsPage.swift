import HermieCore
import SwiftUI

/// Settings, Chats: the entry that finds the live gateway's session.
struct ChatListSettingsEntry: View {
  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let session = live?.session {
      ChatListSettingsPage(session: session)
    } else {
      Form {
        Section {
          Text(NativeStrings.ChatList.settingsNoGateway)
            .foregroundStyle(Color.primary)
        }
      }
      .formStyle(.grouped)
      .accessibilityIdentifier("hermie.settings.chats")
    }
  }
}

/**
 Settings, Chats: the person's folders and where each chat is. It edits the same `ui_meta`
 arrangement as the chat list's own menus and as the web client's Settings, Chat list, so what is
 done here follows the person to their other devices.

 Folders are made, renamed, coloured, ordered and deleted here (a deleted folder keeps its chats, at
 the folder's place); every chat has a menu with the folder it is in. Everything is a button or a
 menu, so it is as reachable by keyboard and VoiceOver as by touch; the chat list adds the drags.
 */
struct ChatListSettingsPage: View {
  let session: GatewaySession

  @State private var naming: FolderNaming?

  var body: some View {
    let arrangement = session.arrangement
    let layout = arrangement.arrangement.layout
    let roster = session.chatList.names
    let chats = chatNames(arrangement.arrangement, roster: roster)

    Form {
      Section {
        Text(NativeStrings.ChatList.settingsIntro)
          .foregroundStyle(Color.primary)
      }

      Section(NativeStrings.ChatList.settingsFolders) {
        if layout.folders.isEmpty {
          Text(NativeStrings.ChatList.settingsNoFolders)
            .foregroundStyle(Color.primary)
        }

        ForEach(layout.folders) { folder in
          folderRow(folder, in: layout, arrangement: arrangement)
        }

        Button {
          naming = .new(chat: nil)
        } label: {
          Label(Strings.App.Layout.newFolder, systemImage: "folder.badge.plus")
        }
        .accessibilityIdentifier("hermie.settings.chats.newFolder")
      }

      Section(NativeStrings.ChatList.settingsChats) {
        if chats.isEmpty {
          Text(NativeStrings.ChatList.settingsNoChats)
            .foregroundStyle(Color.primary)
        }

        ForEach(chats, id: \.self) { name in
          chatRow(name, layout: layout, arrangement: arrangement, roster: roster)
        }
      }
    }
    .formStyle(.grouped)
    .disabled(!arrangement.canEdit)
    .folderNameAlert($naming) { request, name in
      switch request {
      case .new(let chat):
        arrangement.newFolder(name, containing: chat, roster: roster)
      case .rename(let folder, _):
        arrangement.renameFolder(folder, to: name)
      }
    }
    .accessibilityIdentifier("hermie.settings.chats")
  }

  /// Every chat of the gateway, in the order the list draws them, the archived ones last.
  private func chatNames(_ arrangement: ChatListArrangement, roster: [String]) -> [String] {
    let sections = arrangement.sections(roster) { $0 }
    return sections.visible + sections.archived
  }

  private func folderRow(_ folder: ChatFolder, in layout: ChatLayout, arrangement: ChatArrangementModel) -> some View {
    let title = ChatFolderText.title(folder)
    let index = layout.folders.firstIndex { $0.id == folder.id } ?? 0

    return HStack(spacing: 10) {
      Circle()
        .fill(folder.colour == .default ? Color.secondary.opacity(0.35) : folder.colour.fill)
        .frame(width: 12, height: 12)
        .accessibilityHidden(true)

      Text(title)
        .foregroundStyle(Color.primary)
        .frame(maxWidth: .infinity, alignment: .leading)

      Text(folder.bots.count.formatted())
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)

      Menu {
        FolderMenuItems(id: folder.id, name: folder.name, colour: folder.colour, arrangement: arrangement) {
          naming = .rename(folder: folder.id, name: folder.name)
        }

        Divider()

        Button {
          withAnimation { arrangement.stepFolder(folder.id, by: -1) }
        } label: {
          Label(Strings.App.Layout.moveUp, systemImage: "arrow.up")
        }
        .disabled(index == 0)

        Button {
          withAnimation { arrangement.stepFolder(folder.id, by: 1) }
        } label: {
          Label(Strings.App.Layout.moveDown, systemImage: "arrow.down")
        }
        .disabled(index + 1 >= layout.folders.count)
      } label: {
        Image(systemName: "ellipsis.circle")
          .accessibilityLabel(Strings.App.Layout.folderActions(name: folder.name))
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .accessibilityIdentifier("hermie.settings.chats.folder.\(folder.id)")
    }
    .accessibilityElement(children: .contain)
  }

  private func chatRow(_ name: String, layout: ChatLayout, arrangement: ChatArrangementModel, roster: [String]) -> some View {
    let label = arrangement.label(name) ?? session.chatList.rows[name]?.bot.displayName ?? name

    return Picker(
      selection: Binding<String?>(
        get: { layout.folderID(of: name) },
        set: { arrangement.move(name, toFolder: $0, roster: roster) }
      )
    ) {
      Text(Strings.App.Layout.topGroup).tag(String?.none)

      ForEach(layout.folders) { folder in
        Text(ChatFolderText.title(folder)).tag(String?.some(folder.id))
      }
    } label: {
      Text(verbatim: label)
        .foregroundStyle(Color.primary)
    }
    .accessibilityHint(Strings.App.Layout.moveToFolderMenu)
    .accessibilityIdentifier("hermie.settings.chats.chat.\(name)")
  }
}
