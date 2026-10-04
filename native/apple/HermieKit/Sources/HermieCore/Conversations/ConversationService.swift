import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// One page of a conversation's transcript, as the viewer reads it.
public struct ConversationTranscriptPage: Sendable, Equatable {
  /// Oldest first.
  public var rows: [TranscriptRow]
  public var shape: RowShape
  /// No older page exists: the REST route answered fewer rows than it was asked for, or the
  /// transport (`session.history`) is unpaginated and so answered everything.
  public var reachedStart: Bool

  public init(rows: [TranscriptRow], shape: RowShape, reachedStart: Bool) {
    self.rows = rows
    self.shape = shape
    self.reachedStart = reachedStart
  }
}

/// What the Conversations page and the conversation viewer ask of the gateway, as one seam: a test
/// hands in a stub, production a `ConversationService` over a session.
public protocol ConversationsBackend: Sendable {
  /// The profile's conversations, grouped.
  func list(bot: String) async throws -> ConversationGroups
  /// Rename; answers the title the gateway settled on.
  func rename(bot: String, conversation: Conversation, title: String) async throws -> String
  func delete(bot: String, conversation: Conversation) async throws
  /// Make `conversation` the bot's Bot Chat, putting the current one away.
  func adopt(bot: String, conversation: Conversation) async throws
  /// Put the current conversation away and start the next one.
  func startNew(bot: String) async throws
  /// A page of one conversation's transcript, for reading.
  func transcript(bot: String, conversation: Conversation, window: MessageWindow) async throws
    -> ConversationTranscriptPage
}

/**
 The gateway calls behind a bot's Conversations page: `session.list`, `session.title`,
 `session.delete`, the swap of `TranscriptStore.adoptAsCanonical` and the new conversation of
 `TranscriptStore.startNewConversation` (`listConversations`, `renameConversation`,
 `deleteConversation`, `adoptAsCanonical` in the web client's chat controller).

 The page re-reads the list after every action rather than patching it, because most actions change
 something the gateway owns (a title it may have refused, a row it deleted, a Bot Chat that moved).
 */
public struct ConversationService: ConversationsBackend {
  let link: any GatewayLink
  let store: TranscriptStore
  let roster: BotRoster

  public init(link: any GatewayLink, store: TranscriptStore, roster: BotRoster) {
    self.link = link
    self.store = store
    self.roster = roster
  }

  /**
   Every conversation this profile has, grouped.

   `include_hidden` is on, and it has to be: the canonical chat is hidden by definition (ADR-0007),
   so a listing without it is a listing with the one row the reader is actually in missing from it.
   The roster's canonical id is passed through rather than re-derived from the titles, because an id
   cannot be typed by hand into the wrong row.
   */
  public func list(bot: String) async throws -> ConversationGroups {
    let reply = try await link.requestReply(
      RPC.SessionList.name,
      params: [
        "profile": .string(bot),
        "include_hidden": true,
        "limit": .number(Double(ChatResolver.sessionListLimit))
      ]
    )
    let rows = (reply.result["sessions"]?.arrayValue ?? []).compactMap {
      $0.objectValue.map(SessionListRow.init(json:))
    }
    let canonical = await roster.bot(named: bot)?.canonical

    return ConversationClassifier.classify(
      rows: rows, canonicalID: canonical?.id, canonicalResolvedID: canonical?.resolvedID)
  }

  /**
   Rename one conversation that is not the canonical chat.

   `session.title` takes a RUNTIME id, so a conversation nothing is running is resumed first. A
   session this call resumed only to name it is closed again afterwards: the gateway refuses to
   delete a session that is live, and nobody asked for this one to be. The refusals travel (an empty
   title, a title another session already holds): nothing is swallowed here.
   */
  public func rename(bot: String, conversation: Conversation, title: String) async throws -> String {
    let session = try await store.runtimeSession(for: conversation.id, profile: bot)

    do {
      let settled = try await roster.resolver.titleSession(bot, runtimeID: session.id, title: title)
      await putAway(session, bot: bot)

      return settled
    } catch {
      await putAway(session, bot: bot)
      throw error
    }
  }

  /// `session.delete` takes the STORED id, the opposite of `session.title`. It does not check
  /// whether the conversation is canonical: that is `Conversation.actions`, which answers nothing
  /// for the canonical row, so no surface can offer it.
  public func delete(bot: String, conversation: Conversation) async throws {
    _ = try await link.requestReply(
      RPC.SessionDelete.name,
      params: ["session_id": .string(conversation.id), "profile": .string(bot)]
    )
  }

  public func adopt(bot: String, conversation: Conversation) async throws {
    try await ensureOpen(bot)
    try await store.adoptAsCanonical(
      bot,
      as: CanonicalSession(
        id: conversation.id,
        resolvedID: conversation.resolvedID,
        preview: conversation.preview,
        lastActive: conversation.lastActive,
        messageCount: conversation.messageCount
      )
    )
  }

  public func startNew(bot: String) async throws {
    try await ensureOpen(bot)
    try await store.startNewConversation(bot)
  }

  /// The REST transcript first (`GET /api/sessions/{id}/messages`, paged from the newest row), and
  /// where this gateway has none, a resume and `session.history`, which is unpaginated.
  public func transcript(bot: String, conversation: Conversation, window: MessageWindow) async throws
    -> ConversationTranscriptPage
  {
    if let rows = await link.fetchMessages(conversation.resolvedID, window) {
      return ConversationTranscriptPage(
        rows: rows, shape: .rest, reachedStart: rows.count < window.limit)
    }

    // No REST transcript, so only the first page can be read: `session.history` answers it all.
    guard window.offset == 0 else {
      return ConversationTranscriptPage(rows: [], shape: .rpc, reachedStart: true)
    }

    let session = try await store.runtimeSession(for: conversation.id, profile: bot)

    do {
      let reply = try await link.requestReply(
        RPC.SessionHistory.name,
        params: ["session_id": .string(session.id), "profile": .string(bot)]
      )
      let rows = (reply.result["messages"]?.arrayValue ?? []).map { TranscriptRow(json: $0.objectValue ?? [:]) }
      await putAway(session, bot: bot)

      return ConversationTranscriptPage(rows: rows, shape: .rpc, reachedStart: true)
    } catch {
      await putAway(session, bot: bot)
      throw error
    }
  }

  /// A session this service resumed only to read or name it stops being live again (best effort).
  private func putAway(_ session: (id: String, resumed: Bool), bot: String) async {
    if session.resumed {
      try? await roster.resolver.closeSession(bot, runtimeID: session.id)
    }
  }

  /// The chat live under the bot's key, opened if it is not: a swap and a new conversation retire it.
  func ensureOpen(_ bot: String) async throws {
    if let runtime = await store.sessionIDs()[bot]?.runtime, !runtime.isEmpty {
      return
    }

    guard let record = await roster.bot(named: bot) else {
      throw ChatRuntimeError(message: "\(bot) is not on this gateway.")
    }

    try await store.open(record)
  }
}
