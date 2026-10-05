import Foundation
import HermieGateway
import HermieProtocol

/// How a profile treats dangerous commands (`approvals.mode`, as `approval.grants` says it).
public enum ApprovalMode: Sendable, Equatable, Hashable {
  /// Every dangerous command waits for the person's answer.
  case manual
  /// A second model judges each one: low-risk goes through, dangerous is refused, uncertain asks.
  case smart
  /// Nothing asks.
  case off
  /// A mode this build does not know, as the gateway named it (cleaned for display).
  case other(String)

  init(_ raw: String) {
    switch raw {
    case "manual": self = .manual
    case "smart": self = .smart
    case "off": self = .off
    default: self = .other(CapabilityText.line(raw, limit: 40))
    }
  }
}

/// What a standing approval is, for display only (`ApprovalGrantKind`).
public enum PermissionGrantKind: Sendable, Equatable, Hashable {
  /// A dangerous-pattern rule, what an "always" answer stores.
  case pattern
  /// Exact command text.
  case command
  /// A shell-style wildcard over command text.
  case glob
  /// A kind this build does not know.
  case other

  init(_ raw: String?) {
    switch raw {
    case "pattern": self = .pattern
    case "command": self = .command
    case "glob": self = .glob
    default: self = .other
    }
  }
}

/**
 One approval the gateway holds, standing or for one session.

 `id` is opaque: the gateway recomputes it on a revoke, so the app never sends command text back and never
 reads anything into the id. `label` is every rule the grant approves, joined with `"; "` when there are
 several, already redacted by the gateway; the app shows it as plain text and does not take it apart.
 */
public struct PermissionGrant: Sendable, Equatable, Hashable, Identifiable {
  public var id: String
  public var kind: PermissionGrantKind
  public var label: String
  /// A content-security finding (session grants only; those are never permanent).
  public var tirith: Bool

  public init(id: String, kind: PermissionGrantKind = .pattern, label: String, tirith: Bool = false) {
    self.id = id
    self.kind = kind
    self.label = label
    self.tirith = tirith
  }

  /// The longest label kept, in characters, the ellipsis included: a grant can name several rules.
  public static let labelLimit = 1_000
  /// The longest id kept (the gateway's own are `perm:` or `sess:` and sixteen hex digits).
  public static let idLimit = 100
  /// The most grants read in one list.
  public static let listLimit = 500

  static func parse(_ value: JSONValue) -> PermissionGrant? {
    guard let id = value["id"]?.stringValue, !id.isEmpty, id.count <= idLimit else {
      return nil
    }

    return PermissionGrant(
      id: id,
      kind: PermissionGrantKind(value["kind"]?.stringValue),
      label: CapabilityText.line(value["label"]?.stringValue ?? "", limit: labelLimit - 1),
      tirith: value["tirith"]?.boolValue ?? false
    )
  }

  /// A list of rows, at most `listLimit`, without the ones with no id and without a repeated id.
  static func parseList(_ value: JSONValue?) -> [PermissionGrant] {
    var seen: Set<String> = []
    var grants: [PermissionGrant] = []

    for row in value?.arrayValue ?? [] {
      guard grants.count < listLimit else {
        break
      }

      if let grant = parse(row), seen.insert(grant.id).inserted {
        grants.append(grant)
      }
    }

    return grants
  }
}

/// One live session of the profile that holds a session approval or has YOLO on.
public struct SessionPermissions: Sendable, Equatable, Hashable, Identifiable {
  /// The runtime session id: what a session revoke names.
  public var sessionID: String
  /// The stored session id (the gateway's `session_key`), which is how a chat's own session is told from another.
  public var sessionKey: String
  /// The session's own bypass. It is switched in the chat's options, not revoked here.
  public var yolo: Bool
  public var grants: [PermissionGrant]

  public var id: String { sessionID }

  public init(sessionID: String, sessionKey: String = "", yolo: Bool, grants: [PermissionGrant]) {
    self.sessionID = sessionID
    self.sessionKey = sessionKey
    self.yolo = yolo
    self.grants = grants
  }

  /// The most sessions read in one list.
  public static let listLimit = 100

  static func parseList(_ value: JSONValue?) -> [SessionPermissions] {
    var seen: Set<String> = []
    var sessions: [SessionPermissions] = []

    for row in value?.arrayValue ?? [] {
      guard sessions.count < listLimit, let id = row["session_id"]?.stringValue, !id.isEmpty,
        id.count <= PermissionGrant.idLimit, seen.insert(id).inserted
      else {
        continue
      }

      sessions.append(
        SessionPermissions(
          sessionID: id, sessionKey: CapabilityText.line(row["session_key"]?.stringValue, limit: PermissionGrant.idLimit),
          yolo: row["yolo"]?.boolValue ?? false, grants: PermissionGrant.parseList(row["grants"])))
    }

    return sessions
  }
}

/// What `approval.grants` answers for one profile.
public struct PermissionsSnapshot: Sendable, Equatable {
  public var mode: ApprovalMode
  /// The standing ("always") approvals.
  public var permanent: [PermissionGrant]
  public var sessions: [SessionPermissions]

  public init(mode: ApprovalMode = .manual, permanent: [PermissionGrant] = [], sessions: [SessionPermissions] = []) {
    self.mode = mode
    self.permanent = permanent
    self.sessions = sessions
  }

  /// How many approvals there are in all: the standing ones and every session's.
  public var count: Int {
    permanent.count + sessions.reduce(0) { $0 + $1.grants.count }
  }

  public static func parse(_ result: JSONValue) -> PermissionsSnapshot {
    PermissionsSnapshot(
      mode: ApprovalMode(result["mode"]?.stringValue ?? "manual"),
      permanent: PermissionGrant.parseList(result["permanent"]),
      sessions: SessionPermissions.parseList(result["sessions"])
    )
  }
}

/// Where a revoke reaches (`approval.revoke`'s `scope`).
public enum PermissionScope: Sendable, Equatable, Hashable {
  /// The profile's standing approvals.
  case permanent
  /// One live session's approvals, by its runtime session id.
  case session(String)
}

/// What a revoke takes back.
public enum PermissionTarget: Sendable, Equatable, Hashable {
  case one(String)
  case all
}

/// Why a permissions call did not go through, sorted by what the page should do about it.
public enum PermissionFailure: Error, Sendable, Equatable {
  /// The gateway has no such method (an older one).
  case unsupported
  /// No connection to ask over.
  case offline
  /// The answer did not come in time. A revoke may still have gone through, so the page reads the lists again.
  case timedOut
  /// The gateway does not let this connection do that (an agent's connection: 4033).
  case refused
  /// The gateway does not serve this bot's profile (4064).
  case unknownProfile
  /// The session is not live any more, or is not this connection's to touch (4001).
  case sessionGone
  /// The gateway said no, in its own words (untrusted text, cleaned).
  case failed(String)

  public var detail: String? {
    if case .failed(let message) = self, !message.isEmpty { message } else { nil }
  }

  /// Sort anything a permissions call can throw.
  public static func classify(_ error: any Error) -> PermissionFailure {
    if let failure = error as? PermissionFailure {
      return failure
    }

    if let rpc = error as? GatewayRPCError {
      switch rpc.kind {
      case .notConnected, .closed: return .offline
      case .timeout: return .timedOut
      case .rejected:
        switch rpc.code {
        case -32601: return .unsupported
        case 4033: return .refused
        case 4064: return .unknownProfile
        case 4001: return .sessionGone
        default: return .failed(CapabilityText.line(rpc.message))
        }
      case .unencodable, .unexpectedResult: return .failed(CapabilityText.line(rpc.message))
      }
    }

    if error is CancellationError {
      return .offline
    }

    return .failed(CapabilityText.line(ChatResolver.describe(error)))
  }
}
