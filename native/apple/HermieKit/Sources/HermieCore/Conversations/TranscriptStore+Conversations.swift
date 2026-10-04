import Foundation
import HermieGateway
import HermieProtocol

// What the Conversations page asks of the store: the swap that makes a past conversation the
// Bot Chat again, and a runtime id for a stored one. Listing, renaming and deleting are the
// service's, over the link alone.
extension TranscriptStore {
  /// A runtime id for a stored conversation of `profile`, resuming the session when nothing holds it.
  ///
  /// `session.title` and `session.close` take a RUNTIME id (`_with_db(session_scoped=True)` over a
  /// plain lookup of the live sessions) and a listing hands out STORED ids, so a conversation that
  /// nothing is running has to be resumed before it can be renamed. The live id is preferred where
  /// the store already holds one: resuming a session that is up costs a round trip and mints
  /// nothing. `resumed` says whether this call made the runtime session, so the caller that only
  /// wanted a name changed can put it away again.
  func runtimeSession(for storedID: String, profile: String) async throws -> (id: String, resumed: Bool) {
    if let state = chats[profile]?.state, state.storedSessionID == storedID, let runtimeID = state.runtimeSessionID,
      !runtimeID.isEmpty
    {
      return (runtimeID, false)
    }

    let params: JSONValue = [
      "session_id": .string(storedID),
      "profile": .string(profile),
      "omit_messages": true,
      "source": "hermie",
      "cols": .number(Double(ChatRuntimeLimits.resumeColumns))
    ]
    let reply = try await link.requestReply(RPC.SessionResume.name, params: params)
    let runtimeID = reply.result["session_id"]?.stringValue ?? ""

    guard !runtimeID.isEmpty else {
      throw ChatRuntimeError(message: "The gateway resumed a conversation of \(profile)'s without a session id.")
    }

    return (runtimeID, true)
  }

  /**
   Make one of a bot's other conversations its Bot Chat again (`adoptAsCanonical`).

   A SWAP, and the order is the one `startNewConversation` retires with, for the same reason: the
   title is the registry key, so while the outgoing chat still wears `Bot Chat` the incoming one
   cannot take it (upstream refuses a duplicate outright). So: retire the current chat (un-hide it,
   rename it `Bot Chat · <date time>`), rename the incoming one and hide it, then switch the bot's
   key to it. Every step that can fail rolls back towards "nothing happened", because a bot left
   with no canonical chat is worse than a swap that did not happen: the next open would mint a
   third one beside the two that are already there.

   Refused (`ConversationBusyError`) while a reply is streaming or something is queued or on its
   way, because the chat that is put away would lose it. While it runs nothing is sent into the chat.
   Naming the conversation that is already current changes nothing.
   */
  public func adoptAsCanonical(_ key: String, as target: CanonicalSession) async throws {
    // A hydration in flight first: its answers belong to the conversation it opens.
    await waitForOpening(key)

    guard !retiring.contains(key) else {
      throw ConversationBusyError(botName: key)
    }

    guard let state = chats[key]?.state, let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty,
      !state.storedSessionID.isEmpty, let bot = await roster.bot(named: key)
    else {
      throw ChatRuntimeError.notAttached(key)
    }

    guard state.storedSessionID != target.id else {
      return
    }

    guard !retiring.contains(key), !state.turn.active, isIdle(key) else {
      throw ConversationBusyError(botName: key)
    }

    // From here until the swap is done nothing new starts under the key.
    retiring.insert(key)

    defer {
      retiring.remove(key)
    }

    let resolver = roster.resolver
    let incoming = try await runtimeSession(for: target.id, profile: key).id
    let retired = "\(ChatResolver.canonicalTitle) · \(Self.localStamp(now()))"

    try? await resolver.setHidden(key, runtimeID: runtimeID, hidden: false)

    do {
      try await resolver.titleSession(key, runtimeID: runtimeID, title: retired)
    } catch {
      // Nothing has moved yet, so putting the hidden flag back is the whole of the undo.
      await undoRetire(resolver, key, runtimeID, renamed: false)
      throw error
    }

    do {
      try await resolver.titleSession(key, runtimeID: incoming, title: ChatResolver.canonicalTitle)
    } catch {
      // The title did not move. The outgoing chat sits under a retired name with nothing holding
      // the canonical title, which is exactly the state that makes the next open mint a third
      // chat, so its name goes back before this throws.
      await undoRetire(resolver, key, runtimeID, renamed: true)
      throw error
    }

    // Hidden, because that is what makes it canonical to everything that looks for one. Best
    // effort: the title has already moved, so the swap has happened either way.
    try? await resolver.setHidden(key, runtimeID: incoming, hidden: true)

    // The conversation just put away stops being live, as `/new` leaves it: the gateway refuses
    // to delete a session that is live, and this one is now an ordinary past conversation.
    // Best effort: the transcript is on disk either way.
    try? await resolver.closeSession(key, runtimeID: runtimeID)

    await switchCanonical(bot, target)
  }
}
