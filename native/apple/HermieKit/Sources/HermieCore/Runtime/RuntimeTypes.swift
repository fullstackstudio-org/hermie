import Foundation
import HermieProtocol
import HermieTranscript

/// The numbers the chat runtime runs on, spelled once, with the reference's names.
public enum ChatRuntimeLimits {
  /// `TURN_CLAIM_TIMEOUT_MS`: short enough that a wedged plugin is never felt on send.
  public static let turnClaimTimeoutMs = 1_500
  /// `REST_HISTORY_THRESHOLD`: above this many rows, `session.history` is a download; the REST tail is not.
  public static let restHistoryThreshold = 400
  /// `REST_HISTORY_LIMIT`: rows the REST transcript hands back for a full load, and one page of older history.
  public static let restHistoryLimit = 200
  /// `TAIL_ROW_LIMIT`: rows a tail reconcile asks for. Enough to cover one foreign turn.
  public static let tailRowLimit = 30
  /// `RESUME_COLS`: the terminal width every resume carries.
  public static let resumeColumns = 96
  /// `MAX_PARKED_REQUESTS`: server requests held per session that is not bound yet.
  public static let maxParkedRequests = 16
  /// `SESSIONS_CHANGED_DEBOUNCE_MS`: one sweep per burst of `sessions.changed`.
  public static let sessionsChangedDebounce: Duration = .milliseconds(500)
  /// `APPROVAL_POLL_MS`: the approval safety net while a turn runs in front.
  public static let approvalPoll: Duration = .seconds(30)
  /// `SUBAGENT_RECONCILE_MS`: how often a chat with live children re-reads `subagent.list`.
  public static let subagentPoll: Duration = .seconds(5)
  /// `ACTIVE_LIST_POLL_MS`: how often the roster re-reads running state while it is watched.
  public static let activeListPoll: Duration = .seconds(10)
  /// Session-layer signals (notices, connection cards, progress) the store keeps for a session
  /// that has not read them yet; older ones are dropped first.
  public static let maxBufferedSignals = 512
  /// Distinct unknown event names counted for the developer detail.
  public static let maxUnknownEventNames = 64
}

/// `BotCanonicalSession`: one conversation a bot can be reached by.
public struct CanonicalSession: Sendable, Hashable {
  /// The durable registry id. Resume on this, persist this, never the runtime id.
  public var id: String
  /// The compression-lineage tip. REST transcript rows are read under this one.
  public var resolvedID: String
  public var preview: String
  /// Unix seconds.
  public var lastActive: Double
  public var messageCount: Int

  public init(id: String, resolvedID: String, preview: String = "", lastActive: Double = 0, messageCount: Int = 0) {
    self.id = id
    self.resolvedID = resolvedID
    self.preview = preview
    self.lastActive = lastActive
    self.messageCount = messageCount
  }

  /// The roster's JSON for it (`store/bots.ts`), the shape the cache keeps.
  public var jsonValue: JSONValue {
    [
      "id": .string(id),
      "resolvedId": .string(resolvedID),
      "preview": .string(preview),
      "lastActive": .number(lastActive),
      "messageCount": .number(Double(messageCount))
    ]
  }

  public init?(jsonValue: JSONValue) {
    guard let id = jsonValue["id"]?.stringValue, !id.isEmpty else {
      return nil
    }

    self.init(
      id: id,
      resolvedID: jsonValue["resolvedId"]?.stringValue ?? id,
      preview: jsonValue["preview"]?.stringValue ?? "",
      lastActive: jsonValue["lastActive"]?.doubleValue ?? 0,
      messageCount: jsonValue["messageCount"]?.doubleValue.flatMap { Int(exactly: $0) } ?? 0
    )
  }
}

/// One bot of the roster: a Hermes profile (`Bot` in `store/bots.ts`).
public struct Bot: Sendable, Hashable, Identifiable {
  public var name: String
  public var displayName: String
  public var description: String
  public var model: String
  public var provider: String
  public var isDefault: Bool
  public var hasAvatar: Bool
  /// The bot's shared Bot Chat, when the gateway resolved one.
  public var canonical: CanonicalSession?
  /// Highest of the profile's `ui_meta_revisions`; avatars are cached against `name + revision`.
  public var uiMetaRevision: Int

  public var id: String { name }

  public init(
    name: String,
    displayName: String? = nil,
    description: String = "",
    model: String = "",
    provider: String = "",
    isDefault: Bool = false,
    hasAvatar: Bool = false,
    canonical: CanonicalSession? = nil,
    uiMetaRevision: Int = 0
  ) {
    self.name = name
    self.displayName = displayName ?? name
    self.description = description
    self.model = model
    self.provider = provider
    self.isDefault = isDefault
    self.hasAvatar = hasAvatar
    self.canonical = canonical
    self.uiMetaRevision = uiMetaRevision
  }

  /// `botFromProfileRow`: one `profiles.list` row projected onto the roster model.
  public init(row: ProfileRow) {
    let json = row.json
    let string = { (key: String) -> String in json[key]?.stringValue ?? "" }
    let name = string("name")
    let revisions = (json["ui_meta_revisions"]?.objectValue ?? [:]).values.compactMap { value -> Double? in
      guard let number = value.doubleValue, number.isFinite else { return nil }
      return number
    }
    var canonical: CanonicalSession?

    if let session = json["canonical_session"]?.objectValue, let id = session["id"]?.stringValue, !id.isEmpty {
      let resolved = session["resolved_id"]?.stringValue ?? ""
      let finite = { (value: JSONValue?) -> Double in
        guard let number = value?.doubleValue, number.isFinite else { return 0 }
        return number
      }

      canonical = CanonicalSession(
        id: id,
        resolvedID: resolved.isEmpty ? id : resolved,
        preview: session["preview"]?.stringValue ?? "",
        lastActive: finite(session["last_active"]),
        messageCount: Int(finite(session["message_count"]))
      )
    }

    let displayName = string("display_name")

    self.init(
      name: name,
      displayName: displayName.isEmpty ? name : displayName,
      description: string("description"),
      model: string("model"),
      provider: string("provider"),
      isDefault: json["is_default"] == .bool(true),
      hasAvatar: json["has_avatar"] == .bool(true),
      canonical: canonical,
      uiMetaRevision: Int(revisions.max() ?? 0)
    )
  }

  /// The roster's JSON (`JSON.stringify(bot)`), what a cached roster row holds.
  public var jsonValue: JSONValue {
    var object: JSONObject = [
      "name": .string(name),
      "displayName": .string(displayName),
      "description": .string(description),
      "model": .string(model),
      "provider": .string(provider),
      "isDefault": .bool(isDefault),
      "hasAvatar": .bool(hasAvatar),
      "uiMetaRevision": .number(Double(uiMetaRevision))
    ]

    if let canonical {
      object["canonical"] = canonical.jsonValue
    }

    return .object(object)
  }

  public init?(jsonValue: JSONValue) {
    guard let name = jsonValue["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    self.init(
      name: name,
      displayName: jsonValue["displayName"]?.stringValue,
      description: jsonValue["description"]?.stringValue ?? "",
      model: jsonValue["model"]?.stringValue ?? "",
      provider: jsonValue["provider"]?.stringValue ?? "",
      isDefault: jsonValue["isDefault"] == .bool(true),
      hasAvatar: jsonValue["hasAvatar"] == .bool(true),
      canonical: jsonValue["canonical"].flatMap(CanonicalSession.init(jsonValue:)),
      uiMetaRevision: jsonValue["uiMetaRevision"]?.doubleValue.flatMap { Int(exactly: $0) } ?? 0
    )
  }
}

/// One message the reader sent while a turn was already running (`QueuedMessage`).
///
/// Held here rather than on the gateway: `prompt.submit` would park it, but
/// nothing could read it back, change it or take it out again, and Steer, Edit
/// and Delete are exactly what a reader does with a parked message.
public struct QueuedMessage: Sendable, Hashable, Identifiable {
  public var id: String
  public var text: String
  /// `@file:` / `@image:` references, as a sent message shows them.
  public var attachments: [String]?

  public init(id: String, text: String, attachments: [String]? = nil) {
    self.id = id
    self.text = text
    self.attachments = attachments
  }
}

/// What one chat screen draws, published at most once per frame.
///
/// Derived values only: the store keeps the `ChatState` to itself, so the next
/// delta it applies never has to copy a transcript a view is still holding.
public struct ChatSnapshot: Sendable, Equatable {
  /// The chat's key: the bot's name.
  public var key: String
  /// `visibleItems` at the observer's options.
  public var items: [VisibleItem]
  public var hydration: HydrationState
  /// `isBusy`: a turn is running or a request is open.
  public var busy: Bool
  /// A turn is running (the composer's Stop).
  public var turnActive: Bool
  public var activity: TurnActivity
  /// The approval and clarify cards still waiting for an answer.
  public var openRequests: [TranscriptItem]
  /// Messages parked behind the running turn, oldest first.
  public var queue: [QueuedMessage]
  /// The runtime session is bound: the chat can send.
  public var attached: Bool
  /// Older history may exist before the first item.
  public var canLoadOlder: Bool
  /// Bumped on every publish of this chat.
  public var revision: Int
  /// The session skips approval requests (`session.info.yolo`).
  public var yolo: Bool = false
  /// Fast mode, reasoning effort, model and context usage, as the gateway last said.
  public var options = ChatSessionOptions()
  /// The children of a delegation, parents first (`SubagentRow.rows`): the agents bar's list. Empty
  /// when nothing was delegated.
  public var subagents: [SubagentRow] = []
}

/// One chat-list row's worth of a chat, recomputed only for chats that changed.
public struct ChatSummary: Sendable, Equatable {
  public var key: String
  /// `chatRowPreview` over the transcript; `nil` when the transcript has nothing
  /// to offer (the list then falls back to the roster's preview).
  public var preview: ChatPreview?
  /// `unreadCountSince` against the read watermark.
  public var unread: Int
  /// An approval or clarify is open.
  public var needsInput: Bool
  public var busy: Bool
  public var hydration: HydrationState
  public var attached: Bool
  /// `lastMessageAt`, unix seconds.
  public var lastMessageAt: Double
  /// The approvals, questions and interactive cards open in this chat, oldest first: what a local
  /// notification needs (`RequestAlerts`), for a chat no screen observes too.
  public var asks: [OpenAsk] = []
}

/// One request open on a chat's transcript (an approval, a clarify question or an interactive card),
/// reduced to what a notification may be built from. No answer, no choices, no field and no detail.
public struct OpenAsk: Sendable, Equatable {
  /// The wire method (`PushRequestMethod`).
  public var method: String
  /// An approval's queue id (what `approval.pending` lists and a remote push carries); every other
  /// request's `srq-…` id.
  public var requestId: String
  /// An approval's own description or a clarify's first question: one cleaned and bounded line, for a
  /// notification when the reader allowed previews. Empty for an interactive card.
  public var text: String

  public init(method: String, requestId: String, text: String = "") {
    self.method = method
    self.requestId = requestId
    self.text = text
  }

  /// The longest line kept.
  public static let textLimit = 200

  /// What a transcript item that waits for the person says, or nil for any other item.
  public static func of(_ item: TranscriptItem) -> OpenAsk? {
    switch item {
    case .approval(let approval):
      OpenAsk(
        method: "approval",
        requestId: approval.approvalID.isEmpty ? approval.requestID : approval.approvalID,
        text: InteractivePrompt.line(approval.description, limit: textLimit)
      )
    case .clarify(let clarify):
      OpenAsk(
        method: "clarify",
        requestId: clarify.requestID,
        text: InteractivePrompt.line(clarify.questions.first?.question, limit: textLimit)
      )
    case .request(let request):
      OpenAsk(method: request.method, requestId: request.requestID)
    default:
      nil
    }
  }
}

/// Everything that changed between two frames, delivered to the main actor in one hop.
public struct FrameBatch: Sendable {
  /// Fresh snapshots of the chats a screen observes and that changed.
  public var chats: [String: ChatSnapshot] = [:]
  /// Fresh list summaries of every chat that changed.
  public var summaries: [String: ChatSummary] = [:]
  /// Chats the store no longer holds.
  public var removed: [String] = []

  public var isEmpty: Bool { chats.isEmpty && summaries.isEmpty && removed.isEmpty }
}

/// Where a page of older history came out (`loadOlder`'s three-valued answer).
public enum OlderHistory: Sendable, Equatable {
  /// Loaded, and the transcript grew (or might grow on the next page).
  case grew
  /// Nothing older exists.
  case start
  /// This gateway cannot page (no REST transcript); everything it has is already here.
  case unavailable
}

/// What the gateway's Hermie plugin says it can do (`plugin.ts`), reduced to
/// the capability strings the runtime asks about.
public enum PluginCapabilities {
  /// The `ui_meta` key the plugin publishes its advert under.
  public static let advertKey = "hermie-plugin"
  /// The advert shape this build understands; anything newer is ignored whole.
  public static let contractVersion = 1
  /// `context.turn_claim`: the plugin reads a claim on the next turn.
  public static let contextTurnClaim = "context.turn_claim"

  /// `pluginAdvert` + `hasPluginCapability`: the capabilities off a
  /// `profiles.list` answer, the default profile's advert winning, else the
  /// first. No advert, or one newer than this build reads, offers nothing.
  public static func of(_ rows: [JSONValue]) -> Set<String> {
    advert(in: rows)?.capabilities ?? []
  }

  /// The advert itself off a `profiles.list` answer (the default profile's winning, else the first),
  /// or nil when the roster carries none this build reads: the plugin is not there (`PluginPresence`).
  public static func advert(in rows: [JSONValue]) -> PluginAdvert? {
    var found: PluginAdvert?

    for row in rows {
      guard let advert = advert(of: row["ui_meta"]?[advertKey]) else {
        continue
      }

      if row["is_default"] == .bool(true) {
        return advert
      }

      found = found ?? advert
    }

    return found
  }

  static func capabilities(of advert: JSONValue?) -> Set<String>? {
    Self.advert(of: advert)?.capabilities
  }

  static func advert(of value: JSONValue?) -> PluginAdvert? {
    guard case .object(let object)? = value, case .number(let version)? = object["v"],
      version.rounded() == version, version >= 1, version <= Double(contractVersion)
    else {
      return nil
    }

    return PluginAdvert(
      version: object["version"]?.stringValue ?? "",
      capabilities: Set((object["capabilities"]?.arrayValue ?? []).compactMap(\.stringValue)))
  }
}

/// What the gateway's Hermie plugin published about itself (`PluginAdvert` in `plugin.ts`): its
/// release, shown and never compared against, and what it can do, each a string a client asks for.
public struct PluginAdvert: Sendable, Equatable {
  /// The plugin's release version. Empty when the advert named none.
  public var version: String
  public var capabilities: Set<String>

  public init(version: String = "", capabilities: Set<String> = []) {
    self.version = version
    self.capabilities = capabilities
  }
}

/// Whether the gateway's plugin is there, which is what decides whether notifications can come from
/// the gateway at all (`pluginPresence` in the Expo app's `store/plugin.ts`). Three states, kept
/// apart on purpose: "not looked yet" must never be drawn as "not installed", the difference between
/// a screen that waits and one that sends somebody to a shell to install what they already have.
public enum PluginPresence: Sendable, Equatable {
  /// No roster has been read from the gateway on this connection yet.
  case unknown
  case installed(version: String)
  case absent
}
