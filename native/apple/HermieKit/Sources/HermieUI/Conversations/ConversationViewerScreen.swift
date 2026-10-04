import HermieCore
import HermieTranscript
import SwiftUI

/**
 One of a bot's other conversations, read and not answered (`DetailRoute.conversation`): a past
 conversation or a branch, opened from the Conversations page. The web client's viewer at
 `#/chat/<bot>/s/<id>`.

 It draws the same rows the chat draws, from a snapshot read off the gateway
 (`ConversationViewerModel`): nothing is live, no composer is offered, no read mark moves, and the
 bot's own chat is not touched. A banner says so, with the way back to the chat. Older pages are read
 as the reader scrolls up.

 It reads the session from `LiveGateway` in the environment.
 */
struct ConversationViewerScreen: View {
  let chat: ChatRef
  let id: String
  let resolvedID: String
  let title: String

  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    let conversation = Conversation(id: id, resolvedID: resolvedID, title: title, kind: .past)

    Group {
      if let live, live.gatewayID == chat.gatewayId, let session = live.session {
        ConversationViewerContent(chat: chat, conversation: conversation, session: session)
          .id(ObjectIdentifier(session))
      } else {
        EmptyState(
          conversation.displayTitle,
          systemImage: "bubble.left.and.bubble.right",
          message: Text(Strings.Chat.Sessions.loadFailed)
        )
      }
    }
    .navigationTitle(conversation.displayTitle)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.conversationViewer")
  }
}

/// The viewer over a running session.
struct ConversationViewerContent: View {
  let chat: ChatRef
  let conversation: Conversation
  let session: GatewaySession

  @State private var model: ConversationViewerModel
  @State private var rows = TranscriptListItems<TranscriptRow>()
  @State private var listState = TranscriptListState()
  @State private var expansion = TranscriptExpansion()
  @State private var pipeline = ChatRowPipeline()
  @Environment(AppRouter.self) private var router: AppRouter?

  init(chat: ChatRef, conversation: Conversation, session: GatewaySession) {
    self.chat = chat
    self.conversation = conversation
    self.session = session
    _model = State(initialValue: session.conversationViewer(bot: chat.bot, conversation: conversation))
  }

  var body: some View {
    let connected = session.status.phase == .ready

    VStack(spacing: 0) {
      banner

      ZStack {
        TranscriptList(rows, state: listState, spacing: ChatTranscript.rowSpacing) { row in
          TranscriptItemView(row: row, gaps: .chat)
            .padding(.horizontal, ChatTranscript.margin)
        }
        .environment(\.transcriptExpansion, expansion)
        .modifier(OwnAuthor(session: session))
        .overlay(alignment: .top) {
          if model.loadingOlder {
            loadingEarlier
          }
        }

        state(connected: connected)
      }
    }
    .task(id: connected) {
      if connected, model.phase != .ready {
        await model.load()
      }
    }
    .task(id: model.revision) {
      guard model.phase == .ready else {
        return
      }

      rows = await pipeline.rows(for: model.items, historyComplete: !model.canLoadOlder).rows
    }
    .onAppear {
      listState.onNearTop = { Task { await model.loadOlder() } }
    }
    .onDisappear {
      listState.onNearTop = nil
    }
  }

  /// "You are reading an earlier conversation": it cannot be answered, and here is the way back.
  private var banner: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(NativeStrings.Conversations.readOnly)
        .font(.callout)

      HStack(spacing: 16) {
        Button(NativeStrings.Conversations.backToChat) { router?.showChat() }
        Button(Strings.Chat.Sessions.conversations) { router?.pop() }
      }
      .buttonStyle(.borderless)
      .font(.callout)

      if let error = model.olderError {
        Text(verbatim: Strings.App.Chat.failed(message: error))
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, ChatSpacing.edgeMargin)
    .padding(.vertical, 8)
    .background(.bar)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.conversationViewer.banner")
  }

  /// Loading, why it failed, or that nothing was said: over the (empty) list.
  @ViewBuilder private func state(connected: Bool) -> some View {
    switch model.phase {
    case .loading:
      VStack(spacing: 12) {
        if connected {
          ProgressView()
          Text(Strings.App.Chat.hydrating)
            .foregroundStyle(.secondary)
        } else {
          Label(Strings.Chat.Sessions.loadFailed, systemImage: "wifi.slash")
        }
      }
      .accessibilityElement(children: .combine)
    case .failed(let message):
      VStack(spacing: 12) {
        Text(verbatim: Strings.App.Chat.failed(message: message))
          .multilineTextAlignment(.center)
        Button(Strings.App.Chat.retry) { Task { await model.load() } }
      }
      .padding()
    case .ready:
      if model.items.isEmpty {
        EmptyState(
          Strings.Chat.Transcript.empty,
          systemImage: "bubble.left.and.bubble.right",
          message: Text(NativeStrings.Conversations.noMessages)
        )
      }
    }
  }

  private var loadingEarlier: some View {
    HStack(spacing: 8) {
      ProgressView()
        .controlSize(.small)
      Text(Strings.Chat.Transcript.loadingEarlier)
        .font(.caption)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(.regularMaterial, in: .capsule)
    .padding(.top, 8)
    .accessibilityElement(children: .combine)
  }
}
