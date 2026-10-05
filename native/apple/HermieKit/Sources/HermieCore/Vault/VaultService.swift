import Foundation
import HermieGateway
import HermieProtocol

/// What the Vault page asks of the gateway, as one seam: a test hands in a script, production a
/// `VaultService` over a session's link.
public protocol VaultBackend: Sendable {
  func list(profile: String) async throws -> [VaultItem]
  func sources(profile: String) async throws -> [VaultSource]
  /// Store an item. Answers the new item's id.
  func add(profile: String, _ request: VaultAddRequest) async throws -> String
  func remove(profile: String, id: String) async throws -> Bool
  /// Unlock a password manager with its master password.
  func unlock(profile: String, source: String, password: SecretValue) async throws
  /// Lock one password manager, or every one when `source` is nil.
  func lock(profile: String, source: String?) async throws
  func setSourceEnabled(profile: String, source: String, enabled: Bool) async throws
}

/**
 The gateway's vault methods (`tui_gateway/methods_vault.py`), over one session's link.

 **Every call names its profile.** Each handler binds `params.profile`'s HERMES_HOME and secret scope around
 its body, so the vault file, the password-manager settings and their session tokens are that bot's. A call
 without it would reach the profile the gateway was started with, which on a gateway serving several bots is
 another bot's vault; so `profile` is a parameter of every method here, never optional, and it is the bot's
 name. (A name the gateway does not serve is refused with 4064, never read as the launch profile.)

 **The params are exactly the contract's.** The gateway refuses a key it does not know (4000), so nothing else
 is sent.

 **A secret goes out once.** `add` and `unlock` write the secret into the call's params and nowhere else: no
 retry, no queue (the connection refuses a call while it is down rather than holding it), no log. What the
 gateway answers carries only ids and flags.
 */
public struct VaultService: VaultBackend {
  public enum Method {
    public static let list = "vault.list"
    public static let sources = "vault.sources"
    public static let sourceSet = "vault.source.set"
    public static let add = "vault.add"
    public static let remove = "vault.remove"
    public static let unlock = "vault.unlock"
    public static let lock = "vault.lock"
  }

  let link: any GatewayLink

  public init(link: any GatewayLink) {
    self.link = link
  }

  public func list(profile: String) async throws -> [VaultItem] {
    VaultItem.parseList(try await call(Method.list, ["profile": .string(profile)]))
  }

  public func sources(profile: String) async throws -> [VaultSource] {
    VaultSource.parseList(try await call(Method.sources, ["profile": .string(profile)]))
  }

  public func add(profile: String, _ request: VaultAddRequest) async throws -> String {
    let result = try await call(Method.add, Self.addParams(profile: profile, request), scrubbing: request.secretTexts)

    return result["id"]?.stringValue ?? ""
  }

  public func remove(profile: String, id: String) async throws -> Bool {
    let result = try await call(Method.remove, ["profile": .string(profile), "id": .string(id)])

    return result["removed"]?.boolValue ?? false
  }

  public func unlock(profile: String, source: String, password: SecretValue) async throws {
    _ = try await call(
      Method.unlock,
      ["profile": .string(profile), "name": .string(source), "password": .string(password.revealed)],
      scrubbing: [password.revealed]
    )
  }

  public func lock(profile: String, source: String?) async throws {
    var params: JSONObject = ["profile": .string(profile)]

    if let source {
      params["name"] = .string(source)
    }

    _ = try await call(Method.lock, params)
  }

  public func setSourceEnabled(profile: String, source: String, enabled: Bool) async throws {
    _ = try await call(
      Method.sourceSet, ["profile": .string(profile), "name": .string(source), "enabled": .bool(enabled)])
  }

  /// `vault.add`'s params: `kind`, `label`, `origin` (when there is one) and `secret`, which for a login also
  /// carries `identifier_type` and `identifier` (the gateway moves them into the item's metadata).
  static func addParams(profile: String, _ request: VaultAddRequest) -> JSONObject {
    var secret: JSONObject = [:]

    for (key, value) in request.secret where !value.isEmpty {
      secret[key] = .string(value.revealed)
    }

    if request.kind == .login {
      if let type = request.identifierType {
        secret["identifier_type"] = .string(type.rawValue)
      }

      if let identifier = request.identifier {
        secret["identifier"] = .string(identifier)
      }
    }

    var params: JSONObject = [
      "profile": .string(profile),
      "kind": .string(request.kind.rawValue),
      "label": .string(request.label),
      "secret": .object(secret)
    ]

    if let origin = request.origin, !origin.isEmpty {
      params["origin"] = .string(origin)
    }

    return params
  }

  private func call(_ method: String, _ params: JSONObject, scrubbing secrets: [String] = []) async throws
    -> JSONValue
  {
    do {
      return try await link.requestReply(method, params: .object(params)).result
    } catch {
      throw VaultFailure.classify(error, scrubbing: secrets)
    }
  }
}
