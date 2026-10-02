import HermieCore
import HermieTranscript
import SwiftUI

/// What the composer slot is handed: the chat, its models and the session it belongs to.
public struct ChatComposerContext {
  public let chat: ChatRef
  public let model: ChatModel
  public let session: GatewaySession
  /// The chat's composer model (draft, send, stop, queue), one per open chat screen.
  public let composer: ComposerModel
  /// The chat's approvals and clarifies, for a notice above the composer.
  public let requests: RequestsModel
  /// The chat's secure prompts, for a notice above the composer.
  public let secureInput: SecureInputModel
  /// The bot's display name, for "Message {bot}".
  public let botName: String
}

/**
 One chat (the `chat` seam): the transcript of a bot's chat on the live gateway, its title and
 presence, the connection banner and the gateway's notices, the composer, and the answers to what
 the bot asks (approval and clarify cards and their sheet, secure prompts, connector
 authorisations).

 ```swift
 ChatScreen(chat: ref)                                  // the standard composer
 ChatScreen(chat: ref, actions: { model in base }) { context in MyComposer(context: context) }
 ```

 - The composer is placed under the transcript with `safeAreaInset`, so the list scrolls behind it
   and keeps its last row above it. The default is `StandardComposer` (`ComposerView` with the
   request and secure-prompt notices above it).
 - Approval and clarify answers go through the chat's `RequestsModel` (`answeringRequests`), and
   secure prompts through its `SecureInputModel` (`secureInput`). `actions` builds the rest of the
   rows' actions once per opened chat; opening another bot's chat goes through the router.

 It reads the session from `LiveGateway` in the environment; a chat on a gateway that is not live,
 or not signed in, says so instead.
 */
public struct ChatScreen<Composer: View>: View {
  let chat: ChatRef
  let actions: @MainActor (ChatModel) -> TranscriptItemActions
  let composer: (ChatComposerContext) -> Composer

  @Environment(LiveGateway.self) private var live: LiveGateway?

  public init(
    chat: ChatRef,
    actions: @escaping @MainActor (ChatModel) -> TranscriptItemActions = { _ in .none },
    @ViewBuilder composer: @escaping (ChatComposerContext) -> Composer
  ) {
    self.chat = chat
    self.actions = actions
    self.composer = composer
  }

  public var body: some View {
    Group {
      if let live, live.gatewayID == chat.gatewayId, let session = live.session {
        ChatSessionView(chat: chat, session: session, actions: actions, composer: composer)
          .id(ObjectIdentifier(session))
      } else {
        ChatUnavailableView(chat: chat, phase: live?.gatewayID == chat.gatewayId ? live?.phase : nil)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.chat")
    .accessibilityValue(chat.bot)
  }
}

extension ChatScreen where Composer == StandardComposer {
  /// The chat with the standard composer.
  public init(chat: ChatRef, actions: @escaping @MainActor (ChatModel) -> TranscriptItemActions = { _ in .none }) {
    self.init(chat: chat, actions: actions) { StandardComposer(context: $0) }
  }
}

/// The composer, with the notices of an approval, a clarify or a secure prompt waiting above it.
public struct StandardComposer: View {
  let context: ChatComposerContext

  public init(context: ChatComposerContext) {
    self.context = context
  }

  public var body: some View {
    VStack(spacing: 0) {
      RequestNoticeView(requests: context.requests)
        .padding(.horizontal, 12)
      SecureInputNoticeView(model: context.secureInput)
        .padding(.horizontal, 12)
      ComposerView(model: context.composer)
    }
  }
}

/// Where the composer goes while there is no session to send through: a disabled field.
public struct ComposerPlaceholder: View {
  let botName: String

  public init(botName: String) {
    self.botName = botName
  }

  public var body: some View {
    TextField(Strings.Chat.Composer.messageTo(bot: botName), text: .constant(""), axis: .vertical)
      .textFieldStyle(.plain)
      .lineLimit(1...4)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(.fill.tertiary, in: .rect(cornerRadius: 20))
      .disabled(true)
      .padding(.horizontal)
      .padding(.vertical, 8)
      .background(.bar)
      .accessibilityIdentifier("hermie.composer.placeholder")
  }
}

/// A chat whose gateway has no running session: signed out, failed, or still connecting.
struct ChatUnavailableView: View {
  let chat: ChatRef
  let phase: LiveGatewayPhase?

  var body: some View {
    Group {
      switch phase {
      case .signedOut?:
        EmptyState(chat.bot, systemImage: "person.badge.key", message: Text(NativeStrings.ChatList.signedOut))
      case .failed(let message)?:
        EmptyState(chat.bot, systemImage: "exclamationmark.triangle", message: Text(Strings.App.Chat.failed(message: message)))
      default:
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.App.Chat.Connection.connecting)
            .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      ComposerPlaceholder(botName: chat.bot)
    }
    .navigationTitle(chat.bot)
  }
}

/// The chat over a running session.
struct ChatSessionView<Composer: View>: View {
  let chat: ChatRef
  let session: GatewaySession
  let actions: @MainActor (ChatModel) -> TranscriptItemActions
  let composer: (ChatComposerContext) -> Composer

  @State private var feed: ChatFeed?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(AppRouter.self) private var router: AppRouter?
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  /// Reads nothing that changes with a streamed delta (the title and the composer's name read the
  /// chat list in views of their own), so a delta re-evaluates `ChatTranscript` and nothing here.
  var body: some View {
    ZStack {
      if let feed {
        ChatTranscript(feed: feed)
          .environment(\.transcriptExpansion, feed.expansion)
          .modifier(OwnAuthor(session: session))
          .answeringRequests(with: feed.requests, actions: feed.itemActions)
          .secureInput(feed.secureInput)
          .safeAreaInset(edge: .top, spacing: 0) {
            ChatBanners(feed: feed)
          }
          .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerSlot(chat: chat, session: session, feed: feed, composer: composer)
          }
          .toolbar {
            ToolbarItem(placement: .primaryAction) {
              VerbosityMenu(model: feed.model)
            }
          }
          #if DEBUG
            .overlay(alignment: .topLeading) {
              ChatTestProbe(feed: feed)
            }
          #endif
      } else {
        Color.clear
      }
    }
    .modifier(ChatTitle(session: session, chat: chat, feed: feed))
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .onAppear {
      guard feed == nil else { return }
      let router = self.router
      let gatewayId = chat.gatewayId
      let base = actions
      let next = ChatFeed(chat: chat, session: session) { model in
        var built = base(model)
        // A bot-to-bot row opens the other bot's chat, on the same gateway.
        built.openBotChat = { handle in
          router?.openChat(ChatRef(gatewayId: gatewayId, bot: handle))
        }
        return built
      }
      next.start()
      next.sceneChanged(active: scenePhase == .active)
      feed = next
    }
    .onDisappear {
      feed?.stop()
      feed = nil
    }
    .onChange(of: scenePhase) { _, phase in
      feed?.sceneChanged(active: phase == .active)
    }
    .onKeyPress(.escape) {
      // Back to the list where the chat was pushed over it (iPhone, a narrow iPad window).
      #if os(iOS)
        if sizeClass == .compact, let router {
          router.closeChat()
          return .handled
        }
      #endif
      return .ignored
    }
  }
}

/// The transcript itself: the only part of the screen that changes with every streamed delta.
struct ChatTranscript: View {
  let feed: ChatFeed

  var body: some View {
    TranscriptList(feed.rows, state: feed.listState) { row in
      TranscriptItemView(row: row)
        .padding(.horizontal, 16)
    } overlay: { state in
      JumpToLatestPill(state: state, newCount: feed.newCount)
    }
    .overlay {
      ChatEmptyOverlay(feed: feed)
    }
    .overlay(alignment: .top) {
      OlderHistoryIndicator(feed: feed)
    }
  }
}

/// Loading, or nothing said yet, over an empty transcript.
struct ChatEmptyOverlay: View {
  let feed: ChatFeed

  var body: some View {
    if feed.rows.isEmpty {
      if feed.loaded, feed.hydration == .live {
        EmptyState(Strings.Chat.Transcript.empty, systemImage: "bubble.left.and.bubble.right", message: Text(Strings.App.Chat.empty))
      } else if feed.openError == nil {
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.App.Chat.hydrating)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.chat.loading")
      }
    }
  }
}

/// "Loading earlier…" while a page of history is on its way.
struct OlderHistoryIndicator: View {
  let feed: ChatFeed

  var body: some View {
    if feed.loadingOlder {
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
}

/// The connection banner and, when the chat could not be opened, why, with "Try again".
struct ChatBanners: View {
  let feed: ChatFeed

  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    VStack(spacing: 0) {
      ConnectionBanner(
        status: feed.session.status,
        retry: { Task { await feed.session.retryNow() } },
        signIn: { router?.present(.signIn(gatewayId: feed.chat.gatewayId)) }
      )

      GatewayNoticesView(model: feed.session.notices, chat: feed.name)
      ConnectionRequestCard(model: feed.session.connectionRequests, chat: feed.name)

      if let error = feed.openError {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(.orange)
            .accessibilityHidden(true)
          Text(Strings.App.Chat.failed(message: error))
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
          Button(Strings.App.Chat.retry) { feed.openIfNeeded(force: true) }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("hermie.chat.retryOpen")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: .rect(cornerRadius: 12))
        .padding(.horizontal)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
      } else if feed.hydration == .cached, feed.session.status.phase != .ready, feed.loaded {
        Text(Strings.App.Chat.offlineCopy)
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 4)
      }
    }
  }
}

/// The composer the caller supplies, handed the chat's models and the bot's display name.
struct ComposerSlot<Composer: View>: View {
  let chat: ChatRef
  let session: GatewaySession
  let feed: ChatFeed
  let composer: (ChatComposerContext) -> Composer

  var body: some View {
    let name = session.chatList.rows[chat.bot]?.bot.displayName ?? chat.bot
    composer(
      ChatComposerContext(
        chat: chat,
        model: feed.model,
        session: session,
        composer: feed.composer,
        requests: feed.requests,
        secureInput: feed.secureInput,
        botName: name
      )
    )
  }
}

/// Who the reader is on this gateway, for the user bubbles: only when the gateway stamps every row
/// with its author (`ownAuthorID`); without it every user turn is the reader's.
struct OwnAuthor: ViewModifier {
  let session: GatewaySession

  func body(content: Content) -> some View {
    content.environment(\.transcriptOwnAuthorID, session.ownAuthorID)
  }
}

/// The bot's name, and under it what the bot is doing now, else its presence (`subtitleFor`).
struct ChatTitle: ViewModifier {
  let session: GatewaySession
  let chat: ChatRef
  let feed: ChatFeed?

  func body(content: Content) -> some View {
    content
      .navigationTitle(session.chatList.rows[chat.bot]?.bot.displayName ?? chat.bot)
      .navigationSubtitle(Self.text(activity: feed?.activity ?? .idle, presence: presence))
  }

  private var presence: Presence {
    session.chatList.rows[chat.bot]?.presence(gatewayReady: session.status.phase == .ready)
      ?? Presence.of(gatewayReady: false, sessionAttached: false, working: false, needsInput: false)
  }

  static func text(activity: TurnActivity, presence: Presence) -> String {
    switch activity {
    case .working: Strings.App.Chat.Subtitle.working
    case .thinking: Strings.App.Chat.Subtitle.thinking
    case .typing: Strings.App.Chat.Subtitle.typing
    case .tool(let name): Strings.App.Chat.Subtitle.running(tool: name)
    case .waiting: Strings.App.Chat.Subtitle.waiting
    case .delegating: Strings.App.Chat.Subtitle.delegating
    case .idle: ChatListFormat.presenceLabel(presence)
    }
  }
}

/// Verbosity and the two switches, per chat screen (`setVisibility`).
struct VerbosityMenu: View {
  let model: ChatModel

  var body: some View {
    let options = model.visibility

    Menu {
      Picker(Strings.Chat.Options.verbosity, selection: Binding(
        get: { options.level },
        set: { model.setVisibility(VisibilityOptions(level: $0, showBotToBot: options.showBotToBot, showThinking: options.showThinking)) }
      )) {
        Text(Strings.Chat.Options.VerbosityOptions.quiet).tag(Verbosity.quiet)
        Text(Strings.Chat.Options.VerbosityOptions.normal).tag(Verbosity.normal)
        Text(Strings.Chat.Options.VerbosityOptions.verbose).tag(Verbosity.verbose)
      }

      Toggle(Strings.Chat.Options.showThinking, isOn: Binding(
        get: { options.showThinking },
        set: { model.setVisibility(VisibilityOptions(level: options.level, showBotToBot: options.showBotToBot, showThinking: $0)) }
      ))

      Toggle(Strings.Chat.Options.showBotToBot, isOn: Binding(
        get: { options.showBotToBot },
        set: { model.setVisibility(VisibilityOptions(level: options.level, showBotToBot: $0, showThinking: options.showThinking)) }
      ))
    } label: {
      Label(Strings.Chat.Options.title, systemImage: "slider.horizontal.3")
    }
    .accessibilityIdentifier("hermie.chat.options")
  }
}
