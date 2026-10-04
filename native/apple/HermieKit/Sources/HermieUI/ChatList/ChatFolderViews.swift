import HermieCore
import SwiftUI

/// The words the folders use, from the catalogue the web client shares.
enum ChatFolderText {
  /// A folder's name, or "Untitled folder" for one with none.
  static func title(_ name: String) -> String {
    name.isEmpty ? Strings.App.Layout.unnamedFolder : name
  }

  static func title(_ folder: ChatFolder) -> String {
    title(folder.name)
  }

  /// New folder…, the line that opens the naming alert.
  static var newFolderAction: String {
    Strings.App.Layout.newFolder + "…"
  }
}

/// What the naming alert is asking for: a name for a new folder (with a chat to put in it, or none)
/// or a new name for one that exists.
enum FolderNaming: Identifiable, Equatable {
  case new(chat: String?)
  case rename(folder: String, name: String)

  var id: String {
    switch self {
    case .new(let chat): "new:\(chat ?? "")"
    case .rename(let folder, _): "rename:\(folder)"
    }
  }

  var title: String {
    switch self {
    case .new: Strings.App.Layout.newFolder
    case .rename: Strings.App.Layout.rename
    }
  }

  var confirm: String {
    switch self {
    case .new: Strings.App.Common.add
    case .rename: Strings.App.Layout.rename
    }
  }

  /// What the field starts with.
  var initialName: String {
    switch self {
    case .new: ""
    case .rename(_, let name): name
    }
  }

  /// A new folder needs a name; a folder may be renamed to none (it is then untitled).
  var requiresName: Bool {
    if case .new = self { true } else { false }
  }
}

/// The alert with a name field that both a new folder and a rename use.
private struct FolderNameAlert: ViewModifier {
  @Binding var naming: FolderNaming?
  let commit: (FolderNaming, String) -> Void

  @State private var text = ""

  func body(content: Content) -> some View {
    content
      .alert(
        naming?.title ?? "",
        isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } }),
        presenting: naming
      ) { request in
        TextField(Strings.App.Layout.folderName, text: $text)
        Button(Strings.App.Common.cancel, role: .cancel) {}
        Button(request.confirm) {
          commit(request, text)
        }
        .disabled(request.requiresName && ChatFolder.cleaned(text).isEmpty)
      }
      .onChange(of: naming, initial: true) { _, request in
        text = request?.initialName ?? ""
      }
  }
}

extension View {
  /// Ask for a folder's name (`naming`) and hand it to `commit` with the request.
  func folderNameAlert(_ naming: Binding<FolderNaming?>, commit: @escaping (FolderNaming, String) -> Void) -> some View {
    modifier(FolderNameAlert(naming: naming, commit: commit))
  }
}

/// A folder's own commands: rename, colour, delete (the chats stay). Drawn in the header's context
/// menu and, in Settings, in each folder's menu.
struct FolderMenuItems: View {
  let id: String
  let name: String
  let colour: BotAccent
  let arrangement: ChatArrangementModel
  let rename: () -> Void

  var body: some View {
    Button {
      rename()
    } label: {
      Label(Strings.App.Layout.rename, systemImage: "pencil")
    }
    .accessibilityIdentifier("hermie.chatList.folder.rename")

    Picker(
      Strings.App.Layout.folderColour,
      selection: Binding(get: { colour }, set: { arrangement.setFolderColour(id, to: $0) })
    ) {
      ForEach(BotAccent.allCases, id: \.self) { accent in
        Label {
          Text(BotSettingsText.name(of: accent))
        } icon: {
          Image(systemName: "circle.fill").foregroundStyle(accent.fill)
        }
        .tag(accent)
      }
    }

    Divider()

    Button(role: .destructive) {
      withAnimation { arrangement.removeFolder(id) }
    } label: {
      Label(Strings.App.Layout.deleteFolder, systemImage: "trash")
    }
    .accessibilityIdentifier("hermie.chatList.folder.delete")
  }
}

/// A folder's header in the chat list: one button that opens and closes it, with the folder's colour,
/// its name and how many chats it holds. A closed folder says what is waiting inside it, so a chat
/// that wants attention is not hidden by the folder. While a search shows its matches the header is
/// held open and says what the folder is and does nothing.
struct FolderHeader: View {
  let folder: ChatListSections<ChatListRow>.Folder
  let open: Bool
  /// Held open (a search is showing its matches).
  let fixed: Bool
  let toggle: () -> Void

  var body: some View {
    let title = ChatFolderText.title(folder.name)

    Group {
      if fixed {
        face(title)
          .accessibilityElement(children: .combine)
      } else {
        Button(action: toggle) {
          face(title)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value)
        .accessibilityHint(
          open ? Strings.App.Layout.collapseFolder(name: title) : Strings.App.Layout.expandFolder(name: title)
        )
      }
    }
    .textCase(nil)
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("hermie.chatList.folder.\(folder.id)")
  }

  private func face(_ title: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .rotationEffect(.degrees(open ? 90 : 0))
        .accessibilityHidden(true)

      if folder.colour != .default {
        Circle()
          .fill(folder.colour.fill)
          .frame(width: 9, height: 9)
          .accessibilityHidden(true)
      }

      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Color.primary)
        .lineLimit(1)

      Spacer(minLength: 8)

      if !open {
        waiting
      }

      Text(folder.chats.count.formatted())
        .font(.caption)
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
  }

  /// Unread and needs-input, summed over what the closed folder holds.
  @ViewBuilder private var waiting: some View {
    if needsInput {
      Image(systemName: "exclamationmark.bubble.fill")
        .foregroundStyle(.orange)
        .imageScale(.small)
        .accessibilityHidden(true)
    }

    if unreadCount > 0 {
      Text(unreadCount > 99 ? "99+" : String(unreadCount))
        .font(.caption.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(.white)
        .padding(.horizontal, 7)
        .padding(.vertical, 1)
        .background(Color.accentColor.mix(with: .black, by: 0.25), in: .capsule)
        .accessibilityHidden(true)
    } else if folder.chats.contains(where: \.unread) {
      Circle()
        .fill(.tint)
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
    }
  }

  private var unreadCount: Int {
    folder.chats.reduce(0) { $0 + $1.unreadCount }
  }

  private var needsInput: Bool {
    folder.chats.contains(where: \.needsInput)
  }

  /// What VoiceOver adds after the name: how many are waiting, and whether one needs the reader.
  private var value: String {
    var parts: [String] = []

    if !open {
      if unreadCount > 0 {
        parts.append(Strings.App.Layout.folderUnread(count: unreadCount))
      }

      if needsInput {
        parts.append(Strings.App.Layout.folderNeedsInput)
      }
    }

    return parts.joined(separator: ", ")
  }
}
