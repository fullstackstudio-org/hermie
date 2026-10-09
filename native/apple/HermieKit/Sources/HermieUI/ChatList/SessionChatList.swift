import HermieCore
import SwiftUI

/// The list over a running session.
struct SessionChatList: View {
  let session: GatewaySession
  let selection: Binding<ChatRef?>
  let query: String
  let signIn: () -> Void
  /// A folder a `hermie://folder/<id>` link asked to reveal: opened and scrolled to, then cleared.
  var focusedFolderId: Binding<String?> = .constant(nil)

  /// The archive is open: the sheet on iPhone and iPad, the disclosure group on the Mac.
  @State private var archiveOpen = false
  /// The row a swipe's Mute asked a duration for.
  @State private var muting: ChatListRow?
  /// The folders the reader has closed, on this device.
  @State private var collapse = ChatFolderCollapse()
  /// The folder name the alert is asking for.
  @State private var naming: FolderNaming?
  /// What the bots' messages say about the words in the field, over this session's gateway.
  @State private var messages: MessageSearchModel
  /// Names this list in the Chat menu's focused value (`ChatListFocus.owner`), across its bodies.
  @State private var focusOwner = UUID()
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.chatListHostsSectionPicker) private var hostsSectionPicker
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  /// The model is bound to the session's link: a list over another session is another view (the screen
  /// gives each its own identity).
  init(
    session: GatewaySession, selection: Binding<ChatRef?>, query: String, signIn: @escaping () -> Void,
    focusedFolderId: Binding<String?> = .constant(nil)
  ) {
    self.session = session
    self.selection = selection
    self.query = query
    self.signIn = signIn
    self.focusedFolderId = focusedFolderId
    _messages = State(initialValue: session.messageSearch())
  }

  var body: some View {
    ScrollViewReader { proxy in
      chatList
        .onChange(of: focusedFolderId.wrappedValue, initial: true) { _, _ in reveal(proxy) }
        .onChange(of: session.arrangement.arrangement.layout) { _, _ in reveal(proxy) }
    }
  }

  private var chatList: some View {
    let list = session.chatList
    let ready = session.status.phase == .ready
    let rows = ChatListRows(session: session, query: query)
    var actions = ChatRowActions(session: session, openSettings: openSettings)
    actions.askNewFolder = { naming = .new(chat: $0) }
    let search = MessageSearchRequest(session: session, query: query, ready: ready)
    let status = search.status(of: messages)

    return List(selection: selection) {
      if hostsSectionPicker, router != nil {
        sectionPicker
      }

      ForEach(rows.sections.blocks) { block in
        self.block(block, rows: rows, ready: ready, actions: actions)
      }

      archive(rows, ready: ready, actions: actions)

      messageHits(status, rows: rows, ready: ready)

      everywhereRow(rows)
    }
    .overlay { overlay(list: list, rows: rows, messages: status) }
    // Searched once the field has been still, and again when what is searched changes; a task that
    // is replaced is a query that is superseded.
    .task(id: search.key) {
      await messages.run(query: search.query, bots: search.bots, ready: ready)
    }
    .onChange(of: status) { _, status in
      // Said aloud for what a reader cannot see change: no hit at all, or no search at all.
      if status == .none || status == .failed {
        AccessibilityNotification.Announcement(status.text).post()
      }
    }
    .folderNameAlert($naming) { request, name in
      commit(request, name: name)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          router?.present(.newBot)
        } label: {
          Label(Strings.Profiles.New.title, systemImage: "person.crop.circle.badge.plus")
        }
        .disabled(!ready || router == nil)
        .help(Strings.Profiles.New.title)
        .accessibilityHint(NativeStrings.NewBot.open)
        .accessibilityIdentifier("hermie.chatList.newBot")
      }
    }
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
    .focusedSceneValue(\.chatListFocus, focus(rows, askNewFolder: actions.askNewFolder))
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

  /// The Chats / Activity / Crons picker as the list's first row, under the large title: it scrolls
  /// with the list and moves down with the title on a pull, never pinned over it. On the phone it
  /// spans the width of the rows' card; elsewhere the list's own row insets apply.
  @ViewBuilder private var sectionPicker: some View {
    let section = Section {
      SidebarSectionPicker()
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .selectionDisabled()
        #if os(iOS)
          .listRowInsets(sizeClass == .compact ? EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0) : nil)
        #endif
    }

    #if os(iOS)
      section.listSectionSpacing(.compact)
    #else
      section
    #endif
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

  // MARK: Folders

  /// Every bot the gateway has: what a move that has to place a chat first folds in.
  private var roster: [String] { session.chatList.names }

  /// One block of the list: a run of loose chats, or a folder under its header.
  @ViewBuilder private func block(
    _ block: ChatListSections<ChatListRow>.Block, rows: ChatListRows, ready: Bool, actions: ChatRowActions
  ) -> some View {
    switch block {
    case .chats(_, let chats):
      Section {
        chatRows(chats, rows: rows, ready: ready, actions: actions)
      }
    case .folder(let folder):
      let open = rows.searching || !collapse.isCollapsed(folder.id, gateway: session.gatewayID)

      Section {
        if open {
          chatRows(folder.chats, rows: rows, ready: ready, actions: actions)
        }
      } header: {
        folderHeader(folder, open: open, rows: rows)
      }
    }
  }

  private func folderHeader(_ folder: ChatListSections<ChatListRow>.Folder, open: Bool, rows: ChatListRows) -> some View {
    let arrangement = session.arrangement
    let gateway = session.gatewayID
    let id = folder.id

    return FolderHeader(folder: folder, open: open, fixed: rows.searching) {
      withAnimation { collapse.toggle(id, gateway: gateway) }
    }
    .contextMenu {
      if arrangement.canEdit {
        FolderMenuItems(id: id, name: folder.name, colour: folder.colour, arrangement: arrangement) {
          naming = .rename(folder: id, name: folder.name)
        }

        Divider()

        Button {
          naming = .new(chat: nil)
        } label: {
          Label(ChatFolderText.newFolderAction, systemImage: "folder.badge.plus")
        }
      }
    }
    #if os(macOS)
      .modifier(
        FolderDrop(gatewayID: gateway) { name in
          withAnimation { arrangement.move(name, toFolder: id, roster: roster) }
        })
    #endif
  }

  /// The chats of one run or one folder, each with its row's actions and its steps; reordered by a
  /// drag in edit mode (iOS) or by dropping a chat on a row (the Mac).
  private func chatRows(_ chats: [ChatListRow], rows: ChatListRows, ready: Bool, actions: ChatRowActions) -> some View {
    let movable = !rows.searching && session.arrangement.canEdit
    let sections = rows.sections

    return ForEach(chats) { row in
      item(row, ready: ready, actions: actions)
        .modifier(
          StepActions(steps: movable ? sections.steps(of: row.bot.name) : (nil, nil)) { anchor in
            withAnimation {
              session.arrangement.move(row.bot.name, to: anchor, roster: roster)
            }
          }
        )
        #if os(macOS)
          .modifier(
            ChatRowDragDrop(
              gatewayID: session.gatewayID, bot: row.bot.name,
              anchor: { movable ? sections.dropAnchor(moving: $0, onto: row.bot.name) : nil },
              drop: { name, anchor in
                withAnimation { session.arrangement.place(name, at: anchor, roster: roster) }
              }))
        #endif
    }
    #if os(iOS)
      .onMove(perform: movable ? { from, to in moveWithin(chats, sections: sections, from: from, to: to) } : nil)
    #endif
  }

  #if os(iOS)
    /// A drag ended: move the chat next to the row it was dropped by, within its own set (pinned chats
    /// stay above the others, and a drag across the line lands at the set's edge).
    private func moveWithin(_ chats: [ChatListRow], sections: ChatListSections<ChatListRow>, from: IndexSet, to destination: Int) {
      guard let source = from.first, chats.indices.contains(source) else {
        return
      }

      let names = chats.map(\.bot.name)
      let moving = names[source]

      guard let anchor = sections.dropAnchor(moving: moving, in: names, at: destination) else {
        return
      }

      withAnimation {
        session.arrangement.move(moving, to: anchor, roster: roster)
      }
    }
  #endif

  /// What the Chat menu's commands act on.
  private func focus(_ rows: ChatListRows, askNewFolder: (@MainActor (String) -> Void)?) -> ChatListFocus {
    let movable = !rows.searching && session.arrangement.canEdit

    return ChatListFocus(
      owner: focusOwner,
      gatewayID: session.gatewayID,
      arrangement: session.arrangement,
      roster: roster,
      moves: movable ? rows.sections.moves : .none,
      askNewFolder: askNewFolder
    )
  }

  /// The naming alert's answer: a new folder (with the chat that asked for it), or a new name.
  private func commit(_ request: FolderNaming, name: String) {
    switch request {
    case .new(let chat):
      withAnimation { _ = session.arrangement.newFolder(name, containing: chat, roster: roster) }
    case .rename(let folder, _):
      session.arrangement.renameFolder(folder, to: name)
    }
  }

  /// A link asked for a folder: open it and scroll to it, once the arrangement has it.
  private func reveal(_ proxy: ScrollViewProxy) {
    guard let id = focusedFolderId.wrappedValue, session.arrangement.arrangement.layout.folder(id) != nil else {
      return
    }

    collapse.setCollapsed(false, folder: id, gateway: session.gatewayID)
    focusedFolderId.wrappedValue = nil

    Task { @MainActor in
      await Task.yield()
      withAnimation { proxy.scrollTo(ChatListSections<ChatListRow>.blockID(folder: id), anchor: .top) }
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

  /// Under the chats: the chats whose messages hold the words. Only the best match per chat comes back,
  /// so each row is a bot, and tapping it opens that chat at the newest message with the words in it.
  /// What the section says while it works, or when nothing matched, is its last row. Not drawn at all
  /// when no chat matched by name either and the search found nothing: the whole list then says so
  /// (`overlay`).
  @ViewBuilder private func messageHits(_ status: MessageSearchStatus, rows: ChatListRows, ready: Bool) -> some View {
    let namesMatched = !rows.shown.isEmpty || !rows.archived.isEmpty
    let spoken = status == .none || status == .failed

    if rows.searching, status != .idle, namesMatched || !spoken {
      Section {
        if status == .hits {
          ForEach(messages.matches) { match in
            if let row = session.chatList.rows[match.bot] {
              MessageHitRow(
                match: match,
                row: row,
                name: session.chatName(match.bot),
                gatewayReady: ready,
                accent: session.arrangement.accent(match.bot)
              ) {
                openHit(match)
              }
            }
          }
        }

        MessageSearchStatusRow(status: status)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
          .selectionDisabled()
      } header: {
        Text(Strings.App.Bots.messagesHeader)
      }
    }
  }

  /// Under a search: the way to the search over every conversation, which lists every chat of every bot on
  /// every gateway that holds the words, not only the best one per bot of this gateway.
  @ViewBuilder private func everywhereRow(_ rows: ChatListRows) -> some View {
    if rows.searching, let router {
      Section {
        Button {
          router.presentSearch(seed: query)
        } label: {
          Label(NativeStrings.Search.everywhere(query: MessageSearchModel.normalized(query)), systemImage: "magnifyingglass")
            .lineLimit(2)
        }
        .accessibilityIdentifier("hermie.chatList.searchEverywhere")
      }
    }
  }

  /// Open the chat of a hit, at the message: the router takes the words to the chat screen, which finds
  /// the row (and pages back for it) once it is open. A list shown without a router just selects it.
  private func openHit(_ match: MessageMatch) {
    let chat = ChatRef(gatewayId: session.gatewayID, bot: match.bot)

    if let router {
      router.openChat(chat, finding: query)
    } else {
      selection.wrappedValue = chat
    }
  }

  @ViewBuilder private func overlay(list: ChatListModel, rows: ChatListRows, messages status: MessageSearchStatus)
    -> some View
  {
    if rows.shown.isEmpty, rows.archived.isEmpty {
      if rows.searching, !list.names.isEmpty {
        // The messages section speaks for a search that is still out or found chats; the list only
        // says "nothing" when the messages did not find any either.
        if status == .failed {
          EmptyState(Strings.App.Common.search, systemImage: "exclamationmark.triangle", message: Text(NativeStrings.Search.failed))
        } else if status != .searching, status != .hits {
          EmptyState(Strings.App.Common.search, systemImage: "magnifyingglass", message: Text(Strings.App.Bots.noMatches(query: query)))
        }
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
/// lifted to the top of their folder or of the list, folders as sections of their own.
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
  /// The same rows as the list draws them: runs of loose chats and folders, the archive apart.
  var sections: ChatListSections<ChatListRow>

  init(session: GatewaySession, query: String) {
    let list = session.chatList
    let arrangement = session.arrangement.arrangement
    // A secure prompt waiting (a password, a sudo, a vault) counts as needing input too.
    // The name this person gave a bot leads the row (unless they asked for the handle first), the
    // other name is drawn beside it (or not at all, with "Hide profile name"), and the search finds
    // a bot by either.
    let named = list.rows.mapValues { row -> ChatListRow in
      let names = session.botNames(row.bot.name)
      var named = row
      named.bot.displayName = names.primary
      named.secondaryName = names.secondary
      return named
    }
    let rows = ChatListFormat.filtered(list.names, rows: named, query: query)
      .map { SessionChatList.marked($0, secureInput: session.secureInput) }

    searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    all = arrangement.ordered(rows) { $0.bot.name }
    sections = arrangement.sections(rows) { $0.bot.name }
    shown = sections.visible
    archived = sections.archived
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
