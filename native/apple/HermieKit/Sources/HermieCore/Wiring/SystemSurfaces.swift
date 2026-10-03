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

  public init(
    shareTargets: ShareTargets.Copy,
    intentFailures: IntentQueueFailures,
    stillWorking: @escaping @Sendable (String) -> String,
    botNotHere: @escaping @Sendable (String) -> String,
    notSent: @escaping @Sendable (String) -> String
  ) {
    self.shareTargets = shareTargets
    self.intentFailures = intentFailures
    self.stillWorking = stillWorking
    self.botNotHere = botNotHere
    self.notSent = notSent
  }
}

/**
 The app's half of the share sheet, the widgets, Spotlight and the Shortcuts, against the live
 session (ADR-0023, ADR-0026: the extensions hold no sign-in; they read the App Group and hand work
 back through it).

 - **Writing.** `publish` turns the live session's chat list into the widget snapshot, the share
   sheet's targets and the Spotlight rows, previews left out while the app lock is configured.
 - **Draining.** `drain` hands the share outbox and the Shortcuts queue to the live session. The
   drainers themselves refuse to run while `SystemSurfaceLock` says locked, which `LiveWiring`
   keeps locked until the app lock is open and the gateway's session is up.
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
  public let copy: SurfaceCopy

  /// How long "Ask" polls for the reply between looks.
  var replyPoll: Duration = .milliseconds(200)

  public init(
    container: AppGroupContainer,
    copy: SurfaceCopy,
    widgets: WidgetSnapshotWriter? = nil,
    spotlight: BotSpotlightIndex? = nil,
    isLocked: @escaping @Sendable () -> Bool = { SystemSurfaceLock.isLocked }
  ) {
    self.container = container
    self.copy = copy
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

    return SystemSurfaces(container: writer.container, copy: copy, widgets: writer, spotlight: BotSpotlightIndex())
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

  /// Hand the share outbox and the Shortcuts queue to the live session. Nothing happens while the
  /// surfaces are locked; the drainers check that themselves.
  public func drain(session: GatewaySession, scope: GatewayScope) async {
    await outbox.drain(gateways: scope, now: Date()) { @Sendable share in
      await self.deliver(share, session: session)
    }

    await intents.drain(now: Date(), gateways: scope, failures: copy.intentFailures) { @Sendable intent in
      await self.answer(intent, session: session)
    }
  }

  /// One share through the session: only one the app can send alone (see the type's notes).
  func deliver(_ share: PendingShare, session: GatewaySession) async -> ShareDrainDecision {
    guard share.claim == nil, let bot = share.bot, Identifiers.isBotName(bot),
      share.items.allSatisfy(\.isWords), session.status.phase == .ready
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
   One Shortcut request through the session. Nil (left pending) while the socket is not up; the
   intent keeps polling, and the drain after the next `ready` answers it. "Send to" answers once
   the gateway took the prompt; "Ask" waits for the reply until the request's budget runs out.
   */
  func answer(_ intent: PendingIntent, session: GatewaySession) async -> IntentResult? {
    guard session.status.phase == .ready else {
      return nil
    }

    guard Identifiers.isBotName(intent.bot), await session.roster.bot(named: intent.bot) != nil else {
      return .failure(id: intent.id, copy.botNotHere(intent.bot))
    }

    guard await attach(intent.bot, session: session) else {
      return nil
    }

    let anchor = await session.store.lastItemID(intent.bot)
    let painted: String?

    do {
      painted = try await session.store.send(intent.bot, text: intent.text)
    } catch {
      return .failure(id: intent.id, copy.notSent(ChatResolver.describe(error)))
    }

    guard intent.kind == .ask else {
      return .reply(id: intent.id, "")
    }

    let budget = PendingIntent.budget - .milliseconds(Int64(max(0, Date().timeIntervalSince1970 * 1000 - intent.createdAt)))
    let reply = await waitForReply(intent.bot, after: painted ?? anchor, session: session, within: budget)

    return reply.map { .reply(id: intent.id, $0) } ?? .failure(id: intent.id, copy.stillWorking(intent.bot))
  }

  /// The bot's reply after `anchor`, once its turn is over; nil when the budget runs out or the turn
  /// ended without one (an interruption, a tool-only turn).
  func waitForReply(_ bot: String, after anchor: String?, session: GatewaySession, within budget: Duration) async
    -> String?
  {
    let deadline = ContinuousClock.now + budget

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
  }
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
  /// The newest item of a chat, or nil.
  func lastItemID(_ key: String) -> String? {
    chats[key]?.state.order.last
  }

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
