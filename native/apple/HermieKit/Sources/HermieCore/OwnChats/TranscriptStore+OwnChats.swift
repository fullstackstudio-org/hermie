import Foundation

extension TranscriptStore {
  /// Is the chat under this key one of the reader's own, rather than the shared Bot Chat?
  public func isOwnChat(_ key: String) -> Bool {
    ownKeys.contains(key)
  }

  /// The stored id of the own chat this bot is on, or nil on the shared Bot Chat (or no chat at all).
  public func ownChatStoredID(_ key: String) -> String? {
    guard ownKeys.contains(key), let id = chats[key]?.state.storedSessionID, !id.isEmpty else {
      return nil
    }

    return id
  }

  /// Refuse BEFORE anything is made when the chat under this key could not be left: a reply
  /// streaming, or messages queued or on their way (`ConversationBusyError`).
  public func assertCanLeave(_ key: String) async throws {
    await waitForOpening(key)

    guard !retiring.contains(key) else {
      throw ConversationBusyError(botName: key)
    }

    if let record = chats[key], record.live, record.state.turn.active || !isIdle(key) {
      throw ConversationBusyError(botName: key)
    }
  }

  /// A command's answer as the notice row a reader cannot miss, in the chat now under the key.
  public func noteCommand(_ key: String, command: String, body: String) {
    commandRow(key, chats[key]?.state.runtimeSessionID ?? "", command, body)
  }

  /// Where `/new` goes in an own chat (see `ownChatStarter`).
  public func setOwnChatStarter(_ starter: (@Sendable (String, String, String) async throws -> Void)?) {
    ownChatStarter = starter
  }

  /**
   Open this bot on one of the reader's own chats, or on the shared Bot Chat with `own` nil
   (`switchTo` in the web client's chat controller).

   Everything keyed by the conversation being left is dropped and the ordinary open path runs, rather
   than a second hydration written specially for this: `session.resume` binds the new runtime id, the
   transcript paints empty, and the hydration states move in the order every other open moves them.
   Unlike `switchCanonical` (a `/new`, a swap) the roster is NOT repointed: the bot's canonical chat
   keeps naming the Bot Chat, so the shared chat stays what the list says about the bot.

   The transcript cache is keyed by bot and has no idea which conversation it holds, so it holds the
   shared chat only: the shared chat is written to it on the way out, and an own chat is never read
   from it or written to it (`ownKeys`).

   Refused (`ConversationBusyError`) while a reply streams or messages are queued or on their way:
   the chat that is left would lose them. Asking for the chat a bot is already on changes nothing.

   - Parameters:
     - bot: the roster's row, whose `canonical` is the shared chat.
     - own: the own chat to open; nil for the shared one.
   */
  public func showChat(_ key: String, bot: Bot, own: CanonicalSession?) async throws {
    // A hydration in flight first: its answers belong to the conversation it opens.
    await waitForOpening(key)

    guard !retiring.contains(key) else {
      throw ConversationBusyError(botName: key)
    }

    let onOwn = ownKeys.contains(key)
    let record = chats[key]

    // Already there: the ordinary open finishes what a hydration left half done, and is a no-op on a
    // live chat.
    if let own, onOwn, record?.state.storedSessionID == own.id {
      return try await open(opened(bot, own))
    }

    if own == nil, !onOwn {
      return try await open(bot)
    }

    if let record, record.live, record.state.turn.active || !isIdle(key) {
      throw ConversationBusyError(botName: key)
    }

    // From here until the other chat is open nothing new starts under the key.
    retiring.insert(key)

    defer {
      retiring.remove(key)
    }

    if record != nil, !onOwn {
      await persist(key)
    }

    let observedOptions = observed[key]
    forget(key)

    if let observedOptions {
      observed[key] = observedOptions
    }

    if own == nil {
      ownKeys.remove(key)
    } else {
      ownKeys.insert(key)
    }

    try await open(opened(bot, own))
  }

  /// The row `open` is asked for: the roster's, with an own chat in place of the shared one.
  private func opened(_ bot: Bot, _ own: CanonicalSession?) -> Bot {
    guard let own else {
      return bot
    }

    var moved = bot
    moved.canonical = own

    return moved
  }
}
