import Foundation
import Observation

/**
 One bot's Conversations page: the list of its conversations and what can be done with them
 (`ConversationsPage` and `useConversations` in the web client).

 ADR-0007 gives a bot exactly ONE chat and this page does not change that. It admits that the one
 chat has a past and can have branches, and gives the reader somewhere to see them, open them
 (read-only, in the viewer), name them, delete them, make one the Bot Chat again, or put the current
 one away and start anew.

 ## What asks first

 `session.delete` has no undo, so a delete asks (`Mode.confirmDelete`). A new conversation puts the
 shared chat away for everybody on the gateway, so it asks too (`Mode.confirmNew`). A rename cannot
 lose anything (the gateway's refusals are reported) and commits on its own button; making a
 conversation the Bot Chat is a swap that rolls back on failure and runs at once.

 ## What ends every action

 Say what happened, then read the list again. The page re-reads rather than patching its list,
 because most actions change something the gateway owns, and a list that guessed at the outcome is a
 list that lies about a gateway it can simply ask. A read that is overtaken by a newer one is dropped.

 One action runs at a time. The canonical row has no actions (`Conversation.actions`), and the model
 refuses to act on a row that does not allow the action, so no view can reach Delete on the Bot Chat.

 Every text here is the gateway's or a bot's: plain text, bounded (`SecurePrompt.displayText`).
 */
@MainActor
@Observable
public final class ConversationsModel {
  /// Nothing read yet, a list, or why it could not be read.
  public enum Phase: Equatable, Sendable {
    case loading
    case ready(ConversationGroups)
    case failed(String)
  }

  /// Which question or form is open.
  public enum Mode: Equatable, Sendable {
    /// The rename field of one conversation, with what has been typed.
    case rename(id: String, draft: String)
    case confirmDelete(id: String)
    /// The new-conversation question.
    case confirmNew
  }

  /// What the page says about the last thing it did.
  public enum Notice: Equatable, Sendable {
    case renamed
    case deleted
    case adopted
    /// A refusal, in the gateway's words (plain text); `busy` is the reply-in-flight refusal.
    case failed(message: String, busy: Bool)
  }

  public let bot: String

  public private(set) var phase = Phase.loading
  public var mode: Mode?
  public private(set) var notice: Notice?
  /// An action is running: no other starts.
  public private(set) var busy = false
  /// Counts the new conversations this page started: the screen goes back to the chat on a change.
  public private(set) var startedNew = 0

  @ObservationIgnored private let backend: any ConversationsBackend
  /// Only the newest read may write: an answer that arrives after a newer read started is stale.
  @ObservationIgnored private var round = 0

  public init(bot: String, backend: any ConversationsBackend) {
    self.bot = bot
    self.backend = backend
  }

  public var groups: ConversationGroups? {
    if case .ready(let groups) = phase { groups } else { nil }
  }

  // MARK: Reading

  /// Read the list. Safe to call whenever the connection returns or the gateway says the list may
  /// have changed; a read that a newer one overtook is dropped.
  public func load() async {
    round += 1
    let mine = round

    do {
      let groups = try await backend.list(bot: bot)

      if round == mine {
        phase = .ready(groups)
      }
    } catch {
      if round == mine {
        // A list already on screen stays: a failed refresh is no reason to blank it, and it must
        // not talk over what the last action said.
        if groups == nil {
          phase = .failed(Self.words(of: error))
        } else if notice == nil {
          notice = Self.failure(error)
        }
      }
    }
  }

  // MARK: Asking

  /// Open the rename field of `conversation`, filled with its title.
  public func beginRename(_ conversation: Conversation) {
    guard !busy, conversation.allows(.rename) else {
      return
    }

    mode = .rename(id: conversation.id, draft: conversation.title)
  }

  public func setDraft(_ draft: String) {
    if case .rename(let id, _) = mode {
      mode = .rename(id: id, draft: draft)
    }
  }

  public func beginDelete(_ conversation: Conversation) {
    guard !busy, conversation.allows(.delete) else {
      return
    }

    mode = .confirmDelete(id: conversation.id)
  }

  public func beginNew() {
    guard !busy else {
      return
    }

    mode = .confirmNew
  }

  public func cancel() {
    guard !busy else {
      return
    }

    mode = nil
  }

  /// The conversation a rename field or a delete question is about.
  public var subject: Conversation? {
    switch mode {
    case .rename(let id, _)?, .confirmDelete(let id)?: groups?.conversation(id: id)
    case .confirmNew?, nil: nil
    }
  }

  // MARK: Doing

  /// Commit the open rename field. The gateway's refusals (an empty title, one another session
  /// already holds) are reported and the field stays open.
  public func commitRename() async {
    guard case .rename(let id, let draft)? = mode, let conversation = groups?.conversation(id: id),
      conversation.allows(.rename)
    else {
      return
    }

    await run {
      _ = try await self.backend.rename(bot: self.bot, conversation: conversation, title: draft)
      return .renamed
    }
  }

  /// The delete question was answered yes.
  public func confirmDelete() async {
    guard case .confirmDelete? = mode, let conversation = subject else {
      return
    }

    await delete(conversation)
  }

  /// Delete `conversation`. The caller has asked first: a view that presents the question as a
  /// dialog hands over the conversation the dialog was about, which is not read back from `mode`
  /// (a dialog's own dismissal clears it before its button's action has run).
  public func delete(_ conversation: Conversation) async {
    guard conversation.allows(.delete) else {
      return
    }

    await run {
      try await self.backend.delete(bot: self.bot, conversation: conversation)
      return .deleted
    }
  }

  /// Make `conversation` the bot's Bot Chat, at once.
  public func adopt(_ conversation: Conversation) async {
    guard conversation.allows(.adopt) else {
      return
    }

    await run {
      try await self.backend.adopt(bot: self.bot, conversation: conversation)
      return .adopted
    }
  }

  /// The new-conversation question was answered yes.
  public func confirmNew() async {
    guard case .confirmNew? = mode else {
      return
    }

    await startNew()
  }

  /// Put the current conversation away and start the next one; the screen goes back to the chat,
  /// where it starts (`startedNew`). The caller has asked first.
  public func startNew() async {
    await run {
      try await self.backend.startNew(bot: self.bot)
      self.startedNew += 1
      return nil
    }
  }

  /// Run one action: one at a time, say what happened, close the question, read the list again.
  private func run(_ work: @MainActor () async throws -> Notice?) async {
    guard !busy else {
      return
    }

    busy = true

    do {
      notice = try await work()
      mode = nil
    } catch {
      notice = Self.failure(error)
    }

    busy = false
    await load()
  }

  // MARK: Words

  /// A refusal as the page says it: the reply-in-flight refusal has its own sentence; everything
  /// else carries the gateway's reason.
  static func failure(_ error: any Error) -> Notice {
    .failed(message: words(of: error), busy: error is ConversationBusyError)
  }

  static func words(of error: any Error) -> String {
    let said = ChatResolver.describe(error)

    return SecurePrompt.displayText(said, limit: SecurePrompt.textLimit).replacingOccurrences(of: "\n", with: " ")
  }
}
