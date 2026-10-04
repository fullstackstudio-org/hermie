import Foundation
import HermieGateway
import HermieProtocol

// What the Conversations page asks of the store: the swap that makes a past conversation the
// Bot Chat again, and a runtime id for a stored one. Listing, renaming and deleting are the
// service's, over the link alone.
extension TranscriptStore {
  /// `localStamp` with the seconds: `2026-09-21 23:16:08`, in the reader's own zone.
  static func localStampWithSeconds(_ now: Double) -> String {
    let date = Date(timeIntervalSince1970: now / 1000)
    let seconds = Calendar.current.component(.second, from: date)

    return "\(localStamp(now)):\(String(format: "%02d", seconds))"
  }

  /// Name the conversation being put away `Bot Chat · <date time>` (what `/new` and the swap
  /// retire with), answering the title taken.
  ///
  /// The stamp counts minutes, so a second retire in the same minute finds its name worn by the
  /// conversation put away a moment ago, and the gateway refuses the duplicate. One more try with the
  /// seconds in it (`Bot Chat · 2026-09-21 23:16:08`, still a retired title to the Conversations
  /// page); if that is refused too, the error is the second one.
  func titleAsRetired(_ resolver: ChatResolver, _ key: String, _ runtimeID: String, at moment: Double) async throws
    -> String
  {
    let stamped = "\(ChatResolver.canonicalTitle) · \(Self.localStamp(moment))"

    do {
      return try await resolver.titleSession(key, runtimeID: runtimeID, title: stamped)
    } catch {
      let precise = "\(ChatResolver.canonicalTitle) · \(Self.localStampWithSeconds(moment))"

      return try await resolver.titleSession(key, runtimeID: runtimeID, title: precise)
    }
  }

  /// A runtime id for a stored conversation of `profile`, resuming the session when nothing holds it.
  ///
  /// `session.title` and `session.close` take a RUNTIME id (`_with_db(session_scoped=True)` over a
  /// plain lookup of the live sessions) and a listing hands out STORED ids, so a conversation that
  /// nothing is running has to be resumed before it can be renamed. The live id is preferred where
  /// the store already holds one: resuming a session that is up costs a round trip and mints
  /// nothing.
  ///
  /// `broughtUp` says that THIS call made the runtime session, and only then may the caller put it
  /// away again: a session another client has live is that client's to end. The gateway does not say
  /// who is attached, so the live sessions are listed first (`session.active_list`) and the session
  /// counts as brought up here only when neither its stored id, its lineage tip nor the runtime id the
  /// resume answers is among them. A list that cannot be read, or a gateway without the method, means
  /// "cannot tell", which is treated as "was live": nothing is closed.
  func runtimeSession(for storedID: String, resolvedID: String? = nil, profile: String) async throws
    -> (id: String, broughtUp: Bool)
  {
    if let state = chats[profile]?.state, state.storedSessionID == storedID, let runtimeID = state.runtimeSessionID,
      !runtimeID.isEmpty
    {
      return (runtimeID, false)
    }

    let live = await liveSessionIDs()
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

    guard let live else {
      return (runtimeID, false)
    }

    let known = [storedID, resolvedID ?? storedID, runtimeID]

    return (runtimeID, !known.contains { live.contains($0) })
  }

  /// Every id the gateway's live sessions go by (`id` and `session_key` of each row of
  /// `session.active_list`), or nil where that cannot be read.
  private func liveSessionIDs() async -> Set<String>? {
    guard let reply = try? await link.requestReply(RPC.SessionActiveList.name, params: [:]),
      let rows = reply.result["sessions"]?.arrayValue
    else {
      return nil
    }

    var ids: Set<String> = []

    for row in rows {
      for field in ["id", "session_key"] {
        if let id = row[field]?.stringValue, !id.isEmpty {
          ids.insert(id)
        }
      }
    }

    return ids
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

    // The swap puts the conversation under the key away as the Bot Chat; an own chat is not it.
    guard !ownKeys.contains(key) else {
      throw ChatRuntimeError(message: "Go back to the shared Bot Chat first: making a conversation the Bot Chat changes it.")
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
    let incoming = try await runtimeSession(for: target.id, resolvedID: target.resolvedID, profile: key).id
    let moment = now()

    try? await resolver.setHidden(key, runtimeID: runtimeID, hidden: false)

    do {
      _ = try await titleAsRetired(resolver, key, runtimeID, at: moment)
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

    // The conversation just put away is NOT closed: the Bot Chat is shared, so another client may
    // have its runtime session attached, and ending that is not this client's to do. (The gateway
    // refuses to delete a session that is live; a delete of it says so.)
    await switchCanonical(bot, target)
  }
}
