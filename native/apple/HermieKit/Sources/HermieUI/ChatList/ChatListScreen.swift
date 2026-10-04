import HermieCore
import SwiftUI

/**
 The sidebar's chat list (the `chatList` seam): one row per bot of the live gateway, searchable by
 name, refreshed by pulling, with a state for every way there can be no rows — loading, signed out,
 failed, empty, offline.

 Selection is the router's: a row is tagged with its `ChatRef`, and the binding the shell hands in
 opens the chat (beside the list on iPad and the Mac, pushed over it on iPhone). The arrow keys move
 the selection, which opens the chat they land on.

 Pinned chats come first in their folder or at the top; folders are sections with a header that
 opens and closes them (kept on this device); archived chats leave the list for the archive (a row
 at the bottom that opens them on iPhone and iPad, a disclosure group in the Mac's sidebar). Pin,
 mute, archive, folders and order are the session's `ChatArrangementModel`, which writes them
 through the gateway's `ui_meta` so they follow the reader to their other devices and to the web
 client. Folders are made and changed from a row's menu, a folder's header menu and Settings, Chats.

 It reads the session from `LiveGateway` in the environment.
 */
public struct ChatListScreen: View {
  let context: ChatListContext

  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?
  @State private var query = ""
  @FocusState private var searchFocused: Bool

  public init(context: ChatListContext) {
    self.context = context
  }

  public var body: some View {
    content
      .searchable(text: $query, prompt: Strings.App.Bots.search)
      .searchFocused($searchFocused)
      .onChange(of: router?.findRequests ?? 0) { _, _ in
        searchFocused = true
      }
      .accessibilityIdentifier("hermie.chatList")
  }

  @ViewBuilder private var content: some View {
    if let live, let gateway = context.gateway, live.gatewayID == gateway.id {
      switch live.phase {
      case .live:
        if let session = live.session {
          // Its own identity per session: the messages search is bound to the session's link.
          SessionChatList(
            session: session, selection: context.selection, query: query, signIn: { signIn(gateway.id) },
            focusedFolderId: context.focusedFolderId
          )
          .id(ObjectIdentifier(session))
        } else {
          loading
        }
      case .signedOut:
        EmptyState(
          Strings.App.Chat.Subtitle.signedOut,
          systemImage: "person.badge.key",
          message: Text(NativeStrings.ChatList.signedOut)
        ) {
          Button(Strings.App.Common.signIn) { signIn(gateway.id) }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("hermie.chatList.signIn")
        }
        .hostedPinnedSectionPicker()
      case .failed(let message):
        EmptyState(
          Strings.App.Tabs.chats,
          systemImage: "exclamationmark.triangle",
          message: Text(Strings.App.Bots.failed(message: message))
        ) {
          Button(Strings.App.Common.retry) { Task { await live.reconnect() } }
            .buttonStyle(.bordered)
        }
        .hostedPinnedSectionPicker()
      case .connecting, .none:
        loading
      }
    } else {
      loading
    }
  }

  private var loading: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(Strings.App.Bots.loading)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.chatList.loading")
    .hostedPinnedSectionPicker()
  }

  private func signIn(_ gatewayId: String) {
    router?.present(.signIn(gatewayId: gatewayId))
  }
}

