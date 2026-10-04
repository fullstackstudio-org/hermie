import Foundation
import HermieGateway
import HermieProtocol

/**
 The gateway calls behind a reader's own chats (`user-chat.ts` and `startOwnChat` of the web client's
 chat controller): finding one, finding or making the first, and making another.

 What these share with the Bot Chat's resolution (`ChatResolver`), for the same reasons:

 - **The lookup fails CLOSED.** A `session.list` that errored is not a person without a chat, and
   reading it as one is how a private conversation gets forked in two. It throws.
 - **An exact-title lookup**, indexed (`session.list {profile, title, include_hidden: true}`), never a
   recency window: a busy profile pushes anything out of a window. `include_hidden` makes the
   listing complete even though an own chat is never hidden.
 - **Never hidden.** `hidden` marks the one canonical row upstream guards, and a hidden session under
   another title would be a chat no other client could show the reader.
 - **Created under the Bot Chat** (`parent_session_id`), visible, following the profile's configuration.
 */
public struct OwnChatService: Sendable {
  /// What a made chat is: the session, and the title the gateway settled on.
  public struct Made: Sendable, Equatable {
    public var chat: CanonicalSession
    public var title: String
  }

  /// `TITLE_CLASH_CODE`: the gateway's "that title is taken".
  static let titleClashCode = 4022

  let link: any GatewayLink
  let resolver: ChatResolver

  public init(link: any GatewayLink, resolver: ChatResolver) {
    self.link = link
    self.resolver = resolver
  }

  // MARK: Finding

  /// The reader's chat titled exactly `title` on this bot. Throws rather than answer "none" on failure.
  public func lookup(profile: String, title: String) async throws -> CanonicalSession? {
    let rows = try await list(profile: profile, title: title, why: "chat registry")

    return session(of: rows.first { OwnChatTitle.collapse($0.title ?? "") == OwnChatTitle.collapse(title) })
  }

  /// One of the reader's own chats by the stored id a device remembered for it. `session.list` has no
  /// id filter, so this is one profile listing and a scan. A row only counts while it still wears this
  /// reader's title family: an id is an address, and one that now names somebody else's chat, or the
  /// Bot Chat after an adopt, is not the reader's chat any more.
  ///
  /// Answers nil when the listing does not hold it (deleted, or renamed out of the family) and THROWS
  /// when the listing failed: the caller forgets a remembered id on the first and must not on the
  /// second, because a gateway that is restarting has not deleted anybody's chat.
  public func lookup(profile: String, lead: String, storedID: String) async throws -> CanonicalSession? {
    let rows = try await list(profile: profile, title: nil, why: "conversations")

    return session(
      of: rows.first { row in
        (row.id == storedID || row.resolvedID == storedID) && OwnChatTitle.isOwn(row.title ?? "", lead: lead)
      })
  }

  // MARK: Making

  /// The reader's first chat on this bot, resolved the way the Bot Chat is: found by title, found
  /// again before minting (the same person on another device may have made it in between, and minting
  /// on a stale empty answer forks the conversation), else made. It carries the bare lead as its title
  /// (`resolveUserChat`): that is the one thing a lookup on another device can find it by, so the
  /// switch never makes a second one. Another chat is `make`, which always names its chat.
  public func resolve(profile: String, lead: String, parentSessionID: String?) async throws
    -> CanonicalSession
  {
    guard !lead.isEmpty else {
      throw ChatResolver.ResolutionError(message: Self.noIdentity)
    }

    if let found = try await lookup(profile: profile, title: lead) {
      return found
    }

    if let second = try await lookup(profile: profile, title: lead) {
      return second
    }

    return try await create(profile: profile, title: lead, parentSessionID: parentSessionID).chat
  }

  /**
   Another of the reader's own chats on this bot, named `label` (empty: the stamp it is born with).

   Created visible, under the Bot Chat, and titled AT ONCE with `session.title` on the runtime id:
   upstream persists no row for an empty draft, and the title write is what makes the chat exist on
   every device before its first message, and what surfaces a clash. A clash is retried once, a name
   the reader gave numbered and a stamp with its seconds. Never through `resolve`'s lookup: this is the
   one place an own chat is minted on request.
   */
  public func make(profile: String, lead: String, label: String, parentSessionID: String?, now: Double)
    async throws -> Made
  {
    guard !lead.isEmpty else {
      throw ChatResolver.ResolutionError(message: Self.noIdentity)
    }

    let asked = OwnChatTitle.cutLabel(label)
    let first = OwnChatTitle.title(lead: lead, label: asked.isEmpty ? OwnChatTitle.stamp(at: now) : asked)

    let created = try await create(profile: profile, title: first, parentSessionID: parentSessionID)
    let runtime = created.runtime

    let title: String

    // Without a runtime id there is nothing to title: the chat exists under the title it was made with.
    if runtime.isEmpty {
      title = first
    } else {
      title = try await settle(profile: profile, runtime: runtime, first: first, asked: asked, lead: lead, now: now)
    }

    return Made(chat: created.chat, title: title)
  }

  /// `session.create` for a chat of the reader's: visible (`hidden` marks the one canonical row), under
  /// the Bot Chat, following the profile's configuration, in the title it is to carry.
  private func create(profile: String, title: String, parentSessionID: String?) async throws
    -> (chat: CanonicalSession, runtime: String)
  {
    var params: JSONObject = [
      "profile": .string(profile),
      "title": .string(title),
      "hidden": false,
      "source": "hermie",
      "cols": .number(Double(ChatResolver.sessionColumns)),
      "follow_profile_config": true
    ]

    if let parentSessionID, !parentSessionID.isEmpty {
      params["parent_session_id"] = .string(parentSessionID)
    }

    let created = try await link.requestReply(RPC.SessionCreate.name, params: .object(params)).result
    let runtime = created["session_id"]?.stringValue ?? ""
    let stored = created["stored_session_id"]?.stringValue ?? ""
    let storedID = stored.isEmpty ? runtime : stored

    guard !storedID.isEmpty else {
      throw ChatResolver.ResolutionError(
        message: "The gateway created a chat for \(profile) without returning its id.")
    }

    return (CanonicalSession(id: storedID, resolvedID: storedID), runtime)
  }

  /// `session.title` for a chat just made, with the one retry after a clash. A chat whose title could
  /// not be written is closed again: it would be a session nobody can find.
  private func settle(profile: String, runtime: String, first: String, asked: String, lead: String, now: Double)
    async throws -> String
  {
    do {
      return try await resolver.titleSession(profile, runtimeID: runtime, title: first)
    } catch {
      guard Self.isTitleClash(error) else {
        try? await resolver.closeSession(profile, runtimeID: runtime)
        throw error
      }
    }

    // The reader's own name is kept, numbered; a stamp gains its seconds.
    let retry = asked.isEmpty ? OwnChatTitle.stamp(at: now, seconds: true) : OwnChatTitle.numbered(asked, 2)

    do {
      return try await resolver.titleSession(
        profile, runtimeID: runtime, title: OwnChatTitle.title(lead: lead, label: retry))
    } catch {
      try? await resolver.closeSession(profile, runtimeID: runtime)
      throw error
    }
  }

  // MARK: Plumbing

  static let noIdentity = "This gateway has not said who you are, so there is only the shared Bot Chat."

  static func isTitleClash(_ error: any Error) -> Bool {
    (error as? GatewayRPCError)?.code == titleClashCode
  }

  private func list(profile: String, title: String?, why: String) async throws -> [SessionListRow] {
    var params: JSONObject = [
      "profile": .string(profile),
      "limit": .number(Double(ChatResolver.sessionListLimit)),
      "include_hidden": true
    ]

    if let title {
      params["title"] = .string(title)
    }

    do {
      let reply = try await link.requestReply(RPC.SessionList.name, params: .object(params))

      return (reply.result["sessions"]?.arrayValue ?? []).compactMap { $0.objectValue.map(SessionListRow.init(json:)) }
    } catch {
      throw ChatResolver.ResolutionError(
        message: "Could not check \(profile)'s \(why) (\(ChatResolver.describe(error))) — not starting a new chat.")
    }
  }

  private func session(of row: SessionListRow?) -> CanonicalSession? {
    guard let row, let id = row.id, !id.isEmpty else {
      return nil
    }

    let resolved = row.resolvedID.flatMap { $0.isEmpty ? nil : $0 } ?? id

    return CanonicalSession(
      id: id, resolvedID: resolved, preview: row.preview ?? "", lastActive: row.startedAt ?? 0,
      messageCount: row.messageCount ?? 0)
  }
}
