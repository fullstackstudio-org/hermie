import HermieCore
import SwiftUI

/**
 One bot's Conversations page, pushed on its chat (`DetailRoute.sessions`): the conversation it is in
 now, its branches and its past conversations, with what can be done with them. The web client's
 `ConversationsPage`, on the native shell.

 ADR-0007 gives a bot exactly ONE chat and this page does not change that. It admits that the one
 chat has a past, and gives the reader somewhere to see it:

 - **Current conversation** is the bot's chat. It is drawn and named and has no actions at all
   (`Conversation.actions` answers an empty list for it), so no menu here can offer Delete on the one
   chat that may never be deleted. A tap on it goes back to the chat.
 - **Branches** and **Past conversations** open in a read-only viewer (`ConversationViewerScreen`)
   and carry the same actions: Rename (inline, in the row), Make this the Bot Chat (at once, the swap
   rolls back on failure), and Delete (which asks first: there is no undo).
 - **New conversation** puts the current one away for everybody on the gateway, so it asks first;
   afterwards the page goes back to the chat, where the new conversation starts.

 Every action ends the same way: it says what happened, and the list is read again. The list is also
 read when the connection returns, when the gateway says its sessions changed, and on a pull.

 Titles, previews and a refusal's reason are the gateway's and the bots' text: plain text, bounded,
 drawn as characters.

 It reads the session from `LiveGateway` in the environment.
 */
public struct ConversationsScreen: View {
  let chat: ChatRef

  @Environment(LiveGateway.self) private var live: LiveGateway?

  public init(chat: ChatRef) {
    self.chat = chat
  }

  public var body: some View {
    Group {
      if let live, live.gatewayID == chat.gatewayId, let session = live.session {
        ConversationsContent(chat: chat, session: session)
          .id(ObjectIdentifier(session))
      } else {
        EmptyState(
          Strings.Chat.Sessions.conversations,
          systemImage: "bubble.left.and.bubble.right",
          message: Text(Strings.Chat.Sessions.loadFailed)
        )
      }
    }
    .navigationTitle(Strings.Chat.Sessions.conversations)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.conversations")
  }
}

/// The page over a running session.
struct ConversationsContent: View {
  let chat: ChatRef
  let session: GatewaySession

  @State private var model: ConversationsModel
  @Environment(AppRouter.self) private var router: AppRouter?

  init(chat: ChatRef, session: GatewaySession) {
    self.chat = chat
    self.session = session
    _model = State(initialValue: session.conversations(for: chat.bot))
  }

  var body: some View {
    let connected = session.status.phase == .ready
    let canAct = connected && !model.busy

    List {
      noticeSection

      Section {
        Button {
          model.beginNew()
        } label: {
          Label(NativeStrings.Conversations.new, systemImage: "square.and.pencil")
        }
        .disabled(!canAct)
        .accessibilityIdentifier("hermie.conversations.new")

        // Another chat of the reader's own, beside the shared one: only where the gateway named them.
        if session.ownChatsAvailable {
          Button {
            router?.present(.newOwnChat(chat))
          } label: {
            Label(Strings.Chat.Conversations.newChat, systemImage: "person.crop.circle.badge.plus")
          }
          .disabled(!canAct)
          .accessibilityIdentifier("hermie.conversations.newOwnChat")
        }
      }

      switch model.phase {
      case .loading:
        Section {
          if connected {
            HStack(spacing: 10) {
              ProgressView()
              Text(Strings.Chat.Sessions.loading)
            }
            .accessibilityElement(children: .combine)
          } else {
            Label(Strings.Chat.Sessions.loadFailed, systemImage: "wifi.slash")
          }
        }
      case .failed(let message):
        Section {
          Text(verbatim: Strings.Chat.Sessions.loadFailed)
          Text(verbatim: message)
            .font(.callout)
            .foregroundStyle(.secondary)
          Button(Strings.App.Common.retry) { Task { await model.load() } }
            .accessibilityIdentifier("hermie.conversations.retry")
        }
      case .ready(let groups):
        groupSections(groups, canAct: canAct)
      }
    }
    .task(id: connected) {
      if connected {
        await model.load()
      }
    }
    .onChange(of: session.sessionsChangedCount) {
      if connected {
        Task { await model.load() }
      }
    }
    .onChange(of: model.startedNew) {
      // The new conversation starts in the chat.
      router?.showChat()
    }
    .onChange(of: model.switched) {
      // The chat of the reader's own that was picked is the chat now.
      router?.showChat()
    }
    .onChange(of: model.notice) { _, notice in
      if let notice {
        AccessibilityNotification.Announcement(ConversationsText.notice(notice)).post()
      }
    }
    .refreshable { await model.load() }
    .confirmationDialog(
      Strings.Chat.Sessions.deleteTitle,
      isPresented: Binding(
        get: { model.deleting != nil },
        set: { if !$0, model.deleting != nil { model.cancel() } }
      ),
      titleVisibility: .visible,
      presenting: model.deleting
    ) { conversation in
      Button(Strings.Chat.Sessions.deleteConfirm, role: .destructive) {
        Task { await model.delete(conversation) }
      }
      Button(Strings.Chat.Sessions.cancel, role: .cancel) {}
    } message: { conversation in
      Text(verbatim: Strings.Chat.Sessions.deleteBody(title: conversation.displayTitle))
    }
    .confirmationDialog(
      NativeStrings.Conversations.new,
      isPresented: Binding(
        get: { model.mode == .confirmNew },
        set: { if !$0, model.mode == .confirmNew { model.cancel() } }
      ),
      titleVisibility: .visible
    ) {
      Button(NativeStrings.Conversations.newConfirm) {
        Task { await model.startNew() }
      }
      Button(Strings.Chat.Sessions.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.Conversations.newConfirmBody)
    }
  }

  /// Said once what happened: polite for an outcome, red for a refusal.
  @ViewBuilder private var noticeSection: some View {
    if let notice = model.notice {
      Section {
        switch notice {
        case .failed:
          Label(ConversationsText.notice(notice), systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
            .accessibilityIdentifier("hermie.conversations.failed")
        default:
          Label(ConversationsText.notice(notice), systemImage: "checkmark.circle")
            .accessibilityIdentifier("hermie.conversations.done")
        }
      }
    }
  }

  @ViewBuilder private func groupSections(_ groups: ConversationGroups, canAct: Bool) -> some View {
    if let canonical = groups.canonical {
      Section(Strings.Chat.Sessions.canonical) {
        row(canonical, canAct: canAct)
      }
    }

    if session.ownChatsAvailable {
      Section(Strings.Chat.Conversations.yourChats) {
        if groups.mine.isEmpty {
          Text(Strings.Chat.Conversations.yoursEmpty)
            .foregroundStyle(.secondary)
        } else {
          ForEach(groups.mine) { row($0, canAct: canAct) }
        }
      }
    }

    if !groups.branches.isEmpty {
      Section(Strings.Chat.Sessions.branches) {
        ForEach(groups.branches) { row($0, canAct: canAct) }
      }
    }

    Section(Strings.Chat.Sessions.past) {
      if groups.past.isEmpty {
        Text(Strings.Chat.Sessions.pastEmpty)
          .foregroundStyle(.secondary)
      } else {
        ForEach(groups.past) { row($0, canAct: canAct) }
      }
    }
  }

  private func row(_ conversation: Conversation, canAct: Bool) -> some View {
    ConversationRow(
      conversation: conversation,
      model: model,
      canAct: canAct,
      isCurrent: isCurrent(conversation),
      open: {
        if conversation.kind == .canonical {
          router?.showChat()
        } else {
          router?.showConversation(
            chat, id: conversation.id, resolvedID: conversation.resolvedID, title: conversation.title)
        }
      }
    )
  }
}

extension ConversationsContent {
  /// The conversation the bot's chat is on: the Bot Chat, or the own chat the reader's memory names.
  func isCurrent(_ conversation: Conversation) -> Bool {
    switch session.chatTarget(chat.bot) {
    case .shared: conversation.kind == .canonical
    case .chat(let id): conversation.kind == .mine && (conversation.id == id || conversation.resolvedID == id)
    case .legacy: conversation.kind == .mine && conversation.title == session.ownChatLead
    }
  }
}

/// One conversation, and whatever it is allowed to do.
///
/// The actions are `conversation.actions` and nothing else: there is no `kind == .canonical` test in
/// this view, which is what makes the ADR-0007 guard structural rather than a line somebody could
/// delete while tidying.
struct ConversationRow: View {
  let conversation: Conversation
  let model: ConversationsModel
  let canAct: Bool
  /// The chat the bot is on now: marked, and with no menu of its own.
  var isCurrent = false
  let open: () -> Void

  var body: some View {
    if case .rename(let id, let draft)? = model.mode, id == conversation.id {
      renameForm(draft: draft)
    } else {
      HStack(alignment: .center, spacing: 8) {
        Button(action: open) {
          content
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.conversations.row.\(conversation.id)")

        if conversation.kind == .canonical || isCurrent {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }

        if conversation.kind != .canonical, !conversation.actions.isEmpty {
          Menu {
            actions
          } label: {
            Image(systemName: "ellipsis.circle")
              .imageScale(.large)
          }
          .menuStyle(.borderlessButton)
          .fixedSize()
          .accessibilityLabel(NativeStrings.Conversations.actionsFor(title: conversation.displayTitle))
        }
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        if conversation.allows(.delete) {
          Button(role: .destructive) {
            model.beginDelete(conversation)
          } label: {
            Label(Strings.Chat.Sessions.delete, systemImage: "trash")
          }
          .disabled(!canAct)
        }

        if conversation.allows(.rename) {
          Button {
            model.beginRename(conversation)
          } label: {
            Label(Strings.Chat.Sessions.rename, systemImage: "pencil")
          }
          .tint(.orange)
          .disabled(!canAct)
        }
      }
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        if conversation.allows(.useHere), !isCurrent {
          Button {
            Task { await model.useHere(conversation) }
          } label: {
            Label(NativeStrings.Conversations.useHere, systemImage: "bubble.left.and.text.bubble.right")
          }
          .tint(.accentColor)
          .disabled(!canAct)
        }

        if conversation.allows(.adopt) {
          Button {
            Task { await model.adopt(conversation) }
          } label: {
            Label(Strings.Chat.Sessions.adopt, systemImage: "arrow.uturn.backward.circle")
          }
          .tint(.accentColor)
          .disabled(!canAct)
        }
      }
      .contextMenu {
        actions
      }
    }
  }

  /// The menu's items, for the row's menu button and its context menu: one list.
  @ViewBuilder private var actions: some View {
    if conversation.allows(.open) {
      Button(Strings.Chat.Sessions.open, systemImage: "text.bubble", action: open)
    }

    if conversation.allows(.rename) {
      Button(Strings.Chat.Sessions.rename, systemImage: "pencil") {
        model.beginRename(conversation)
      }
      .disabled(!canAct)
    }

    if conversation.allows(.useHere), !isCurrent {
      Button(NativeStrings.Conversations.useHere, systemImage: "bubble.left.and.text.bubble.right") {
        Task { await model.useHere(conversation) }
      }
      .disabled(!canAct)
    }

    if conversation.allows(.adopt) {
      Button(Strings.Chat.Sessions.adopt, systemImage: "arrow.uturn.backward.circle") {
        Task { await model.adopt(conversation) }
      }
      .disabled(!canAct)
    }

    if conversation.allows(.delete) {
      Button(Strings.Chat.Sessions.delete, systemImage: "trash", role: .destructive) {
        model.beginDelete(conversation)
      }
      .disabled(!canAct)
    }
  }

  /// Title, the first words, and how long and how recent it is.
  private var content: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(verbatim: conversation.displayTitle)
        .font(.headline)
        .lineLimit(2)

      let preview = conversation.displayPreview

      if !preview.isEmpty {
        Text(verbatim: preview)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }

      Text(verbatim: ConversationsText.meta(conversation))
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  /// The rename field, in the row: Return commits, Escape and Cancel put it away.
  private func renameForm(draft: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(Strings.Chat.Sessions.renameTitle)
        .font(.caption)
        .foregroundStyle(.secondary)

      TextField(
        Strings.Chat.Sessions.renameTitle,
        text: Binding(get: { draft }, set: { model.setDraft($0) })
      )
      .textFieldStyle(.roundedBorder)
      .autocorrectionDisabled()
      .onSubmit { Task { await model.commitRename() } }
      #if os(macOS)
        .onExitCommand { model.cancel() }
      #endif
      .accessibilityIdentifier("hermie.conversations.renameField")

      HStack {
        Button(Strings.Chat.Sessions.rename) { Task { await model.commitRename() } }
          .buttonStyle(.borderedProminent)
          .disabled(model.busy)
        Button(Strings.Chat.Sessions.cancel) { model.cancel() }
          .buttonStyle(.bordered)
          .disabled(model.busy)
      }
    }
    .padding(.vertical, 4)
  }
}

/// The words of the page, as plain functions so they are tested without a view.
enum ConversationsText {
  /// "12 messages · Mon": the count, and when it began where the gateway said.
  static func meta(_ conversation: Conversation, now: Date = .now, calendar: Calendar = .current) -> String {
    let count = Strings.Chat.Sessions.messages(count: conversation.messageCount)
    let time = ChatListFormat.listTime(conversation.lastActive, now: now, calendar: calendar)

    return time.isEmpty ? count : "\(count) · \(time)"
  }

  /// What the page says about the last thing it did.
  static func notice(_ notice: ConversationsModel.Notice) -> String {
    switch notice {
    case .renamed: NativeStrings.Conversations.renamed
    case .deleted: NativeStrings.Conversations.deleted
    case .adopted: NativeStrings.Conversations.adopted
    case .usingHere: NativeStrings.Conversations.usingHere
    case .failed(let message, let busy):
      busy ? Strings.Chat.Sessions.busy : NativeStrings.Conversations.actionFailed(message: message)
    }
  }
}

extension ConversationsModel {
  /// The conversation a delete question is open about.
  var deleting: Conversation? {
    if case .confirmDelete? = mode { subject } else { nil }
  }
}
