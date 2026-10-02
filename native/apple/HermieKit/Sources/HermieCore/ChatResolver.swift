import Foundation
import HermieGateway
import HermieProtocol

/// A bot's one forever-chat, found the way the desktop finds it (ADR-0007):
/// the port of `BotsController.resolveCanonical` and `createCanonicalSession`,
/// plus the session calls `/new` retires a conversation with.
///
/// Everything wrong here ends with a bot that seems to have lost its memory,
/// so the rules are the reference's to the letter:
///
/// - the roster's own `canonical_session` first, no round trip;
/// - then `session.list {profile, title: 'Bot Chat', include_hidden: true}`,
///   an exact-title lookup, because a busy profile can push the chat out of any
///   recency window and canonical chats are always hidden;
/// - only then `session.create`, and only after the lookup has run a second
///   time: a gateway still warming up can answer the first with an empty list.
/// - A lookup that FAILS throws. It never reads as "this bot has no chat".
/// - One resolution per bot at a time: a double tap must not mint two chats.
///
/// `session.title` and `session.close` are session-scoped upstream: they take
/// the RUNTIME id, and a stored id answers 4001 "session not found".
public actor ChatResolver {
  /// `CANONICAL_CHAT_TITLE`: `(profile, title)` is the bot's chat identity.
  public static let canonicalTitle = "Bot Chat"
  /// `PROFILE_SESSION_LIST_LIMIT`.
  public static let sessionListLimit = 200
  /// `SESSION_COLUMNS`.
  public static let sessionColumns = 96

  /// What `session.create` handed back for a freshly minted canonical chat.
  public struct Created: Sendable, Equatable {
    public var canonical: CanonicalSession
    /// The runtime id of the new session, which every session-scoped call takes.
    public var runtimeSessionID: String
  }

  public struct ResolutionError: Error, Sendable, Equatable, CustomStringConvertible {
    public var message: String
    public var description: String { message }
  }

  private let link: any GatewayLink
  private var resolutions: [String: Task<CanonicalSession, any Error>] = [:]
  /// Callers that joined a resolution already in flight (for tests).
  private(set) var joined = 0

  public init(link: any GatewayLink) {
    self.link = link
  }

  /// `resolveCanonical`: the roster's answer, else the shared chat by title, else a new one.
  public func resolveCanonical(_ bot: Bot) async throws -> CanonicalSession {
    if let existing = resolutions[bot.name] {
      joined += 1
      return try await existing.value
    }

    let task = Task { try await self.runResolution(bot) }
    resolutions[bot.name] = task

    defer {
      resolutions[bot.name] = nil
    }

    return try await task.value
  }

  private func runResolution(_ bot: Bot) async throws -> CanonicalSession {
    if let canonical = bot.canonical, !canonical.id.isEmpty {
      return canonical
    }

    return try await resolveShared(bot.name)
  }

  /// `resolveShared`: the three steps without the roster short-circuit.
  public func resolveShared(_ profile: String) async throws -> CanonicalSession {
    if let found = try await lookupCanonical(profile) {
      return found
    }

    // Between the first lookup and here the bot may have answered a teammate's
    // DM, which creates the chat server-side.
    if let second = try await lookupCanonical(profile) {
      return second
    }

    return try await createCanonicalSession(profile).canonical
  }

  /// `lookupCanonical`: fail closed.
  public func lookupCanonical(_ profile: String) async throws -> CanonicalSession? {
    let rows: [JSONValue]

    do {
      let reply = try await link.requestReply(
        RPC.SessionList.name,
        params: [
          "profile": .string(profile),
          "title": .string(Self.canonicalTitle),
          "limit": .number(Double(Self.sessionListLimit)),
          "include_hidden": true
        ]
      )
      rows = reply.result["sessions"]?.arrayValue ?? []
    } catch {
      throw ResolutionError(
        message: "Could not check \(profile)'s chat registry (\(Self.describe(error))) — not starting a new chat."
      )
    }

    let titled = rows.first { row in
      (row["title"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == Self.canonicalTitle
    }

    guard let match = titled ?? rows.first, let id = match["id"]?.stringValue, !id.isEmpty else {
      return nil
    }

    let resolved = match["resolved_id"]?.stringValue ?? ""

    return CanonicalSession(
      id: id,
      resolvedID: resolved.isEmpty ? id : resolved,
      preview: match["preview"]?.stringValue ?? "",
      lastActive: 0,
      messageCount: match["message_count"]?.doubleValue.flatMap { Int(exactly: $0) } ?? 0
    )
  }

  /// `createCanonicalSession`: one copy of the create, so every caller agrees on
  /// every flag. A chat minted with a different `title`, `hidden` or
  /// `follow_profile_config` is not the same kind of object.
  public func createCanonicalSession(_ profile: String, parentSessionID: String? = nil) async throws -> Created {
    var params: JSONObject = [
      "profile": .string(profile),
      "title": .string(Self.canonicalTitle),
      "hidden": true,
      "source": "hermie",
      "cols": .number(Double(Self.sessionColumns)),
      // The chat follows the profile's current model, never a pin stored on an
      // old row; without this a profile switch leaves DMs on a dead provider.
      "follow_profile_config": true
    ]

    if let parentSessionID, !parentSessionID.isEmpty {
      params["parent_session_id"] = .string(parentSessionID)
    }

    let created = try await link.requestReply(RPC.SessionCreate.name, params: .object(params)).result
    let stored = created["stored_session_id"]?.stringValue ?? ""
    let runtime = created["session_id"]?.stringValue ?? ""
    let storedID = stored.isEmpty ? runtime : stored

    guard !storedID.isEmpty else {
      throw ResolutionError(message: "The gateway created a chat for \(profile) without returning its id.")
    }

    return Created(canonical: CanonicalSession(id: storedID, resolvedID: storedID), runtimeSessionID: runtime)
  }

  // MARK: The session calls `/new` is made of

  /// `session.title` on a RUNTIME id, answering the title the gateway settled on.
  @discardableResult
  public func titleSession(_ profile: String, runtimeID: String, title: String) async throws -> String {
    let result = try await link.requestReply(
      RPC.SessionTitle.name,
      params: ["session_id": .string(runtimeID), "profile": .string(profile), "title": .string(title)]
    ).result
    let settled = result["title"]?.stringValue ?? ""

    return settled.isEmpty ? title : settled
  }

  /// `session.set_hidden` on a RUNTIME id.
  public func setHidden(_ profile: String, runtimeID: String, hidden: Bool) async throws {
    _ = try await link.requestReply(
      RPC.SessionSetHidden.name,
      params: ["session_id": .string(runtimeID), "profile": .string(profile), "hidden": .bool(hidden)]
    )
  }

  /// `session.close` on a RUNTIME id.
  public func closeSession(_ profile: String, runtimeID: String) async throws {
    _ = try await link.requestReply(
      RPC.SessionClose.name,
      params: ["session_id": .string(runtimeID), "profile": .string(profile)]
    )
  }

  /// `messageOf`: an error's words, the gateway's own when it sent some.
  static func describe(_ error: any Error) -> String {
    switch error {
    case let rpc as GatewayRPCError: rpc.message
    case let gateway as GatewayError: gateway.message
    case let resolution as ResolutionError: resolution.message
    default: String(describing: error)
    }
  }
}
