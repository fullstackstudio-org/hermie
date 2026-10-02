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

  @ObservationIgnored private var roster = BotRoster.Snapshot()
  @ObservationIgnored private var summaries: [String: ChatSummary] = [:]

  public init() {}

  /// A fresh roster: every row is rebuilt (the roster changes rarely).
  func apply(_ snapshot: BotRoster.Snapshot) {
    roster = snapshot
    loading = snapshot.loading
    rosterError = snapshot.error
    refreshed = snapshot.refreshed

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
  public private(set) var snapshot: ChatSnapshot?
  public var draft = ""
  /// The reader's verbosity options (`setVisibility` re-projects the transcript).
  public private(set) var visibility: VisibilityOptions

  /// The last thing an action could not do, for a banner.
  public private(set) var lastError: String?

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

  /// Show the transcript at other verbosity options; the next frame carries it.
  public func setVisibility(_ options: VisibilityOptions) {
    guard options != visibility else {
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
  public var canSend: Bool { snapshot?.attached ?? false }

  func apply(_ snapshot: ChatSnapshot) {
    self.snapshot = snapshot
  }

  // MARK: Actions

  /// Send the draft (or `text`), clearing the draft first; it comes back on failure.
  public func send(_ text: String? = nil) async {
    let body = text ?? draft
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      return
    }

    if text == nil {
      draft = ""
    }

    do {
      try await store.send(key, text: body)
      lastError = nil
    } catch {
      if text == nil, draft.isEmpty {
        draft = body
      }

      lastError = ChatResolver.describe(error)
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
    await perform { _ = try await $0.respondApproval($1, requestID: requestID, choice: choice, all: all) }
  }

  public func respondClarify(_ requestID: String, answers: JSRecord<String>) async {
    await perform { _ = try await $0.respondClarify($1, requestID: requestID, answers: answers) }
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

  private func perform(_ action: @Sendable (TranscriptStore, String) async throws -> Void) async {
    do {
      try await action(store, key)
      lastError = nil
    } catch {
      lastError = ChatResolver.describe(error)
    }
  }
}
