import HermieProtocol

/// A closed TypeScript string union, kept open: a spelling this build has never
/// heard of decodes as `.other(raw)` and re-encodes unchanged, so a state written by
/// a newer engine survives a round trip through an older one.
///
/// The fallback is `.other` rather than `HermieProtocol`'s `.unknown` because two of
/// these unions (`ToolStatus`, `DispatchStatus`) have a real member spelled
/// `unknown`. Build values with `init(rawValue:)`, so a known spelling always lands
/// on its named case (`.other("live")` is not `.live`).
public protocol OpenVocabulary: TranscriptJSONCodable, Hashable, RawRepresentable, CustomStringConvertible
where RawValue == String {
  static var knownCases: [Self] { get }
  static func other(_ rawValue: String) -> Self
}

extension OpenVocabulary {
  public init(rawValue: String) {
    self = Self.named(rawValue)
  }

  /// The named case for `rawValue`, else `.other(rawValue)`.
  public static func named(_ rawValue: String) -> Self {
    knownCases.first { JS.same($0.rawValue, rawValue) } ?? .other(rawValue)
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    guard case .string(let raw) = json else {
      throw TranscriptDecodingError(path: path, message: "expected a \(Self.self) string, found \(JSONKind.of(json))")
    }
    self = Self.named(raw)
  }

  public var jsonValue: JSONValue { .string(rawValue) }
  public var description: String { rawValue }
  /// A spelling this build knows.
  public var isKnown: Bool { Self.knownCases.contains(self) }
}

/// Client-side verbosity filter. Purely a read-time concern.
public enum Verbosity: OpenVocabulary {
  case quiet, normal, verbose
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [Verbosity] = [.quiet, .normal, .verbose]

  public var rawValue: String {
    switch self {
    case .quiet: "quiet"
    case .normal: "normal"
    case .verbose: "verbose"
    case .other(let raw): raw
    }
  }
}

/// Where an item came from, which decides what reconciliation may drop.
/// `history` is persisted, `live` arrived on the socket, `optimistic` is a local
/// submit not yet echoed, `inflight` was rebuilt from a resume snapshot and
/// `foreign` is a placeholder for a turn somebody else (a teammate bot, another
/// surface) started in this session.
public enum ItemOrigin: OpenVocabulary {
  case history, live, optimistic, inflight, foreign
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [ItemOrigin] = [.history, .live, .optimistic, .inflight, .foreign]

  public var rawValue: String {
    switch self {
    case .history: "history"
    case .live: "live"
    case .optimistic: "optimistic"
    case .inflight: "inflight"
    case .foreign: "foreign"
    case .other(let raw): raw
    }
  }
}

/// `UserItem.displayKind`.
public enum UserDisplayKind: OpenVocabulary {
  case skillInvocation, steer
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [UserDisplayKind] = [.skillInvocation, .steer]

  public var rawValue: String {
    switch self {
    case .skillInvocation: "skill_invocation"
    case .steer: "steer"
    case .other(let raw): raw
    }
  }
}

/// `AssistantItem.status`.
public enum AssistantStatus: OpenVocabulary {
  case complete, error, interrupted
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [AssistantStatus] = [.complete, .error, .interrupted]

  public var rawValue: String {
    switch self {
    case .complete: "complete"
    case .error: "error"
    case .interrupted: "interrupted"
    case .other(let raw): raw
    }
  }
}

/// `ToolStatus`.
public enum ToolStatus: OpenVocabulary {
  case generating, running, complete, error, unknown
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [ToolStatus] = [.generating, .running, .complete, .error, .unknown]

  public var rawValue: String {
    switch self {
    case .generating: "generating"
    case .running: "running"
    case .complete: "complete"
    case .error: "error"
    case .unknown: "unknown"
    case .other(let raw): raw
    }
  }
}

/// `DispatchStatus` (and the bot-DM parser's `DmDispatchStatus`, the same union).
public enum DispatchStatus: OpenVocabulary {
  case sending, queued, failed, ambiguous, unknown
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [DispatchStatus] = [.sending, .queued, .failed, .ambiguous, .unknown]

  public var rawValue: String {
    switch self {
    case .sending: "sending"
    case .queued: "queued"
    case .failed: "failed"
    case .ambiguous: "ambiguous"
    case .unknown: "unknown"
    case .other(let raw): raw
    }
  }
}

/// `SubagentGroupStatus`.
public enum SubagentGroupStatus: OpenVocabulary {
  case dispatched, running, done, failed
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [SubagentGroupStatus] = [.dispatched, .running, .done, .failed]

  public var rawValue: String {
    switch self {
    case .dispatched: "dispatched"
    case .running: "running"
    case .done: "done"
    case .failed: "failed"
    case .other(let raw): raw
    }
  }
}

/// `SubagentStreamKind`.
public enum SubagentStreamKind: OpenVocabulary {
  case progress, tool, thinking, summary
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [SubagentStreamKind] = [.progress, .tool, .thinking, .summary]

  public var rawValue: String {
    switch self {
    case .progress: "progress"
    case .tool: "tool"
    case .thinking: "thinking"
    case .summary: "summary"
    case .other(let raw): raw
    }
  }
}

/// `NoticeKind`. Also the `InjectedNoticeKind` subset `parseInjectedRow` answers with.
public enum NoticeKind: OpenVocabulary {
  /// The answer to a slash command the owner typed.
  ///
  /// Not the machine narrating itself: it is the PAYLOAD of something somebody
  /// asked for, which is why `selectors.ts` keeps it at every verbosity level and
  /// `NoticePill` opens it without being asked. Live-only — command output is
  /// never persisted, so no history row ever projects onto this kind.
  case command
  case modelSwitch, personalitySwitch, autoContinue, processComplete, asyncDelegationComplete, internalNotification
  /// A `[System: …]` note nothing labelled, its wrapper already taken off.
  case systemNote
  case error, notice, reclaimed, unknownDisplayKind
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [NoticeKind] = [
    .command, .modelSwitch, .personalitySwitch, .autoContinue, .processComplete, .asyncDelegationComplete,
    .internalNotification, .systemNote, .error, .notice, .reclaimed, .unknownDisplayKind
  ]

  public var rawValue: String {
    switch self {
    case .command: "command"
    case .modelSwitch: "model_switch"
    case .personalitySwitch: "personality_switch"
    case .autoContinue: "auto_continue"
    case .processComplete: "process_complete"
    case .asyncDelegationComplete: "async_delegation_complete"
    case .internalNotification: "internal_notification"
    case .systemNote: "system_note"
    case .error: "error"
    case .notice: "notice"
    case .reclaimed: "reclaimed"
    case .unknownDisplayKind: "unknown_display_kind"
    case .other(let raw): raw
    }
  }
}

/// Which of the two cron headers matched. `bot_chat` is an injected inbound turn.
public enum CronDeliveryShape: OpenVocabulary {
  case botChat, mirror
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [CronDeliveryShape] = [.botChat, .mirror]

  public var rawValue: String {
    switch self {
    case .botChat: "bot_chat"
    case .mirror: "mirror"
    case .other(let raw): raw
    }
  }
}

/// `RequestState`, of an approval or a clarify.
public enum RequestState: OpenVocabulary {
  case open, answered, cancelled
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [RequestState] = [.open, .answered, .cancelled]

  public var rawValue: String {
    switch self {
    case .open: "open"
    case .answered: "answered"
    case .cancelled: "cancelled"
    case .other(let raw): raw
    }
  }
}

/// `HydrationState`.
public enum HydrationState: OpenVocabulary {
  case cold, cached, hydrating, live, stale, error
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [HydrationState] = [.cold, .cached, .hydrating, .live, .stale, .error]

  public var rawValue: String {
    switch self {
    case .cold: "cold"
    case .cached: "cached"
    case .hydrating: "hydrating"
    case .live: "live"
    case .stale: "stale"
    case .error: "error"
    case .other(let raw): raw
    }
  }
}

/// `TranscriptItemKind`: the `kind` every item carries.
public enum TranscriptItemKind: OpenVocabulary {
  case approval, assistant, botDmIn, botDmOut, clarify, cronDelivery, notice, status, subagentGroup, tool, user
  case other(String)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public static let knownCases: [TranscriptItemKind] = [
    .approval, .assistant, .botDmIn, .botDmOut, .clarify, .cronDelivery, .notice, .status, .subagentGroup, .tool,
    .user
  ]

  public var rawValue: String {
    switch self {
    case .approval: "approval"
    case .assistant: "assistant"
    case .botDmIn: "bot_dm_in"
    case .botDmOut: "bot_dm_out"
    case .clarify: "clarify"
    case .cronDelivery: "cron_delivery"
    case .notice: "notice"
    case .status: "status"
    case .subagentGroup: "subagent_group"
    case .tool: "tool"
    case .user: "user"
    case .other(let raw): raw
    }
  }
}

extension Verbosity: JSONField {}
extension ItemOrigin: JSONField {}
extension UserDisplayKind: JSONField {}
extension AssistantStatus: JSONField {}
extension ToolStatus: JSONField {}
extension DispatchStatus: JSONField {}
extension SubagentGroupStatus: JSONField {}
extension SubagentStreamKind: JSONField {}
extension NoticeKind: JSONField {}
extension CronDeliveryShape: JSONField {}
extension RequestState: JSONField {}
extension HydrationState: JSONField {}
extension TranscriptItemKind: JSONField {}
