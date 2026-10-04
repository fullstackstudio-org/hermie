import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Observation

/// One bot's bead (`presence.ts`): four states and one precedence order, in one
/// place, so the chat list and the chat header agree.
public enum PresenceState: String, Sendable, Equatable {
  case offline
  case needsInput
  case working
  case online
}

public struct Presence: Sendable, Equatable {
  public var state: PresenceState
  /// When the bot was last heard from (unix seconds); only while offline, only when known.
  public var lastSeenAt: Double?

  /// `presenceOf`.
  public static func of(
    gatewayReady: Bool,
    sessionAttached: Bool,
    working: Bool,
    needsInput: Bool,
    lastActive: Double? = nil
  ) -> Presence {
    if !gatewayReady || !sessionAttached {
      if let lastActive, lastActive > 0 {
        return Presence(state: .offline, lastSeenAt: lastActive)
      }

      return Presence(state: .offline)
    }

    if needsInput {
      return Presence(state: .needsInput)
    }

    return Presence(state: working ? .working : .online)
  }
}

/// One row of the chat list: the bot and what its chat says about it.
public struct ChatListRow: Sendable, Equatable, Identifiable {
  public var bot: Bot
  /// The base64 avatar, when the bot has one and it has been fetched.
  public var avatar: String?
  /// The transcript's own preview when there is one, else the roster's line.
  public var preview: ChatPreview?
  /// Messages since the reader last looked, counted in the loaded transcript.
  public var unreadCount: Int
  /// The roster says the chat moved since the reader last looked (`isUnread`).
  public var unread: Bool
  public var needsInput: Bool
  /// `session.active_list` or the chat's own streaming turn says it is busy.
  public var working: Bool
  /// The chat's runtime session is bound.
  public var attached: Bool
  public var hydration: HydrationState
  public var lastMessageAt: Double

  public var id: String { bot.name }

  public init(
    bot: Bot,
    avatar: String? = nil,
    preview: ChatPreview? = nil,
    unreadCount: Int = 0,
    unread: Bool = false,
    needsInput: Bool = false,
    working: Bool = false,
    attached: Bool = false,
    hydration: HydrationState = .cold,
    lastMessageAt: Double = 0
  ) {
    self.bot = bot
    self.avatar = avatar
    self.preview = preview
    self.unreadCount = unreadCount
    self.unread = unread
    self.needsInput = needsInput
    self.working = working
    self.attached = attached
    self.hydration = hydration
    self.lastMessageAt = lastMessageAt
  }

  /// The bead, given whether the gateway socket is up.
  public func presence(gatewayReady: Bool) -> Presence {
    Presence.of(
      gatewayReady: gatewayReady,
      sessionAttached: attached || bot.canonical != nil,
      working: working,
      needsInput: needsInput,
      lastActive: bot.canonical?.lastActive
    )
  }
}

/// The chat list: one row per bot, recomputed only for the bots that changed.
/// Ordering is the list's own business (folders, drag order, recency).
@MainActor
@Observable
public final class ChatListModel {
  public private(set) var rows: [String: ChatListRow] = [:]
  /// The roster's order, for a list with no arrangement of its own.
  public private(set) var names: [String] = []
  public private(set) var loading = false
  public private(set) var rosterError: String?
  /// False while only the cached roster is painted.
  public private(set) var refreshed = false
  /// What the gateway's Hermie plugin offers (`memory.browse`, `memory.edit`, …), from the last roster read.
  public private(set) var pluginCapabilities: Set<String> = []

  @ObservationIgnored private var roster = BotRoster.Snapshot()
  @ObservationIgnored private var summaries: [String: ChatSummary] = [:]

  public init() {}

  /// A fresh roster: every row is rebuilt (the roster changes rarely).
  func apply(_ snapshot: BotRoster.Snapshot) {
    roster = snapshot
    loading = snapshot.loading
    rosterError = snapshot.error
    refreshed = snapshot.refreshed

    if pluginCapabilities != snapshot.pluginCapabilities {
      pluginCapabilities = snapshot.pluginCapabilities
    }

    let fresh = snapshot.bots.map(\.name)

    if names != fresh {
      names = fresh
    }

    var next: [String: ChatListRow] = [:]

    for bot in snapshot.bots {
      next[bot.name] = row(for: bot)
    }

    if next != rows {
      rows = next
    }
  }

  /// Changed chats only: the rows of the other bots are not touched.
  func apply(_ changed: [String: ChatSummary], removed: [String]) {
    for key in removed {
      summaries[key] = nil
    }

    for (key, summary) in changed {
      summaries[key] = summary
    }

    for key in Set(changed.keys).union(removed) {
      guard let bot = roster.bots.first(where: { $0.name == key }) else {
        continue
      }

      let row = row(for: bot)

      if rows[key] != row {
        rows[key] = row
      }
    }
  }

  private func row(for bot: Bot) -> ChatListRow {
    let summary = summaries[bot.name]
    let preview = summary?.preview ?? previewFromGatewayText(bot.canonical?.preview)

    return ChatListRow(
      bot: bot,
      avatar: roster.avatars[bot.name],
      preview: preview,
      unreadCount: summary?.unread ?? 0,
      unread: roster.isUnread(bot.name),
      needsInput: summary?.needsInput ?? false,
      working: roster.running.contains(bot.name) || (summary?.busy ?? false),
      attached: summary?.attached ?? false,
      hydration: summary?.hydration ?? .cold,
      lastMessageAt: max(summary?.lastMessageAt ?? 0, bot.canonical?.lastActive ?? 0)
    )
  }
}

/// One chat screen: the visible items at the reader's verbosity, whether the
/// bot is busy, the open cards, the queue, the draft, and the actions.
///
/// Thin on purpose: everything it shows was computed off the main actor and
/// arrives as one snapshot per frame; everything it does is a call into the
/// gateway session's store.
@MainActor
@Observable
public final class ChatModel {
  public let key: String
  public var draft = ""

  /// The chat as the last frame left it. Replaced whole, once per frame.
  ///
  /// Observed by hand, without the comparison the `@Observable` macro puts in
  /// a setter: `ChatSnapshot` is `Equatable`, so the generated setter would
  /// compare every visible item of the old snapshot with the new one, deeply,
  /// on the main actor, on every streamed delta. A fresh snapshot is a change
  /// by definition (`revision` moved), so it is published without looking.
  public var snapshot: ChatSnapshot? {
    access(keyPath: \.snapshot)
    return storedSnapshot
  }

  @ObservationIgnored private var storedSnapshot: ChatSnapshot?
  /// The reader's verbosity options (`setVisibility` re-projects the transcript).
  public private(set) var visibility: VisibilityOptions

  /// The last thing an action could not do, for a banner.
  public private(set) var lastError: String? {
    didSet {
      if lastError == nil { lastErrorKind = nil }
    }
  }
  /// What kind of failure `lastError` was, without its words (`ChatResolver.category`), for
  /// diagnostics.
  @ObservationIgnored public private(set) var lastErrorKind: String?
  /// A short word for a card whose answer did not go out, by request id: the
  /// socket that delivered the question is gone, and the card stays open until
  /// the gateway asks again after the reconnect. Gone once the card closes.
  public private(set) var cardNotices: [String: String] = [:]
  /// A Retry is on its way (`retryTurn`): a second press sends nothing.
  @ObservationIgnored var retrying = false
  /// A Branch from here is on its way (`branch(from:)`): a second press asks nothing.
  @ObservationIgnored var branching = false

  /// What a card says when its answer could not go out.
  public static let unsentAnswerNotice =
    "Not sent: the connection dropped. The question comes back when it reconnects; answer it then."

  @ObservationIgnored let store: TranscriptStore
  /// Hands an observation change to the store, in order (`GatewaySession`).
  @ObservationIgnored let observe: @MainActor (String, VisibilityOptions) -> Void

  init(
    key: String,
    store: TranscriptStore,
    visibility: VisibilityOptions,
    observe: @escaping @MainActor (String, VisibilityOptions) -> Void
  ) {
    self.key = key
    self.store = store
    self.visibility = visibility
    self.observe = observe
  }

  /// Whether the reader gave this chat a view of its own. Until then it follows the default.
  @ObservationIgnored public private(set) var hasOwnVisibility = false

  /// Show the transcript at other verbosity options; the next frame carries it. The chat has a view
  /// of its own from now on, and the default no longer moves it.
  public func setVisibility(_ options: VisibilityOptions) {
    hasOwnVisibility = true

    guard options != visibility else {
      return
    }

    visibility = options
    observe(key, options)
  }

  /// The default view changed: a chat that has none of its own shows it.
  func followDefault(_ options: VisibilityOptions) {
    guard !hasOwnVisibility, options != visibility else {
      return
    }

    visibility = options
    observe(key, options)
  }

  public var items: [VisibleItem] { snapshot?.items ?? [] }
  public var busy: Bool { snapshot?.busy ?? false }
  public var turnActive: Bool { snapshot?.turnActive ?? false }
  public var openRequests: [TranscriptItem] { snapshot?.openRequests ?? [] }
  public var queue: [QueuedMessage] { snapshot?.queue ?? [] }
  public var hydration: HydrationState { snapshot?.hydration ?? .cold }
  /// The gateway socket is `ready` (kept by the session).
  public internal(set) var connectionReady = false
  /// A deferred resume loading this chat's transcript on the gateway
  /// (`session.resume_progress`), kept by the session; `nil` when none was reported.
  public internal(set) var resumeProgress: ResumeProgress?
  /// The chat is bound to a runtime session and the socket is up.
  public var canSend: Bool { (snapshot?.attached ?? false) && connectionReady }

  /// An action failed: its words for the banner, its kind for diagnostics.
  func record(_ error: any Error) {
    lastError = ChatResolver.describe(error)
    lastErrorKind = ChatResolver.category(error)
  }

  func apply(_ snapshot: ChatSnapshot) {
    withMutation(keyPath: \.snapshot) {
      storedSnapshot = snapshot
    }

    if !cardNotices.isEmpty {
      let open = Set(snapshot.openRequests.compactMap { $0.asApproval?.requestID ?? $0.asClarify?.requestID })
      let kept = cardNotices.filter { open.contains($0.key) }

      if kept.count != cardNotices.count {
        cardNotices = kept
      }
    }
  }

  // MARK: Actions

  /// Send the draft (or `text`).
  ///
  /// One failure form per outcome, never both: when nothing could be sent (no
  /// socket, no session) the draft is left where it is and nothing is painted;
  /// once the message is painted, the draft is cleared and a failure keeps the
  /// bubble, marked interrupted, as the reference does — the words are the
  /// reader's, and they are on screen to send again.
  public func send(_ text: String? = nil) async {
    let body = text ?? draft
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      return
    }

    guard canSend else {
      lastError = ChatRuntimeError.notAttached(key).message
      lastErrorKind = "runtime.notAttached"
      return
    }

    if text == nil {
      draft = ""
    }

    do {
      try await store.send(key, text: body)
      lastError = nil
    } catch let error as ChatRuntimeError where error.isNotAttached {
      // Refused before anything was painted: the words go back where they were.
      if text == nil, draft.isEmpty {
        draft = body
      }

      lastError = error.message
      lastErrorKind = ChatResolver.category(error)
    } catch {
      record(error)
    }
  }

  public func stop() async {
    await perform { try await $0.stopTurn($1) }
  }

  public func steer(_ queuedID: String) async {
    await perform { _ = try await $0.steerQueued($1, queuedID) }
  }

  /// Take a parked message back into the draft.
  public func edit(_ queuedID: String) async {
    if let text = await store.editQueued(key, queuedID) {
      draft = text
    }
  }

  public func delete(_ queuedID: String) async {
    await store.deleteQueued(key, queuedID)
  }

  public func respondApproval(_ requestID: String, choice: String, all: Bool = false) async {
    await answer(requestID) { try await $0.respondApproval($1, requestID: requestID, choice: choice, all: all) }
  }

  public func respondClarify(_ requestID: String, answers: JSRecord<String>) async {
    await answer(requestID) { try await $0.respondClarify($1, requestID: requestID, answers: answers) }
  }

  /// An answer that did not go out while its card is still open gets a notice
  /// on the card, rather than nothing at all.
  private func answer(_ requestID: String, _ action: @Sendable (TranscriptStore, String) async throws -> Bool) async {
    do {
      let sent = try await action(store, key)
      lastError = nil

      if sent {
        cardNotices[requestID] = nil
      } else if await store.answerDidNotGoOut(key, requestID) {
        cardNotices[requestID] = Self.unsentAnswerNotice
      }
    } catch {
      record(error)
    }
  }

  public func lockClarify(_ requestID: String, questionID: String, answer: String) async {
    await perform { try await $0.lockClarify($1, requestID: requestID, questionID: questionID, answer: answer) }
  }

  public func acknowledge(_ requestID: String) async {
    await store.acknowledgeApproval(key, requestID)
  }

  /// One page of older history; see `OlderHistory`.
  public func loadOlder() async -> OlderHistory {
    await store.loadOlder(key)
  }

  public func startNewConversation(_ argument: String = "", command: String = "/new") async {
    await perform { try await $0.startNewConversation($1, argument: argument, command: command) }
  }

  /// This chat's session skips approval requests, as the gateway last said (`session.info.yolo`).
  /// A chat the gateway has not described yet is off.
  public var yolo: Bool { snapshot?.yolo ?? false }

  /// Switch YOLO mode on or off for this chat's session only (`config.set`, scope session). A
  /// failure is kept for the banner (`lastError`) and handed back for the line over the chat; the
  /// state stays what it was.
  @discardableResult
  public func setYolo(_ enabled: Bool) async -> YoloOutcome {
    guard canSend else {
      let error = ChatRuntimeError.notAttached(key)
      record(error)
      return .failed(error.message)
    }

    do {
      try await store.setYolo(key, enabled: enabled)
      lastError = nil
      return .switched(enabled)
    } catch {
      record(error)
      return .failed(ChatResolver.describe(error))
    }
  }

  /// Fast mode, reasoning effort, model and context usage, as the gateway last said. A chat the
  /// gateway has not described yet has the defaults.
  public var options: ChatSessionOptions { snapshot?.options ?? ChatSessionOptions() }

  /// Switch fast mode on or off for this chat's session (`config.set`, `fast`: `fast` or `normal`).
  @discardableResult
  public func setFast(_ enabled: Bool) async -> ChatOptionOutcome {
    await setOption(.fast, value: enabled ? "fast" : "normal")
  }

  /// Set the reasoning effort for this chat's session (`config.set`, `reasoning`, scope session).
  @discardableResult
  public func setReasoningEffort(_ effort: String) async -> ChatOptionOutcome {
    await setOption(.reasoning, value: effort)
  }

  /// Switch this chat's session to another model. A model the gateway calls expensive answers
  /// `.needsConfirmation` and writes nothing; only an explicit second call with `confirmExpensive`
  /// (the reader said yes) goes through.
  @discardableResult
  public func setModel(_ choice: BotModelChoice, confirmExpensive: Bool = false) async -> ChatOptionOutcome {
    await setOption(.model, value: choice.sessionValue, confirmExpensive: confirmExpensive)
  }

  /// The models the gateway offers, or why it would not say. Read once per connection.
  public func modelChoices() async -> Result<[BotModelChoice], ChatOptionFailure> {
    do {
      return .success(try await store.modelChoices())
    } catch {
      return .failure(ChatOptionFailure(message: ChatResolver.describe(error)))
    }
  }

  /// Ask the gateway for the context usage of a chat that has none yet. Quiet on failure: a gateway
  /// without `session.usage` simply leaves the meter out.
  public func refreshUsage() async {
    await store.refreshUsage(key)
  }

  private func setOption(
    _ option: ChatSessionOption, value: String, confirmExpensive: Bool = false
  ) async -> ChatOptionOutcome {
    guard canSend else {
      let error = ChatRuntimeError.notAttached(key)
      record(error)
      return .failed(error.message)
    }

    do {
      let outcome = try await store.setOption(key, option: option, value: value, confirmExpensive: confirmExpensive)
      lastError = nil
      return outcome
    } catch {
      record(error)
      return .failed(ChatResolver.describe(error))
    }
  }

  private func perform(_ action: @Sendable (TranscriptStore, String) async throws -> Void) async {
    do {
      try await action(store, key)
      lastError = nil
    } catch {
      record(error)
    }
  }
}
