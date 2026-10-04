import Foundation

// The `confirm` server request (`tui_gateway/contracts/server_requests.py`) and the level `passkey`
// it carries (`contract/confirm-passkey/README.md` §8). The gateway builds and bounds every string;
// a client renders title, summary and detail verbatim (the detail with its whitespace kept) and
// never lets them style its own frame.

/// `ConfirmLevel`: what a confirmation proves. `plain` is a tap and proves nothing; `passkey` is a
/// WebAuthn assertion the gateway verifies itself.
public enum ConfirmLevel: OpenStringEnum {
  case plain, passkey
  case unknown(String)

  public static let knownCases: [ConfirmLevel] = [.plain, .passkey]

  public var rawValue: String {
    switch self {
    case .plain: "plain"
    case .passkey: "passkey"
    case .unknown(let raw): raw
    }
  }
}

/// `ConfirmDecision`.
public enum ConfirmDecision: OpenStringEnum {
  case confirmed, declined
  case unknown(String)

  public static let knownCases: [ConfirmDecision] = [.confirmed, .declined]

  public var rawValue: String {
    switch self {
    case .confirmed: "confirmed"
    case .declined: "declined"
    case .unknown(let raw): raw
    }
  }
}

/// `ConfirmMethod`: how the client obtained the decision. Every decline is a `tap`.
public enum ConfirmMethod: OpenStringEnum {
  case tap, passkey
  case unknown(String)

  public static let knownCases: [ConfirmMethod] = [.tap, .passkey]

  public var rawValue: String {
    switch self {
    case .tap: "tap"
    case .passkey: "passkey"
    case .unknown(let raw): raw
    }
  }
}

/// The `confirm` server request's params. At level `passkey` the `passkey` object says what the
/// client needs to compute the challenge and run the ceremony.
public struct ConfirmRequestParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var sessionID: String? { get { json[field: "session_id"] } set { json[field: "session_id"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var summary: String? { get { json[field: "summary"] } set { json[field: "summary"] = newValue } }
  /// Absent, `null` and `""` mean the same (contract §4).
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
  public var level: ConfirmLevel? { get { json[field: "level"] } set { json[field: "level"] = newValue } }
  public var passkey: ConfirmPasskeyParams? { get { json[field: "passkey"] } set { json[field: "passkey"] = newValue } }
  /// The structured fields (contract/confirm-passkey §4.1), as the wire has them. An element that is
  /// not an object is dropped here: whether the request may be shown at all is decided by
  /// `ConfirmFieldRules.read` over the raw JSON, which refuses it instead.
  public var fields: [ConfirmFieldView]? { get { json[field: "fields"] } set { json[field: "fields"] = newValue } }
}

/// One key fact of a `confirm` (contract/confirm-passkey §4.1): `id`, `kind`, `label`, `value` and, for an
/// amount, `currency`. A view over the wire object; the strict reading is `ConfirmFieldRules`.
public struct ConfirmFieldView: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The keys the contract gives a field. Another key makes the frame one this build does not show.
  public static let knownKeys: Set<String> = ["id", "kind", "label", "value", "currency"]

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var kind: String? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var label: String? { get { json[field: "label"] } set { json[field: "label"] = newValue } }
  public var value: String? { get { json[field: "value"] } set { json[field: "value"] = newValue } }
  public var currency: String? { get { json[field: "currency"] } set { json[field: "currency"] = newValue } }
}

/// `ConfirmPasskeyParams`: level `passkey` only. `nonce` (32 bytes) and `gateway_id` (16 bytes) are
/// base64url; `base_url` is informative (a client always hashes the base URL it dialed);
/// `expires_at` is Unix seconds.
public struct ConfirmPasskeyParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  public var nonce: String? { get { json[field: "nonce"] } set { json[field: "nonce"] = newValue } }
  public var gatewayID: String? { get { json[field: "gateway_id"] } set { json[field: "gateway_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  public var user: ConfirmPasskeyUser? { get { json[field: "user"] } set { json[field: "user"] = newValue } }
  public var credentials: [PasskeyCredentialIDs]? {
    get { json[field: "credentials"] }
    set { json[field: "credentials"] = newValue }
  }
}

/// `ConfirmPasskeyUser`: the person the request is bound to, `<provider>:<user id>`.
public struct ConfirmPasskeyUser: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
}

/// One RP's credential ids (base64url): a `confirm` frame's `passkey.credentials` and a step-up's
/// `credentials`. A client passes the ones for its own RP as `allowCredentials`.
public struct PasskeyCredentialIDs: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(rpID: String, ids: [String]) {
    self.init()
    self.rpID = rpID
    self.ids = ids
  }

  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
  public var ids: [String]? { get { json[field: "ids"] } set { json[field: "ids"] = newValue } }
}

/// `ConfirmPasskeyAssertion`: a WebAuthn assertion as the gateway checks it (contract §8, §9). The
/// `passkey` object of a confirm answer, and a step-up's `assertion`. Binary fields are base64url.
///
/// Not a secret, but tied to one request: its description and mirror show none of it, so it never
/// lands in a log by accident.
public struct PasskeyAssertion: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(
    rpID: String,
    baseURL: String,
    credentialID: String,
    authenticatorData: String,
    clientDataJSON: String,
    signature: String,
    userHandle: String? = nil,
    version: Int = 1
  ) {
    self.init()
    // Repeats the request's own `passkey.v`: 1, or 2 for a request with structured fields.
    self.v = version
    self.rpID = rpID
    self.baseURL = baseURL
    self.credentialID = credentialID
    self.authenticatorData = authenticatorData
    self.clientDataJSON = clientDataJSON
    self.signature = signature
    self.userHandle = userHandle
  }

  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var credentialID: String? { get { json[field: "credential_id"] } set { json[field: "credential_id"] = newValue } }
  public var authenticatorData: String? {
    get { json[field: "authenticator_data"] }
    set { json[field: "authenticator_data"] = newValue }
  }
  public var clientDataJSON: String? {
    get { json[field: "client_data_json"] }
    set { json[field: "client_data_json"] = newValue }
  }
  public var signature: String? { get { json[field: "signature"] } set { json[field: "signature"] = newValue } }
  public var userHandle: String? { get { json[field: "user_handle"] } set { json[field: "user_handle"] = newValue } }

  public var description: String { "PasskeyAssertion(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// `ConfirmResult`: the person's decision. A client never sends `verified`: the gateway decides it.
///
/// Level `passkey` takes exactly two shapes, built by `confirmed(_:)` and `declined`; there is no
/// setter for `verified` on purpose.
public struct ConfirmResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `{decision: "confirmed", method: "passkey", passkey: {...}}`.
  public static func confirmed(_ assertion: PasskeyAssertion) -> ConfirmResult {
    ConfirmResult(json: [
      "decision": ConfirmDecision.confirmed.jsonValue,
      "method": ConfirmMethod.passkey.jsonValue,
      "passkey": assertion.jsonValue
    ])
  }

  /// Exactly `{decision: "declined", method: "tap"}`: no assertion, nothing else.
  public static var declined: ConfirmResult {
    ConfirmResult(json: ["decision": ConfirmDecision.declined.jsonValue, "method": ConfirmMethod.tap.jsonValue])
  }

  public var decision: ConfirmDecision? { json[field: "decision"] }
  public var method: ConfirmMethod? { json[field: "method"] }
  public var passkey: PasskeyAssertion? { json[field: "passkey"] }
  /// Read only: present on a gateway's outcome, never on a client's answer.
  public var verified: Bool? { json[field: "verified"] }
}

// MARK: - Capabilities (contract §8)

/// `kind` of a passkey advertisement: the native apps' shared RP or a browser's own host.
public enum PasskeyRPKind: OpenStringEnum {
  case native, web
  case unknown(String)

  public static let knownCases: [PasskeyRPKind] = [.native, .web]

  public var rawValue: String {
    switch self {
    case .native: "native"
    case .web: "web"
    case .unknown(let raw): raw
    }
  }
}

/// The RPs a gateway accepts, per kind.
public struct PasskeyRPLists: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var native: [String]? { get { json[field: "native"] } set { json[field: "native"] = newValue } }
  public var web: [String]? { get { json[field: "web"] } set { json[field: "web"] = newValue } }

  /// The list for `kind`; empty for a kind this build does not know.
  public func ids(for kind: PasskeyRPKind) -> [String] {
    switch kind {
    case .native: native ?? []
    case .web: web ?? []
    case .unknown: []
    }
  }
}

/// `confirm_passkey` in a `client.capabilities` result: the level as this connection sees it.
/// `reason` is `""` when enabled, else `disabled`, `no_base_url`, `private_origin` or `no_identity`.
public struct ConfirmPasskeyCapability: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  public var enabled: Bool? { get { json[field: "enabled"] } set { json[field: "enabled"] = newValue } }
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
  public var gatewayID: String? { get { json[field: "gateway_id"] } set { json[field: "gateway_id"] = newValue } }
  public var rp: PasskeyRPLists? { get { json[field: "rp"] } set { json[field: "rp"] = newValue } }
  /// The `confirm_passkey.v` values the gateway accepts in the second call (absent from a gateway that knows
  /// version 1 only). 2 also computes `text_digest_v2` for a `confirm` with structured fields.
  public var versions: [Int]? { get { json[field: "versions"] } set { json[field: "versions"] = newValue } }
}

/// `confirm_passkey` in the second `client.capabilities` call: which RP this client asserts under.
public struct ConfirmPasskeyAdvertisement: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `version` 2 says this client computes `text_digest_v2` for a request with structured fields; it is
  /// sent only together with `confirm_fields: true` (contract/confirm-passkey §8).
  public init(kind: PasskeyRPKind, rpID: String, version: Int = 1) {
    self.init()
    self.v = version
    self.kind = kind
    self.rpID = rpID
  }

  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  public var kind: PasskeyRPKind? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
}

extension ClientCapabilitiesParams {
  /// `confirm_fields: true`: this connection shows a `confirm`'s structured `fields`. Sent in the second call
  /// when the first result carried the key `confirm_fields`; only exactly `true` counts.
  public var confirmFields: Bool? { get { json[field: "confirm_fields"] } set { json[field: "confirm_fields"] = newValue } }
  /// The `confirm` levels this connection can perform (second call only).
  public var confirm: [ConfirmLevel]? { get { json[field: "confirm"] } set { json[field: "confirm"] = newValue } }
  /// Sent only beside `confirm` listing `passkey`, and only to a gateway whose first result
  /// carried `confirm_passkey` (an older one refuses the unknown key with 4000).
  public var confirmPasskey: ConfirmPasskeyAdvertisement? {
    get { json[field: "confirm_passkey"] }
    set { json[field: "confirm_passkey"] = newValue }
  }
}

extension ClientCapabilitiesResult {
  /// Always present from a gateway that knows structured fields (contract/confirm-passkey §4.1, §8); `true`
  /// once it accepted this connection's own `confirm_fields: true`. Absent from an older gateway.
  public var confirmFields: Bool? { get { json[field: "confirm_fields"] } set { json[field: "confirm_fields"] = newValue } }
  /// The levels accepted from this connection, sorted.
  public var confirm: [ConfirmLevel]? { get { json[field: "confirm"] } set { json[field: "confirm"] = newValue } }
  /// Absent on a gateway that does not know the level.
  public var confirmPasskey: ConfirmPasskeyCapability? {
    get { json[field: "confirm_passkey"] }
    set { json[field: "confirm_passkey"] = newValue }
  }
}

// MARK: - Events

/// Why the gateway withdrew a server request (`RequestCancelReason`). Callers in the gateway may pass
/// their own wording, so the set stays open.
public enum RequestCancelReason: OpenStringEnum {
  case timeout, interrupted, shutdown, resolved
  case sessionClosed
  /// A `confirm` at level `passkey` settled `unavailable` after five refused answers.
  case tooManyAttempts
  /// A `confirm` at level `passkey` whose answer was received (`ok`) but could not be committed: it
  /// is NOT confirmed. A client clears any "confirmed" state it showed for that id.
  case verificationFailed
  case unknown(String)

  public static let knownCases: [RequestCancelReason] = [
    .timeout, .interrupted, .shutdown, .resolved, .sessionClosed, .tooManyAttempts, .verificationFailed
  ]

  public var rawValue: String {
    switch self {
    case .timeout: "timeout"
    case .interrupted: "interrupted"
    case .shutdown: "shutdown"
    case .resolved: "resolved"
    case .sessionClosed: "session_closed"
    case .tooManyAttempts: "too_many_attempts"
    case .verificationFailed: "verification_failed"
    case .unknown(let raw): raw
    }
  }
}

extension RequestCancelPayload {
  /// `reason`, typed.
  public var cancelReason: RequestCancelReason? { json[field: "reason"] }
}

/// `passkey.changed`: a credential of the signed-in user was added or revoked. Sent to every live
/// connection signed in as that user, with `session_id: ""`.
public struct PasskeyChangedPayload: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The event's type name. Not in `GatewayEventType.all`: it is read beside the transcript engine.
  public static let eventType = "passkey.changed"

  public var change: PasskeyChange? { get { json[field: "change"] } set { json[field: "change"] = newValue } }
  public var credential: PasskeyChangedCredential? {
    get { json[field: "credential"] }
    set { json[field: "credential"] = newValue }
  }
  public var at: Double? { get { json[field: "at"] } set { json[field: "at"] = newValue } }
}

public enum PasskeyChange: OpenStringEnum {
  case added, revoked
  case unknown(String)

  public static let knownCases: [PasskeyChange] = [.added, .revoked]

  public var rawValue: String {
    switch self {
    case .added: "added"
    case .revoked: "revoked"
    case .unknown(let raw): raw
    }
  }
}

public struct PasskeyChangedCredential: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
}
