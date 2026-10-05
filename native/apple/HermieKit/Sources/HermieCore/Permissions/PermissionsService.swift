import Foundation
import HermieGateway
import HermieProtocol

/// What the Permissions page asks of the gateway, as one seam: a test hands in a script, production a
/// `PermissionsService` over a session's link.
public protocol PermissionsBackend: Sendable {
  func grants(profile: String) async throws -> PermissionsSnapshot
  /// Take approvals back. Answers how many entries the gateway removed (0 when the id no longer names a grant).
  func revoke(profile: String, scope: PermissionScope, target: PermissionTarget) async throws -> Int
}

/**
 The gateway's approval methods (`tui_gateway/methods_prompt.py`, `approval.grants` and `approval.revoke`),
 over one session's link.

 **Every call names its profile.** The gateway reads and revokes the standing approvals of the profile a call
 names; without it, of the profile it was started with, which on a gateway serving several bots is another
 bot's. So `profile` is the bot's name on every call here, never left out. (A name the gateway does not serve is
 refused with 4064, never read as the launch profile.)

 **The params are exactly the contract's.** The gateway refuses a key it does not know (4000), and a revoke
 takes exactly one of `id` or `all`: `all` is sent as `true` and never as `false`, and `session_id` only for a
 session scope.

 **Nothing but the opaque id goes back.** A grant is named by the id the gateway gave, which it recomputes on a
 revoke; no command text travels again.
 */
public struct PermissionsService: PermissionsBackend {
  public enum Method {
    public static let grants = "approval.grants"
    public static let revoke = "approval.revoke"
  }

  let link: any GatewayLink

  public init(link: any GatewayLink) {
    self.link = link
  }

  public func grants(profile: String) async throws -> PermissionsSnapshot {
    PermissionsSnapshot.parse(try await call(Method.grants, Self.grantsParams(profile: profile)))
  }

  public func revoke(profile: String, scope: PermissionScope, target: PermissionTarget) async throws -> Int {
    let result = try await call(Method.revoke, Self.revokeParams(profile: profile, scope: scope, target: target))

    return max(0, result["revoked"]?.intValue ?? 0)
  }

  /// `approval.grants`'s params: the profile, and nothing else (every live session of it the connection may see).
  static func grantsParams(profile: String) -> JSONObject {
    ["profile": .string(profile)]
  }

  /// `approval.revoke`'s params: `scope`, one of `id` or `all`, the profile, and for a session the session.
  static func revokeParams(profile: String, scope: PermissionScope, target: PermissionTarget) -> JSONObject {
    var params: JSONObject = ["profile": .string(profile)]

    switch scope {
    case .permanent:
      params["scope"] = .string("permanent")
    case .session(let id):
      params["scope"] = .string("session")
      params["session_id"] = .string(id)
    }

    switch target {
    case .one(let id): params["id"] = .string(id)
    case .all: params["all"] = .bool(true)
    }

    return params
  }

  private func call(_ method: String, _ params: JSONObject) async throws -> JSONValue {
    do {
      return try await link.requestReply(method, params: .object(params)).result
    } catch {
      throw PermissionFailure.classify(error)
    }
  }
}
