import HermieCore
import SwiftUI

/**
 The sidebar's chat list (the `chatList` seam): one row per bot of the live gateway, searchable by
 name, refreshed by pulling, with a state for every way there can be no rows — loading, signed out,
 failed, empty, offline.

 Selection is the router's: a row is tagged with its `ChatRef`, and the binding the shell hands in
 opens the chat (beside the list on iPad and the Mac, pushed over it on iPhone). The arrow keys move
 the selection, which opens the chat they land on.

 It reads the session from `LiveGateway` in the environment and writes nothing but read marks.
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
          SessionChatList(session: session, selection: context.selection, query: query, signIn: { signIn(gateway.id) })
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
      case .failed(let message):
        EmptyState(
          Strings.App.Tabs.chats,
          systemImage: "exclamationmark.triangle",
          message: Text(Strings.App.Bots.failed(message: message))
        ) {
          Button(Strings.App.Common.retry) { Task { await live.reconnect() } }
            .buttonStyle(.bordered)
        }
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
  }

  private func signIn(_ gatewayId: String) {
    router?.present(.signIn(gatewayId: gatewayId))
  }
}

/// The list over a running session.
struct SessionChatList: View {
  let session: GatewaySession
  let selection: Binding<ChatRef?>
  let query: String
  let signIn: () -> Void

  var body: some View {
    let list = session.chatList
    let ready = session.status.phase == .ready
    let rows = ChatListFormat.filtered(list.names, rows: list.rows, query: query)

    List(selection: selection) {
      ForEach(rows) { listed in
        // A secure prompt waiting (a password, a sudo, a vault) counts as needing input too.
        let row = Self.marked(listed, secureInput: session.secureInput)
        ChatListRowView(row: row, gatewayReady: ready)
          .equatable()
          .tag(ChatRef(gatewayId: session.gatewayID, bot: row.bot.name))
          .contextMenu { menu(row) }
          #if os(iOS)
            .swipeActions(edge: .leading) { markRead(row) }
          #endif
      }
    }
    .overlay { overlay(list: list, rows: rows) }
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        ConnectionBanner(
          status: session.status,
          retry: { Task { await session.retryNow() } },
          signIn: signIn
        )
        GatewayNoticesView(model: session.notices, chat: nil)
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      AnonymousIdentityLine(session: session)
        .padding(.horizontal)
        .padding(.vertical, 6)
    }
    .refreshable {
      _ = try? await session.roster.refresh()
    }
    .task {
      // Running state is polled only while the list is on screen.
      await session.watchRunning()
    }
    .onDisappear {
      Task { await session.unwatchRunning() }
    }
  }

  @ViewBuilder private func overlay(list: ChatListModel, rows: [ChatListRow]) -> some View {
    if rows.isEmpty {
      if !query.trimmingCharacters(in: .whitespaces).isEmpty, !list.names.isEmpty {
        EmptyState(Strings.App.Common.search, systemImage: "magnifyingglass", message: Text(Strings.App.Bots.noMatches(query: query)))
      } else if let error = list.rosterError, list.refreshed || !list.loading {
        EmptyState(Strings.App.Tabs.chats, systemImage: "exclamationmark.triangle", message: Text(Strings.App.Bots.failed(message: error))) {
          Button(Strings.App.Common.retry) {
            Task { _ = try? await session.roster.refresh() }
          }
          .buttonStyle(.bordered)
        }
      } else if list.refreshed {
        EmptyState(Strings.App.Tabs.chats, systemImage: "person.crop.circle.badge.questionmark", message: Text(Self.emptyText))
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.App.Bots.loading).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.chatList.loading")
      }
    }
  }

  static func marked(_ row: ChatListRow, secureInput: SecureInputCenter) -> ChatListRow {
    guard !row.needsInput, secureInput.needsInput(row.bot.name) else {
      return row
    }

    var marked = row
    marked.needsInput = true
    return marked
  }

  /// The catalogue's sentence carries Markdown (a `hermes profile create` code span).
  private static var emptyText: AttributedString {
    let text = Strings.App.Bots.empty
    return (try? AttributedString(markdown: text)) ?? AttributedString(text)
  }

  @ViewBuilder private func menu(_ row: ChatListRow) -> some View {
    markRead(row)
  }

  /// The one row action this build has. More (pin, mute, archive, colour) join it here.
  @ViewBuilder private func markRead(_ row: ChatListRow) -> some View {
    if row.unread || row.unreadCount > 0 {
      Button {
        let name = row.bot.name
        Task { await session.markRead(name) }
      } label: {
        Label(Strings.App.Layout.markRead, systemImage: "checkmark.message")
      }
      .tint(.blue)
    }
  }
}
