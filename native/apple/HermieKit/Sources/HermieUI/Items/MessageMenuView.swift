import HermieCore
import HermieTranscript
import SwiftUI

/// The menu of a message: what a long press on its bubble opens on iOS and a right-click on the Mac,
/// and what VoiceOver offers as the message's actions. One list for all three (`MessageMenu`), read
/// when the menu opens: whether Regenerate is on the newest reply, and whether a turn runs, are the
/// chat's to say then (`TranscriptItemActions.messageMenu`), because a row is not redrawn when the
/// newest reply moves on.
struct MessageMenuItems: View {
  let item: TranscriptItem
  /// VoiceOver's list cannot hold a submenu: the links are lines of their own there.
  var flattensLinks = false

  @Environment(\.transcriptItemActions) private var actions

  var body: some View {
    let menu = actions.messageMenu(item)

    ForEach(menu.entries, id: \.action) { entry in
      Button {
        choose(entry.action)
      } label: {
        Label(Self.title(entry.action), systemImage: Self.symbol(entry.action))
      }
      .disabled(!entry.enabled)
    }

    if flattensLinks || menu.links.count == 1 {
      ForEach(menu.links, id: \.self) { link in
        Button {
          actions.copy(link)
        } label: {
          if flattensLinks {
            Text(verbatim: "\(Strings.Chat.Menu.copyLink): \(Self.linkTitle(link))")
          } else {
            Label(Strings.Chat.Menu.copyLink, systemImage: "link")
          }
        }
      }
    } else if menu.links.count > 1 {
      Menu {
        ForEach(menu.links, id: \.self) { link in
          Button(Self.linkTitle(link)) { actions.copy(link) }
        }
      } label: {
        Label(NativeStrings.ChatMenu.copyLinks, systemImage: "link")
      }
    }
  }

  /// The words are read off the item the row holds when the line is chosen.
  private func choose(_ action: MessageMenu.Action) {
    switch action {
    case .copyText:
      if let text = MessageMenu.copyText(of: item) { actions.copy(text) }
    case .copyMarkdown:
      if let text = MessageMenu.copyMarkdown(of: item) { actions.copy(text) }
    case .editResend, .regenerate, .branch:
      actions.chooseMessageAction(action, item)
    }
  }

  static func title(_ action: MessageMenu.Action) -> String {
    switch action {
    case .copyText: Strings.Chat.Menu.copyText
    case .copyMarkdown: Strings.Chat.Menu.copyMarkdown
    case .editResend: Strings.Chat.Menu.editResend
    case .regenerate: Strings.Chat.Menu.regenerate
    case .branch: Strings.Chat.Sessions.branch
    }
  }

  static func symbol(_ action: MessageMenu.Action) -> String {
    switch action {
    case .copyText: "doc.on.doc"
    case .copyMarkdown: "chevron.left.forwardslash.chevron.right"
    case .editResend: "pencil"
    case .regenerate: "arrow.clockwise"
    case .branch: "arrow.triangle.branch"
    }
  }

  /// A link as a line of the menu: the writer's own text, cleaned and cut (control and direction
  /// characters out, one line).
  static func linkTitle(_ link: String) -> String {
    SecurePrompt.displayText(link, limit: 80).replacingOccurrences(of: "\n", with: " ")
  }
}

extension View {
  /// The message's menu on this view (a bubble): long press on iOS, right-click on the Mac.
  func messageMenu(for item: TranscriptItem) -> some View {
    contextMenu { MessageMenuItems(item: item) }
  }
}

extension NativeStrings {
  enum ChatMenu {
    /// The submenu of a message that holds several links, each a line that copies it.
    static var copyLinks: String {
      String(localized: "native.chat.menu.copyLinks", table: "Native", bundle: .module)
    }
  }
}
