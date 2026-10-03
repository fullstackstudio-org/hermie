import HermieCore
import SwiftUI

/// The list over a running session.
struct SessionChatList: View {
  let session: GatewaySession
  let selection: Binding<ChatRef?>
  let query: String
  let signIn: () -> Void

  /// The archive is open: the sheet on iPhone and iPad, the disclosure group on the Mac.
  @State private var archiveOpen = false
  /// The row a swipe's Mute asked a duration for.
  @State private var muting: ChatListRow?
  @Environment(AppRouter.self) private var router: AppRouter?
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    let list = session.chatList
    let ready = session.status.phase == .ready
    let rows = ChatListRows(session: session, query: query)
    let actions = ChatRowActions(session: session, openSettings: openSettings)

    List(selection: selection) {
      ForEach(rows.shown) { row in
        item(row, ready: ready, actions: actions)
          .modifier(StepActions(steps: steps(row.bot.name, in: rows)) { anchor in
            withAnimation {
              session.arrangement.move(row.bot.name, to: anchor, roster: rows.all.map(\.bot.name))
            }
          })
      }
      .onMove(perform: rows.searching || !session.arrangement.canEdit ? nil : { from, to in move(rows, from: from, to: to) })

      archive(rows, ready: ready, actions: actions)
    }
    .overlay { overlay(list: list, rows: rows) }
    .muteDialog($muting, actions: actions)
    #if os(iOS)
      .toolbar {
        // On a phone, reordering is a drag in edit mode (a long press is the row's menu). The iPad's
        // sidebar drags a row after a long press as it is, and its narrow bar keeps the gateway's
        // name instead of an Edit button.
        if sizeClass == .compact {
          ToolbarItem(placement: .topBarLeading) {
            EditButton()
              .disabled(rows.shown.count < 2 || !session.arrangement.canEdit)
              .accessibilityIdentifier("hermie.chatList.edit")
          }
        }
      }
      .sheet(isPresented: $archiveOpen) {
        ArchivedChatsSheet(session: session, selection: selection)
      }
    #endif
    .focusedSceneValue(\.chatListFocus, ChatListFocus(gatewayID: session.gatewayID, arrangement: session.arrangement))
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

  /// The row menu's Bot settings: the chat is selected and the settings page pushed over it. Not
  /// offered where there is no router (a list shown on its own).
  private var openSettings: (@MainActor (String) -> Void)? {
    guard let router else { return nil }

    let gateway = session.gatewayID
    return { name in router.showBotSettings(ChatRef(gatewayId: gateway, bot: name)) }
  }

  /// One chat's row, with everything it can do.
  private func item(_ row: ChatListRow, ready: Bool, actions: ChatRowActions) -> some View {
    ChatListRowView(
      row: row,
      gatewayReady: ready,
      pinned: session.arrangement.isPinned(row.bot.name),
      muted: session.arrangement.isMuted(row.bot.name),
      accent: session.arrangement.accent(row.bot.name)
    )
    .equatable()
    .tag(ChatRef(gatewayId: session.gatewayID, bot: row.bot.name))
    .chatRowActions(row, actions: actions, muting: $muting)
  }

  /// Where one step up and one step down land for a row, within its group; nil at the group's edge
  /// or while the order cannot be written (searching, no sync yet).
  private func steps(_ name: String, in rows: ChatListRows) -> (up: ChatListArrangement.Anchor?, down: ChatListArrangement.Anchor?) {
    guard !rows.searching, session.arrangement.canEdit else {
      return (nil, nil)
    }

    let names = rows.shown.map(\.bot.name)
    let group = Array(names[Self.group(of: name, in: names, arrangement: session.arrangement.arrangement)])

    guard let index = group.firstIndex(of: name) else {
      return (nil, nil)
    }

    return (
      index > 0 ? .before(group[index - 1]) : nil,
      index + 1 < group.count ? .after(group[index + 1]) : nil
    )
  }

  /// The rows a chat can move among: the same pinned group and the same container (the top level,
  /// or one folder), the moves `ChatListArrangement.move` makes. They are contiguous on screen:
  /// pinned chats lead, and a folder's chats stand together in its place.
  static func group(of name: String, in names: [String], arrangement: ChatListArrangement) -> Range<Int> {
    let pinned = arrangement.isPinned(name)
    let members = names.indices.filter {
      arrangement.isPinned(names[$0]) == pinned && arrangement.sameContainer(names[$0], name)
    }

    guard let first = members.first, let last = members.last else {
      return 0..<0
    }

    return first..<(last + 1)
  }

  /// A drag ended: move the chat next to the row it was dropped by, within its own group (pinned
  /// chats stay above the others, a folder's chats among themselves, and a drag across the line
  /// lands at the group's edge).
  private func move(_ rows: ChatListRows, from: IndexSet, to destination: Int) {
    guard let source = from.first, rows.shown.indices.contains(source) else {
      return
    }

    let arrangement = session.arrangement
    let names = rows.shown.map(\.bot.name)
    let moving = names[source]
    let group = Self.group(of: moving, in: names, arrangement: arrangement.arrangement)
    let target = min(max(destination, group.lowerBound), group.upperBound)

    guard let anchor = ChatListArrangement.Anchor.forDrop(names, group: group, at: target) else {
      return
    }

    withAnimation {
      arrangement.move(moving, to: anchor, roster: rows.all.map(\.bot.name))
    }
  }

  /// Where the archived chats are reached. While searching they are a section of their own, so a
  /// match is never hidden behind the archive.
  @ViewBuilder private func archive(_ rows: ChatListRows, ready: Bool, actions: ChatRowActions) -> some View {
    if !rows.archived.isEmpty {
      if rows.searching {
        Section(NativeStrings.ChatList.archivedTitle) {
          ForEach(rows.archived) { row in
            item(row, ready: ready, actions: actions)
          }
        }
      } else {
        #if os(macOS)
          // A header of its own rather than `Section(isExpanded:)`, whose arrow the sidebar shows
          // only while the pointer is over it: the archive is easy to miss as it is.
          Section {
            if archiveOpen {
              ForEach(rows.archived) { row in
                item(row, ready: ready, actions: actions)
              }
            }
          } header: {
            Button {
              withAnimation { archiveOpen.toggle() }
            } label: {
              HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                  .font(.caption.weight(.semibold))
                  .rotationEffect(.degrees(archiveOpen ? 90 : 0))
                  .accessibilityHidden(true)
                Text(Strings.App.Layout.archived(count: rows.archived.count))
              }
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(
              archiveOpen
                ? Strings.App.Layout.collapseFolder(name: NativeStrings.ChatList.archivedTitle)
                : Strings.App.Layout.expandFolder(name: NativeStrings.ChatList.archivedTitle))
            .accessibilityIdentifier("hermie.chatList.archived")
          }
        #else
          ArchiveEntryRow(count: rows.archived.count) {
            archiveOpen = true
          }
        #endif
      }
    }
  }

  @ViewBuilder private func overlay(list: ChatListModel, rows: ChatListRows) -> some View {
    if rows.shown.isEmpty, rows.archived.isEmpty {
      if rows.searching, !list.names.isEmpty {
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
}

/// The session's rows, split into the list and the archive: the arrangement's order (the roster's
/// while nobody has ordered the list, new bots at the end) narrowed by the search, pinned chats
/// lifted to the top of the list.
///
/// A new message in an archived chat leaves it in the archive, as the Expo app does: archiving is
/// how a chat stops asking for attention, so nothing but Unarchive brings it back, and the archive's
/// entry carries no unread mark. Inside the archive a row still shows its own unread state.
@MainActor
struct ChatListRows {
  var shown: [ChatListRow]
  var archived: [ChatListRow]
  /// Every row the search lets through, archived ones included, in the arrangement's order.
  var all: [ChatListRow]
  var searching: Bool

  init(session: GatewaySession, query: String) {
    let list = session.chatList
    let arrangement = session.arrangement.arrangement
    // A secure prompt waiting (a password, a sudo, a vault) counts as needing input too.
    // The name this person gave a bot leads the row, and the search finds it by that name.
    let named = list.rows.mapValues { row -> ChatListRow in
      guard let label = arrangement.label(row.bot.name) else { return row }

      var named = row
      named.bot.displayName = label
      return named
    }
    let rows = ChatListFormat.filtered(list.names, rows: named, query: query)
      .map { SessionChatList.marked($0, secureInput: session.secureInput) }

    searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    all = arrangement.ordered(rows) { $0.bot.name }
    shown = arrangement.pinnedFirst(all.filter { !arrangement.isArchived($0.bot.name) }) { $0.bot.name }
    archived = all.filter { arrangement.isArchived($0.bot.name) }
  }
}

#if os(iOS)
  /// The row at the bottom of the list that opens the archive, as Messages and WhatsApp have it.
  struct ArchiveEntryRow: View {
    let count: Int
    let open: () -> Void

    @ScaledMetric(relativeTo: .body) private var iconWidth: CGFloat = 44

    var body: some View {
      Button(action: open) {
        HStack(spacing: 12) {
          Image(systemName: "archivebox")
            .foregroundStyle(.secondary)
            .frame(width: iconWidth)
          Text(Strings.App.Layout.archived(count: count))
            .frame(maxWidth: .infinity, alignment: .leading)
          Image(systemName: "chevron.forward")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
        .contentShape(.rect)
      }
      .foregroundStyle(.primary)
      .accessibilityIdentifier("hermie.chatList.archived")
    }
  }

  /// The archive on iPhone and iPad: the archived chats, opened from the row at the bottom of the
  /// list. Choosing one opens it and closes the archive; it closes by itself once it is empty.
  struct ArchivedChatsSheet: View {
    let session: GatewaySession
    let selection: Binding<ChatRef?>

    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router: AppRouter?
    @State private var muting: ChatListRow?

    /// Bot settings from a row of the archive: the archive closes over the page it opens.
    private var openSettings: (@MainActor (String) -> Void)? {
      guard let router else { return nil }

      let gateway = session.gatewayID
      let close = dismiss

      return { name in
        router.showBotSettings(ChatRef(gatewayId: gateway, bot: name))
        close()
      }
    }

    var body: some View {
      let ready = session.status.phase == .ready
      let rows = ChatListRows(session: session, query: "").archived
      let actions = ChatRowActions(session: session, openSettings: openSettings)

      NavigationStack {
        List {
          ForEach(rows) { row in
            Button {
              selection.wrappedValue = ChatRef(gatewayId: session.gatewayID, bot: row.bot.name)
              dismiss()
            } label: {
              ChatListRowView(
                row: row,
                gatewayReady: ready,
                pinned: session.arrangement.isPinned(row.bot.name),
                muted: session.arrangement.isMuted(row.bot.name),
                accent: session.arrangement.accent(row.bot.name)
              )
              .equatable()
            }
            .foregroundStyle(.primary)
            .chatRowActions(row, actions: actions, muting: $muting)
          }
        }
        .muteDialog($muting, actions: actions)
        .navigationTitle(NativeStrings.ChatList.archivedTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button(Strings.App.Common.done) { dismiss() }
              .accessibilityIdentifier("hermie.chatList.archive.done")
          }
        }
      }
      .accessibilityIdentifier("hermie.chatList.archive")
      .onChange(of: rows.isEmpty) { _, empty in
        if empty {
          dismiss()
        }
      }
    }
  }
#endif

/// One step up and one step down as accessibility actions: VoiceOver's rotor and the Mac's keyboard
/// reach the order without a drag (the Expo app's row actions).
private struct StepActions: ViewModifier {
  let steps: (up: ChatListArrangement.Anchor?, down: ChatListArrangement.Anchor?)
  let move: (ChatListArrangement.Anchor) -> Void

  func body(content: Content) -> some View {
    content
      .accessibilityActions {
        if let up = steps.up {
          Button(Strings.App.Layout.moveUp) { move(up) }
        }

        if let down = steps.down {
          Button(Strings.App.Layout.moveDown) { move(down) }
        }
      }
  }
}
