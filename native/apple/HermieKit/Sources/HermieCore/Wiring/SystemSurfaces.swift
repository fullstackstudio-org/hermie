import Foundation
import HermieShared
import HermieStore
import HermieTranscript

/// The sentences the system surfaces write by themselves, already in the reader's language. Built
/// in HermieUI from the catalogues.
public struct SurfaceCopy: Sendable {
  /// What the share sheet says while sending, after sending and when it queued.
  public var shareTargets: ShareTargets.Copy
  public var intentFailures: IntentQueueFailures
  /// "Ask" ran out of time with the turn still going; the argument is the bot's name.
  public var stillWorking: @Sendable (String) -> String
  /// The bot a Shortcut named is not on the live gateway; the argument is the bot's name.
  public var botNotHere: @Sendable (String) -> String
  /// The prompt did not reach the gateway; the argument is the gateway's error.
  public var notSent: @Sendable (String) -> String
  /// The bot was still busy with an earlier turn and the prompt is still queued in the app; it goes
  /// out when that turn ends. The argument is the bot's name.
  public var queued: @Sendable (String) -> String
  /// The queued prompt was taken back out of the queue in the app before it went out.
  public var withdrawn: String

  public init(
    shareTargets: ShareTargets.Copy,
    intentFailures: IntentQueueFailures,
    stillWorking: @escaping @Sendable (String) -> String,
    botNotHere: @escaping @Sendable (String) -> String,
    notSent: @escaping @Sendable (String) -> String,
    queued: @escaping @Sendable (String) -> String,
    withdrawn: String
  ) {
    self.shareTargets = shareTargets
    self.intentFailures = intentFailures
    self.stillWorking = stillWorking
    self.botNotHere = botNotHere
    self.notSent = notSent
    self.queued = queued
    self.withdrawn = withdrawn
  }
}

/**
 The app's half of the share sheet, the widgets, Spotlight and the Shortcuts, against the live
 session (ADR-0023, ADR-0026: the extensions hold no sign-in; they read the App Group and hand work
 back through it).

 - **Writing.** `publish` turns the live session's chat list into the widget snapshot, the share
   sheet's targets and the Spotlight rows, previews left out while the app lock is configured.
 - **Draining.** `drain` hands the share outbox and the Shortcuts queue to the live session, for
   that session's own gateway only. The drainers themselves refuse to run while
   `SystemSurfaceLock` says locked, which `LiveWiring` keeps locked until the app lock is open and
   the gateway's session is up.
 - **Purging.** A gateway signed out of or removed takes its queued items, its snapshot, its
   targets and its Spotlight rows with it.

 What the app does not send itself: a share with files (the app has no upload path yet; the share
 extension's direct send uploads, and what it left stays queued), a share that names no bot or that
 was already handed to the gateway once (both need the person, in a sheet that is a later task).
 */
@MainActor
public final class SystemSurfaces {
  public let container: AppGroupContainer
  public let outbox: any ShareOutboxDrainer
  public let intents: any IntentQueueDrainer
  public let widgets: WidgetSnapshotWriter
  public let targets: ShareTargetsWriter
  public let spotlight: BotSpotlightIndex?
  /// The conversation titles and the message text in Spotlight (`ChatSpotlightPolicy`).
  public let chatSpotlight: ChatSpotlightIndexer?
  public let copy: SurfaceCopy

  /// How long "Ask" polls for the reply between looks.
  var replyPoll: Duration = .milliseconds(200)
  /// How long "Send to" waits for a prompt parked behind a running turn to go out, at most.
  var parkedSendWait: Duration = .seconds(10)
  /// An answer is written this long before the Shortcut's own budget runs out, so it is still read.
  static let answerMargin: Duration = .milliseconds(1500)

  public init(
    container: AppGroupContainer,
    copy: SurfaceCopy,
    widgets: WidgetSnapshotWriter? = nil,
    spotlight: BotSpotlightIndex? = nil,
    chatSpotlight: ChatSpotlightIndexer? = nil,
    isLocked: @escaping @Sendable () -> Bool = { SystemSurfaceLock.isLocked }
  ) {
    self.container = container
    self.copy = copy
    self.chatSpotlight = chatSpotlight
    self.outbox = AppGroupShareOutbox(container: container, isLocked: isLocked)
    self.intents = AppGroupIntentQueue(container: container, isLocked: isLocked)
    self.widgets = widgets ?? WidgetSnapshotWriter(container: container, reloadTimelines: {})
    self.targets = ShareTargetsWriter(container: container)
    self.spotlight = spotlight
  }

  /// The real App Group container, `WidgetCenter` and Spotlight; nil without the App Group.
  public static func live(copy: SurfaceCopy) -> SystemSurfaces? {
    guard let writer = WidgetSnapshotWriter.live() else {
      return nil
    }

    return SystemSurfaces(
      container: writer.container, copy: copy, widgets: writer, spotlight: BotSpotlightIndex(),
      chatSpotlight: ChatSpotlightIndexer(index: .live()))
  }

  // MARK: Writing

  /// Write what the widgets, the share sheet and Spotlight read, from the live chat list.
  public func publish(session: GatewaySession, gatewayKey: String, hidePreviews: Bool, now: Date = Date()) {
    let rows = Self.ordered(session.chatList)
    let ready = session.status.phase == .ready
    let snapshot = Self.snapshot(rows: rows, gatewayKey: gatewayKey, gatewayReady: ready, now: now)

    widgets.write(snapshot, hidePreviews: hidePreviews)
    widgets.pruneAvatars(keeping: rows.map(\.bot.name))
    targets.write(Self.targets(rows: rows, gatewayKey: gatewayKey, copy: copy.shareTargets, now: now))
    spotlight?.replace(with: snapshot.bots, gatewayKey: gatewayKey, hidePreviews: hidePreviews)
  }

  /**
   Keep the system's search in line with the live gateway's chats: the titles of each bot's other
   conversations always, and the text of the bots' chats only where `ChatSpotlightPolicy` allows it
   (never while the app lock hides previews, nor while the chat cache is off). It does little when asked
   often (`ChatSpotlightIndexer`), and one run at a time: a call that arrives while one is running asks
   for one more when it ends, with the newest policy.

   - Parameter force: the gateway's sessions changed, so read the conversations again now.
   */
  public func indexChats(
    session: GatewaySession, gatewayKey: String, hidePreviews: Bool, transcriptCache: Bool, force: Bool = false
  ) async {
    guard let chatSpotlight, session.status.phase == .ready else {
      return
    }

    wantedChatIndex = ChatIndexRequest(
      hidePreviews: hidePreviews, transcriptCache: transcriptCache, force: (wantedChatIndex?.force ?? false) || force)

    guard !indexingChats else {
      return
    }

    indexingChats = true
    defer { indexingChats = false }

    while let request = wantedChatIndex {
      wantedChatIndex = nil

      await chatSpotlight.refresh(
        gatewayKey: gatewayKey,
        source: session.spotlightSource(),
        policy: ChatSpotlightPolicy.resolve(hidePreviews: request.hidePreviews, transcriptCache: request.transcriptCache),
        force: request.force)
    }
  }

  /// The chat list's rows, most recently active first.
  static func ordered(_ list: ChatListModel) -> [ChatListRow] {
    list.names.compactMap { list.rows[$0] }.sorted { $0.lastMessageAt > $1.lastMessageAt }
  }

  /// The widget snapshot for these rows (no folders: the native list has no arrangement yet).
  static func snapshot(rows: [ChatListRow], gatewayKey: String, gatewayReady: Bool, now: Date) -> WidgetSnapshot {
    let bots = rows.map { row in
      WidgetSnapshot.Bot(
        name: row.bot.name,
        displayName: row.bot.displayName,
        initials: initials(row.bot.displayName.isEmpty ? row.bot.name : row.bot.displayName),
        colour: defaultColour,
        presence: row.presence(gatewayReady: gatewayReady).state.rawValue,
        lastLine: row.preview?.text ?? "",
        lastAt: row.lastMessageAt,
        unread: row.unreadCount,
        needsInput: row.needsInput
      )
    }

    return WidgetSnapshot(
      generatedAt: (now.timeIntervalSince1970 * 1000).rounded(.down),
      gatewayKey: Identifiers.isGatewayKey(gatewayKey) ? gatewayKey : nil,
      bots: bots,
      folders: []
    )
  }

  /// The share sheet's targets: each bot's DURABLE canonical session, never a runtime id.
  static func targets(rows: [ChatListRow], gatewayKey: String, copy: ShareTargets.Copy, now: Date) -> ShareTargets {
    let targets = rows.compactMap { row -> ShareTargets.Target? in
      guard let session = row.bot.canonical?.id, !session.isEmpty else {
        return nil
      }

      return ShareTargets.Target(bot: row.bot.name, session: session)
    }

    return ShareTargets(
      generatedAt: now.timeIntervalSince1970.rounded(.down),
      gatewayKey: Identifiers.isGatewayKey(gatewayKey) ? gatewayKey : nil,
      copy: copy,
      targets: targets
    )
  }

  /// The app's default accent (`tokens.ts`), until the per-chat colour is read from ui_meta.
  static let defaultColour = "#1668E3"

  /// Up to two letters: the first of the first two words, upper case.
  static func initials(_ name: String) -> String {
    let words = name.split { $0.isWhitespace || $0 == "-" || $0 == "_" }.prefix(2)

    return words.compactMap(\.first).map { String($0).uppercased() }.joined()
  }

  // MARK: Draining

  /**
   Hand the share outbox and the Shortcuts queue to `session`, for its own gateway (`gatewayKey`)
   only: what is queued for another configured gateway waits for that gateway's session. Nothing
   happens while the surfaces are locked; the drainers check that themselves. Answers whether a
   share was too new to take from the share extension yet, so another drain should follow once
   `AppGroupShareOutbox.leaseGrace` is over.
   */
  @discardableResult
  public func drain(session: GatewaySession, gatewayKey: String, known: Set<String>) async -> Bool {
    let scope = GatewayScope(active: gatewayKey, known: known)

    let outcomes = await outbox.drain(gateways: scope, now: Date()) { @Sendable share in
      await self.deliver(share, session: session, scope: scope)
    }

    await intents.drain(now: Date(), gateways: scope, failures: copy.intentFailures) { @Sendable intent in
      await self.answer(intent, session: session, scope: scope)
    }

    return outcomes.values.contains(.settling)
  }

  /// One share through the session: only one the app can send alone (see the type's notes), and
  /// only one recorded for the session's own gateway (`scope.active`).
  func deliver(_ share: PendingShare, session: GatewaySession, scope: GatewayScope) async -> ShareDrainDecision {
    guard scope.route(share.gatewayKey) == .deliver, share.claim == nil, let bot = share.bot,
      Identifiers.isBotName(bot), share.items.allSatisfy(\.isWords), session.status.phase == .ready
    else {
      return .keep
    }

    let text = share.messageText

    guard !text.isEmpty else {
      return .discard
    }

    guard await attach(bot, session: session) else {
      return .keep
    }

    do {
      try await session.store.send(bot, text: text)
      return .delivered
    } catch {
      return .keep
    }
  }

  /**
   One Shortcut request through the session, for the session's own gateway (`scope.active`) only.
   Left pending (`later`) while the socket is not up; the intent keeps polling, and the drain after
   the next `ready` answers it.

   "Send to" answers once the gateway took the prompt. "Ask" waits for the reply to ITS prompt, and
   a prompt parked behind a turn that was already running waits for that turn first; both waits run
   outside the drain (`started`), so one Shortcut never holds up the next. A "Send to" whose prompt
   is still parked when its wait is over says so instead of claiming it was sent.
   */
  func answer(_ intent: PendingIntent, session: GatewaySession, scope: GatewayScope) async -> IntentHandling {
    guard scope.route(intent.gatewayKey) == .deliver, session.status.phase == .ready else {
      return .later
    }

    guard Identifiers.isBotName(intent.bot), await session.roster.bot(named: intent.bot) != nil else {
      return .answered(.failure(id: intent.id, copy.botNotHere(intent.bot)))
    }

    guard await attach(intent.bot, session: session) else {
      return .later
    }

    let receipt: SendReceipt

    do {
      receipt = try await session.store.sendFollowing(intent.bot, text: intent.text)
    } catch {
      return .answered(.failure(id: intent.id, copy.notSent(ChatResolver.describe(error))))
    }

    if intent.kind == .send, case .submitted = receipt {
      return .answered(.reply(id: intent.id, ""))
    }

    let deadline = Self.deadline(of: intent)
    let intents = self.intents

    Task {
      let result = await self.finish(intent, receipt, session: session, deadline: deadline)

      intents.complete(id: intent.id, with: result)
    }

    return .started
  }

  /// When an answer to `intent` has to be written by: its budget from when it was asked, less the
  /// margin that leaves the Shortcut time to read it.
  static func deadline(of intent: PendingIntent, now: Date = Date()) -> ContinuousClock.Instant {
    let asked = Date(timeIntervalSince1970: intent.createdAt / 1000)
    let elapsed = Duration.milliseconds(Int64(max(0, now.timeIntervalSince(asked) * 1000)))

    return ContinuousClock.now + PendingIntent.budget - elapsed - answerMargin
  }

  /// The answer to a request whose prompt was parked, or an "Ask" waiting for its reply.
  func finish(_ intent: PendingIntent, _ receipt: SendReceipt, session: GatewaySession, deadline: ContinuousClock.Instant)
    async -> IntentResult
  {
    var anchor: String?

    switch receipt {
    case .submitted(let itemID):
      anchor = itemID
    case .parked(let queueID):
      let wait = intent.kind == .send ? min(deadline, ContinuousClock.now + parkedSendWait) : deadline
      let fate = await waitUntilSubmitted(queueID, session: session, until: wait)

      await session.store.unfollow(queueID)

      switch fate {
      case .submitted(let itemID):
        guard intent.kind == .ask else {
          return .reply(id: intent.id, "")
        }

        anchor = itemID
      case .failed(let reason):
        return .failure(id: intent.id, copy.notSent(reason))
      case .withdrawn:
        return .failure(id: intent.id, copy.withdrawn)
      case .parked, nil:
        return .failure(id: intent.id, copy.queued(intent.bot))
      }
    }

    // The reply to OUR prompt: what came after the item it was painted as, never a turn that was
    // already running when it was asked.
    let reply = await waitForReply(intent.bot, after: anchor, session: session, until: deadline)

    return reply.map { .reply(id: intent.id, $0) } ?? .failure(id: intent.id, copy.stillWorking(intent.bot))
  }

  /// What became of a parked prompt, once it is no longer parked or `deadline` passed.
  func waitUntilSubmitted(_ queueID: String, session: GatewaySession, until deadline: ContinuousClock.Instant) async
    -> FollowedPrompt?
  {
    while true {
      let fate = await session.store.followedPrompt(queueID)

      guard fate == .parked, ContinuousClock.now < deadline else {
        return fate
      }

      try? await Task.sleep(for: replyPoll)
    }
  }

  /// The bot's reply after `anchor`, once its turn is over; nil when `deadline` passes or the turn
  /// ended without one (an interruption, a tool-only turn).
  func waitForReply(_ bot: String, after anchor: String?, session: GatewaySession, until deadline: ContinuousClock.Instant)
    async -> String?
  {
    while ContinuousClock.now < deadline {
      let state = await session.store.replyState(bot, after: anchor)

      if !state.turnActive {
        return state.reply
      }

      try? await Task.sleep(for: replyPoll)
    }

    return nil
  }

  /// Open the bot's chat when it is not attached yet. False when it cannot be.
  private func attach(_ bot: String, session: GatewaySession) async -> Bool {
    if await session.store.runtimeSessionID(bot) != nil {
      return true
    }

    try? await session.open(bot)

    return await session.store.runtimeSessionID(bot) != nil
  }

  // MARK: Purging

  /// A gateway was signed out of or removed: everything queued or written for it goes.
  public func purge(gatewayKey: String) {
    outbox.purge(gatewayKey: gatewayKey)
    intents.purge(gatewayKey: gatewayKey)
    widgets.purge(gatewayKey: gatewayKey)
    targets.purge(gatewayKey: gatewayKey)
    spotlight?.purge(gatewayKey: gatewayKey)
    chatSpotlight?.purge(gatewayKey: gatewayKey)
    // What a run in flight was about to write for it must not outlive the purge.
    wantedChatIndex = nil
  }

  private struct ChatIndexRequest {
    var hidePreviews: Bool
    var transcriptCache: Bool
    var force: Bool
  }

  private var wantedChatIndex: ChatIndexRequest?
  private var indexingChats = false
}

extension PendingShare.Item {
  /// A URL or text, which the app can send without uploading anything.
  var isWords: Bool {
    if case .words = self {
      return true
    }

    return false
  }
}

extension TranscriptStore {
  /// Whether the chat's turn is still running, and the bot's last finished reply after `anchor`
  /// (anywhere when `anchor` is not in the transcript any more).
  func replyState(_ key: String, after anchor: String?) -> (reply: String?, turnActive: Bool) {
    guard let state = chats[key]?.state else {
      return (nil, false)
    }

    let order = state.order
    let start = anchor.flatMap { order.firstIndex(of: $0) }.map { $0 + 1 } ?? order.startIndex
    let reply = order[start...].reversed().lazy.compactMap { state.items[$0]?.asAssistant }.first {
      !$0.streaming && !$0.text.isEmpty
    }

    return (reply?.text, state.turn.active)
  }
}
