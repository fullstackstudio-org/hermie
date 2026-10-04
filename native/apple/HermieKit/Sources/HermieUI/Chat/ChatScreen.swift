import HermieCore
import HermieTranscript
import QuickLook
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
   secure prompts through its `SecureInputModel` (`secureInput`), and forms, file requests and draft
   reviews through its `InteractiveModel` (`interactiveRequests`). `actions` builds the rest of the
   rows' actions once per opened chat; without it the chat has its own: Retry on a failed reply
   sends its prompt again, and an attachment opens in Quick Look (`ChatFeed`). Opening another bot's
   chat goes through the router.
 - On the Mac the requests come up in the chat's own pane, not as a window-modal sheet, so the
   sidebar and the other chats stay usable while one waits (`ChatSheetHost`). Leaving the chat puts
   its request away as Later does; the chat says so when it is opened again (`WaitingRequestsBanner`).

 It reads the session from `LiveGateway` in the environment; a chat on a gateway that is not live,
 or not signed in, says so instead.
 */
public struct ChatScreen<Composer: View>: View {
  let chat: ChatRef
  let actions: (@MainActor (ChatModel) -> TranscriptItemActions)?
  let composer: (ChatComposerContext) -> Composer

  @Environment(LiveGateway.self) private var live: LiveGateway?

  /// - Parameter actions: the rows' actions; nil for the chat's own (Retry, opening attachments).
  public init(
    chat: ChatRef,
    actions: (@MainActor (ChatModel) -> TranscriptItemActions)? = nil,
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
  public init(chat: ChatRef, actions: (@MainActor (ChatModel) -> TranscriptItemActions)? = nil) {
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
        .padding(.horizontal, ChatSpacing.edgeMargin)
      SecureInputNoticeView(model: context.secureInput)
        .padding(.horizontal, ChatSpacing.edgeMargin)
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
      .padding(.horizontal, ChatSpacing.edgeMargin)
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
  /// The rows' actions; nil for the chat's own (`ChatFeed`'s Retry and attachment opening).
  let actions: (@MainActor (ChatModel) -> TranscriptItemActions)?
  let composer: (ChatComposerContext) -> Composer

  /// The screen's feed, for as long as this screen's identity lives (`ChatFeedOwner`): not dropped on
  /// `onDisappear`, which SwiftUI also sends to a chat that stays on screen.
  @State private var owner = ChatFeedOwner<ChatFeed>()
  @Environment(\.scenePhase) private var scenePhase
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(LiveGateway.self) private var live: LiveGateway?
  /// Where the device's voice settings are; none in a preview.
  @Environment(AppLaunch.self) private var launch: AppLaunch?
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  /// Reads nothing that changes with a streamed delta (the title and the composer's name read the
  /// chat list in views of their own), so a delta re-evaluates `ChatTranscript` and nothing here.
  var body: some View {
    let feed = owner.feed
    // A page pushed on the chat or a sheet over it: the feed runs on, but marks nothing read.
    let covered = router?.covers(chat) ?? false

    ZStack {
      if let feed {
        ChatTranscript(feed: feed)
          .environment(\.transcriptExpansion, feed.expansion)
          .modifier(OwnAuthor(session: session))
          .modifier(OwnChatFollow(session: session, bot: chat.bot))
          .modifier(ChatRequestSheets(feed: feed))
          .safeAreaInset(edge: .top, spacing: 0) {
            ChatBanners(feed: feed)
          }
          .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerSlot(chat: chat, session: session, feed: feed, composer: composer)
          }
          // Files and pictures dropped anywhere on the chat (the transcript, the empty state, the
          // composer) go to the composer's tray; not while a request has the composer (HERM-251).
          .attachmentDropTarget(tray: feed.composer.tray) { feed.requestUp || feed.composer.held }
          .toolbar {
            // While YOLO mode is on, a capsule says so for as long as it is: the chat never asks.
            if feed.yolo {
              ToolbarItem(placement: .primaryAction) {
                YoloBadge(feed: feed)
              }
            }

            // The context window is nearly full: a small ring, until there is room again.
            if ContextRing.shows(feed.sessionOptions.contextUsage), let usage = feed.sessionOptions.contextUsage {
              ToolbarItem(placement: .primaryAction) {
                ContextRing(usage: usage)
              }
            }

            ToolbarItem(placement: .primaryAction) {
              VerbosityMenu(feed: feed, chat: chat)
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
    // The chat asks for no minimum size of its own. Its banners and the notices over the composer
    // wrap their text (`fixedSize(vertical:)`), and SwiftUI also measures them at the narrowest
    // width it probes for a window's minimum, a width at which every few letters take a line: a
    // long notice (the gateway's "This chat is open in another Hermes window/terminal …") made the
    // chat's minimum thousands of points tall. On the Mac that minimum is the window's, so the split
    // view was laid out taller than the window and centred in it: the chat list ran off the top
    // (blank) and the composer off the bottom. The transcript scrolls; the chat fits the window.
    .frame(minWidth: 0, minHeight: 0)
    #if os(macOS)
      // The requests come up over this chat, not over the window: the sidebar stays usable while one
      // waits (`ChatSheetHost`; a sheet would block the whole window).
      .chatSheetHost(covered: feed?.requestUp ?? false)
    #endif
    // Turning YOLO mode on asks first; turning it off does not.
    .alert(
      NativeStrings.Chat.Yolo.confirmTitle,
      isPresented: Binding(
        get: { owner.feed?.confirmingYolo ?? false }, set: { owner.feed?.confirmingYolo = $0 })
    ) {
      Button(NativeStrings.Chat.Yolo.confirmAction) { owner.feed?.confirmYolo() }
        .accessibilityIdentifier("hermie.chat.yolo.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.Chat.Yolo.confirmMessage)
    }
    // The model list, the alert about an expensive model, and the save sheet of an export.
    .modifier(ChatOptionsPresentations(owner: owner))
    // An attachment a message names, opened from its chip.
    .quickLookPreview(
      Binding(get: { owner.feed?.attachmentPreview }, set: { owner.feed?.attachmentPreview = $0 })
    )
    // The words of a message, to select in part (Select text in its menu).
    .selectTextSheet(
      Binding(get: { owner.feed?.selectTextRequest }, set: { owner.feed?.selectTextRequest = $0 }),
      copyAll: { owner.feed?.itemActions.copy($0) ?? TranscriptItemActions.copyToPasteboard($0) }
    )
    // The pictures of the messages, opened full screen from their thumbnails.
    .imageGalleryHost(owner.feed?.itemActions.images)
    .modifier(ChatTitle(session: session, chat: chat, feed: feed, diagnostics: diagnostics))
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .onAppear {
      let router = self.router
      let gatewayId = chat.gatewayId
      let base = actions
      let chat = self.chat
      let session = self.session
      let active = scenePhase == .active
      let voice = launch?.voice

      owner.appeared {
        let next = ChatFeed(chat: chat, session: session, standardActions: base == nil) { model in
          var built = base?(model) ?? .none
          // A bot-to-bot row opens the other bot's chat, on the same gateway.
          built.openBotChat = { handle in
            router?.openChat(ChatRef(gatewayId: gatewayId, bot: handle))
          }
          return built
        }
        // Branch from here opens the new conversation, to be read, over the chat.
        next.openConversation = { conversation in
          router?.showConversation(
            chat, id: conversation.id, resolvedID: conversation.resolvedID, title: conversation.title)
        }
        if let voice {
          next.attachVoice(settings: voice)
        }
        next.sceneChanged(active: active)
        next.coverChanged(covered: covered)
        return next
      }
      ChatLifecycleLog.note("screen #\(owner.screen) appeared: \(chat.bot), feed f\(owner.feed?.tag ?? 0)")
      takeFind(router?.chatFind)
    }
    .onDisappear {
      owner.disappeared()
      ChatLifecycleLog.note("screen #\(owner.screen) disappeared: \(chat.bot), feed f\(owner.feed?.tag ?? 0) kept")
    }
    .onChange(of: scenePhase) { _, phase in
      owner.feed?.sceneChanged(active: phase == .active)
    }
    .onChange(of: covered) { _, covered in
      owner.feed?.coverChanged(covered: covered)
    }
    // A search hit followed to this chat: before the screen exists (taken on appear) or while it is open.
    .onChange(of: router?.chatFind) { _, request in
      takeFind(request)
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

  /// A message search hit asked this chat to show the row its words are in; the feed looks for it and
  /// tells the router when it is done.
  private func takeFind(_ request: ChatFindRequest?) {
    guard let request, request.chat == chat, let feed = owner.feed else {
      return
    }

    let router = self.router
    feed.find(request) { id in router?.settleFind(id) }
  }

  /// The text the title's long press copies.
  private func diagnostics() -> String {
    ChatDiagnostics.report(chat: chat, session: session, screen: owner.screen, owner: owner, live: live)
  }
}

/// The chat's request sheets, one at a time, approvals and secure prompts first (`ChatSheetOrder`):
/// they wait until a form on screen has stepped aside, and a form does not come up over them.
struct ChatRequestSheets: ViewModifier {
  let feed: ChatFeed

  func body(content: Content) -> some View {
    content
      .answeringRequests(with: feed.requests, actions: feed.itemActions, hold: feed.sheets.holdForInteractive)
      .secureInput(feed.secureInput, hold: feed.sheets.holdForInteractive)
      .interactiveRequests(feed.interactive, blocked: feed.sheets.interactiveBlocked)
  }
}

/// The transcript itself: the only part of the screen that changes with every streamed delta.
struct ChatTranscript: View {
  let feed: ChatFeed
  /// The reader's text size for conversations (Settings › Appearance); none without a launch (a preview).
  @Environment(AppLaunch.self) private var launch: AppLaunch?

  /// None between rows: each row carries the room above itself (`TranscriptItemView.Gaps`), so a
  /// row that draws nothing takes none.
  static let rowSpacing: CGFloat = 0
  /// The bubbles' distance from the window's edges; the list itself runs edge to edge.
  static let margin: CGFloat = ChatSpacing.edgeMargin

  var body: some View {
    // Each row carries the room above itself (`ChatSpacing`): small inside a group of bubbles, large
    // between groups, none for a row that draws nothing.
    TranscriptList(feed.rows, state: feed.listState, spacing: Self.rowSpacing) { row in
      TranscriptItemView(row: row, gaps: .chat)
        .padding(.horizontal, Self.margin)
        .modifier(FoundRowMark(active: row.flash))
    } overlay: { state in
      JumpToLatestPill(state: state, newCount: feed.newCount)
    }
    .environment(\.transcriptTailInset, ChatSpacing.transcriptTail)
    .transcriptTextSize(launch?.settings.synced.textSize ?? .standard)
    .overlay {
      ChatEmptyOverlay(feed: feed)
    }
    .overlay(alignment: .top) {
      VStack(spacing: 0) {
        OlderHistoryIndicator(feed: feed)
        ChatFindNotice(feed: feed)
      }
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
      PasskeyNoticesView(model: feed.session.passkeys)
      WaitingRequestsBanner(feed: feed)
      ChatActionNotices(feed: feed)

      if let error = feed.openError {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(.orange)
            .accessibilityHidden(true)
          Text(Strings.App.Chat.failed(message: error))
            .font(.callout)
            .lineLimit(ComposerView.noticeLineLimit)
            .help(Strings.App.Chat.failed(message: error))
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
          Button(Strings.App.Chat.retry) { feed.openIfNeeded(force: true) }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("hermie.chat.retryOpen")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: .rect(cornerRadius: 12))
        .padding(.horizontal, ChatSpacing.edgeMargin)
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
    VStack(spacing: 0) {
      // While a delegation runs: how many agents work, and the way to steer or stop them.
      SubagentsBar(chat: chat, model: feed.model)

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
    // On every platform: under a request's sheet (iPhone, iPad) or pane (Mac) the field is off and
    // gives up the keyboard, so nothing typed for the request lands in the draft or goes out.
    .disabled(feed.requestUp)
  }
}

/// Who the reader is on this gateway, for the user bubbles: only when the gateway stamps every row
/// with its author (`ownAuthorID`); without it every user turn is the reader's. The people's pictures
/// come with it, from the same gateway.
struct OwnAuthor: ViewModifier {
  let session: GatewaySession

  func body(content: Content) -> some View {
    content
      .environment(\.transcriptOwnAuthorID, session.ownAuthorID)
      .environment(\.transcriptPeoplePictures, session.people)
  }
}

/// The bot's picture and name, and under the name what the bot is doing now, else its presence
/// (`subtitleFor`), as the chat's title. It is also the way into the bot's settings: a tap on it opens
/// them, as a tap on the contact at the top of a conversation does.
///
/// A long press on it copies the screen's diagnostics (`ChatDiagnostics`), a hidden affordance for
/// a report from the owner's phone; VoiceOver offers it as the title's action.
struct ChatTitle: ViewModifier {
  let session: GatewaySession
  let chat: ChatRef
  let feed: ChatFeed?
  let diagnostics: () -> String

  @Environment(AppRouter.self) private var router: AppRouter?
  @State private var copied = 0
  /// "Copied" stands in the subtitle's place for a moment after a copy.
  @State private var confirming = false

  /// How long the press lasts before it copies: long enough that nobody does it by accident.
  static let pressDuration = 1.5

  func body(content: Content) -> some View {
    let title = session.chatName(chat.bot)
    let subtitle = Self.text(activity: feed?.activity ?? .idle, presence: presence)

    content
      // The window's and the back button's title, and the app switcher's; the bar draws our view in
      // its place.
      .navigationTitle(title)
      .toolbar {
        ToolbarItem(placement: .principal) {
          ChatTitleView(
            title: title,
            subtitle: confirming ? NativeStrings.Chat.diagnosticsCopied : subtitle,
            avatar: session.chatList.rows[chat.bot]?.avatar,
            accent: session.arrangement.accent(chat.bot),
            presence: presence.state,
            opensSettings: router != nil
          )
          .onTapGesture { router?.showBotSettings(chat) }
          .onLongPressGesture(minimumDuration: Self.pressDuration) { copy() }
          .accessibilityAction(.default) { router?.showBotSettings(chat) }
          .accessibilityAction(named: NativeStrings.Chat.copyDiagnostics) { copy() }
          .sensoryFeedback(.success, trigger: copied)
          .task(id: copied) {
            guard copied > 0 else { return }
            confirming = true
            AccessibilityNotification.Announcement(NativeStrings.Chat.diagnosticsCopied).post()
            try? await Task.sleep(for: .seconds(1.5))
            confirming = false
          }
          #if DEBUG && os(iOS)
            .onReceive(NotificationCenter.default.publisher(for: SwitchDrill.copyDiagnostics)) { _ in copy() }
          #endif
        }
      }
      #if os(macOS)
        // The toolbar's own title would say the name a second time beside ours.
        .toolbar(removing: .title)
      #endif
  }

  private func copy() {
    ChatDiagnostics.copy(diagnostics())
    copied += 1
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
    case .tool(let name): Strings.App.Chat.Subtitle.running(tool: ToolLabel.activityName(name))
    case .waiting: Strings.App.Chat.Subtitle.waiting
    case .delegating: Strings.App.Chat.Subtitle.delegating
    case .idle: ChatListFormat.presenceLabel(presence)
    }
  }
}

/// The picture with its presence bead, the name and the subtitle, as the chat's title draws them: in
/// a view of our own so a tap and a long press can reach them.
struct ChatTitleView: View {
  let title: String
  let subtitle: String
  var avatar: String?
  var accent: BotAccent = .default
  var presence: PresenceState?
  /// Whether a tap does something (there is a router to open the settings on).
  var opensSettings = true

  var body: some View {
    layout
    .lineLimit(1)
    // The bar's own title stops growing here too.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    // Capped as the bar's title is, so at the accessibility sizes a press shows it large.
    .accessibilityShowsLargeContentViewer()
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(opensSettings ? NativeStrings.Chat.titleOpensSettings(name: title) : title)
    .accessibilityValue(subtitle)
    .accessibilityHint(opensSettings ? NativeStrings.Chat.titleOpensSettingsHint : "")
    .accessibilityAddTraits(opensSettings ? .isButton : .isHeader)
    #if os(macOS)
      .help(NativeStrings.BotSettings.open)
    #endif
    .accessibilityIdentifier("hermie.chat.title")
  }

  #if os(iOS)
    /// Centred between the back button and the trailing buttons: the item takes the whole slot the bar
    /// gives it, the name and the status are centred in a column of their own, and a blank the
    /// picture's size on the other side keeps that column's middle on the slot's middle. A longer
    /// status truncates inside the column; it never moves the name.
    private var layout: some View {
      HStack(spacing: Layout.spacing) {
        BotAvatar(name: title, avatar: avatar, size: Self.avatarSide, presence: presence, accent: accent)
        textColumn(alignment: .center)
        Color.clear.frame(width: Self.avatarSide, height: 1)
      }
      .frame(maxWidth: .infinity)
    }
  #else
    /// The glass capsule the Mac's toolbar draws round the item: room left and right of the content,
    /// and a width it does not shrink below, so a short name does not make a cramped pill.
    private var layout: some View {
      HStack(spacing: Layout.spacing) {
        BotAvatar(name: title, avatar: avatar, size: Self.avatarSide, presence: presence, accent: accent)
        textColumn(alignment: .leading)
      }
      .padding(.leading, Layout.pillLeadingPadding)
      .padding(.trailing, Layout.pillTrailingPadding)
      .frame(
        minWidth: Layout.pillMinWidth, idealWidth: Layout.pillIdealWidth, maxWidth: Layout.pillMaxWidth,
        alignment: .leading
      )
    }
  #endif

  private func textColumn(alignment: HorizontalAlignment) -> some View {
    VStack(alignment: alignment, spacing: 0) {
      Text(title)
        #if os(iOS)
          .font(.subheadline.weight(.semibold))
        #else
          .font(.headline)
        #endif
        .lineLimit(1)
        .truncationMode(.tail)
      Text(subtitle)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.tail)
    }
    .multilineTextAlignment(alignment == .center ? .center : .leading)
  }

  /// The picture's side: the bar is about this tall at its smallest.
  static let avatarSide: CGFloat = 30

  /// The numbers the title's layout is built from.
  enum Layout {
    static let spacing: CGFloat = 8
    /// The Mac's pill: the space between the capsule's edge and the picture, and between the text and
    /// the capsule's other edge (the text is what touched it).
    static let pillLeadingPadding: CGFloat = 10
    static let pillTrailingPadding: CGFloat = 20
    /// The pill is at least this wide, is this wide when the text allows, and is never wider than this.
    static let pillMinWidth: CGFloat = 220
    static let pillIdealWidth: CGFloat = 260
    static let pillMaxWidth: CGFloat = 420
  }
}

/// The small capsule that says this chat skips approval requests. A tap opens a menu with the one way
/// out: turning it off, which needs no confirmation.
struct YoloBadge: View {
  let feed: ChatFeed

  var body: some View {
    Menu {
      Button {
        feed.requestYolo(false)
      } label: {
        Label(NativeStrings.Chat.Yolo.turnOff, systemImage: "bolt.slash")
      }
      .accessibilityIdentifier("hermie.chat.yolo.turnOff")
    } label: {
      Text(NativeStrings.Chat.Yolo.badge)
        .font(.caption2.weight(.heavy))
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.orange, in: .capsule)
    }
    .menuIndicator(.hidden)
    .accessibilityLabel(NativeStrings.Chat.Yolo.badgeLabel)
    .accessibilityHint(NativeStrings.Chat.Yolo.badgeHint)
    .accessibilityIdentifier("hermie.chat.yolo")
  }
}

/// The chat's options menu: the bot's conversations, and verbosity and the two switches per chat
/// screen (`setVisibility`), and, while the chat is attached, YOLO mode, fast mode, reasoning effort,
/// the model, the context meter and the export.
struct VerbosityMenu: View {
  let feed: ChatFeed
  let chat: ChatRef

  private var model: ChatModel { feed.model }

  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    let options = model.visibility

    Menu {
      if let router {
        Button {
          router.showConversations(chat)
        } label: {
          Label(Strings.Chat.Sessions.conversations, systemImage: "bubble.left.and.bubble.right")
        }
        .accessibilityIdentifier("hermie.chat.conversations")

        // Shared Bot Chat or my chat, and a new chat of my own: only where the gateway named the reader.
        Divider()
      }

      OwnChatMenuItems(feed: feed)

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

      // Whether this chat reads its replies aloud, and a way to stop a read that is going.
      ChatVoiceOptionItems(feed: feed)

      // What needs a session to ask: these are not offered while the chat is not attached.
      if feed.optionsAvailable {
        Divider()

        // This session only. Turning it on asks first (`ChatFeed.requestYolo`).
        Toggle(isOn: Binding(get: { feed.yolo }, set: { feed.requestYolo($0) })) {
          Label(Strings.Chat.Options.yolo, systemImage: "bolt.fill")
        }
        .accessibilityHint(Strings.Chat.Options.yoloHint)
        .accessibilityIdentifier("hermie.chat.options.yolo")

        // Fast mode, reasoning effort and the model for this session, the context meter, the export.
        ChatSessionOptionItems(feed: feed)
      }
    } label: {
      Label(Strings.Chat.Options.title, systemImage: "slider.horizontal.3")
    }
    .accessibilityIdentifier("hermie.chat.options")
  }
}
