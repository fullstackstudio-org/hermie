import Foundation

// The passkey routes behind the gate (`hermes_cli/dashboard_auth/passkeys/routes.py`, plan
// "HTTP routes", contract §5 and §11). A caller only ever sees, adds to or revokes its own
// credentials; the identity is the gate's, never a body. Bodies are JSON objects of at most 16 KiB.

extension RESTPath {
  /// `GET`: the caller's passkey state and credentials.
  public static let passkeys = "/api/auth/passkeys"
  /// `POST`: open a registration (300 s).
  public static let passkeyRegisterBegin = "/api/auth/passkeys/register/begin"
  /// `POST`: enrol a credential with an attestation and a one-time enrolment code.
  public static let passkeyRegisterFinish = "/api/auth/passkeys/register/finish"
  /// `POST`: open a step-up for `invite` or `revoke` (120 s, single use).
  public static let passkeyStepupBegin = "/api/auth/passkeys/stepup/begin"
  /// `POST`: mint an enrolment code for oneself with an `invite` step-up.
  public static let passkeyInvites = "/api/auth/passkeys/invites"
  /// `POST`: revoke one of one's own credentials with a `revoke` step-up.
  public static let passkeyRevoke = "/api/auth/passkeys/revoke"
  /// `POST`: open a fresh-authentication grant for self-enrolment (600 s, contract §7.2).
  public static let passkeyReauthBegin = "/api/auth/passkeys/reauth/begin"
}

/// `GET /api/auth/passkeys`.
public struct PasskeyStatus: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var v: Int? { get { json[field: "v"] } set { json[field: "v"] = newValue } }
  public var enabled: Bool? { get { json[field: "enabled"] } set { json[field: "enabled"] = newValue } }
  /// `""` when enabled; else `disabled`, `no_base_url`, `private_origin`, `no_identity`.
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
  public var gatewayID: String? { get { json[field: "gateway_id"] } set { json[field: "gateway_id"] = newValue } }
  public var user: PasskeyStatusUser? { get { json[field: "user"] } set { json[field: "user"] = newValue } }
  public var rp: PasskeyRPLists? { get { json[field: "rp"] } set { json[field: "rp"] = newValue } }
  /// The level's own base URLs (`confirm.passkey.base_urls`, the accepted ones).
  public var baseURLs: [String]? { get { json[field: "base_urls"] } set { json[field: "base_urls"] = newValue } }
  /// Whether a person may mint their own enrolment code with a passkey.
  public var userInvites: Bool? { get { json[field: "user_invites"] } set { json[field: "user_invites"] = newValue } }
  public var credentials: [PasskeyCredentialInfo]? {
    get { json[field: "credentials"] }
    set { json[field: "credentials"] = newValue }
  }
  /// Whether the caller can add a passkey by signing in again (contract §8). An older gateway has
  /// no such field: a missing `self_enrol` is "not available".
  public var selfEnrol: PasskeySelfEnrolStatus? {
    get { json[field: "self_enrol"] }
    set { json[field: "self_enrol"] = newValue }
  }
}

/// `self_enrol` of the status: `{available, reason, cooling_off_s}`.
public struct PasskeySelfEnrolStatus: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var available: Bool? { get { json[field: "available"] } set { json[field: "available"] = newValue } }
  /// `""` when available; else `disabled` (the operator switched it off) or `provider_no_reauth`
  /// (the caller's sign-in provider cannot give a fresh authentication).
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
  /// Seconds a self-enrolled credential waits before it may answer anything (0: none).
  public var coolingOffS: Double? { get { json[field: "cooling_off_s"] } set { json[field: "cooling_off_s"] = newValue } }
}

/// The signed-in user as the passkey routes name them: `<provider>:<user id>` and the 32-byte
/// user handle (base64url) a credential is created with.
public struct PasskeyStatusUser: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var handle: String? { get { json[field: "handle"] } set { json[field: "handle"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var displayName: String? { get { json[field: "display_name"] } set { json[field: "display_name"] = newValue } }
}

/// One enrolled credential, as the caller may see it (public fields only).
public struct PasskeyCredentialInfo: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The credential id, base64url.
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var aaguid: String? { get { json[field: "aaguid"] } set { json[field: "aaguid"] = newValue } }
  public var createdAt: Double? { get { json[field: "created_at"] } set { json[field: "created_at"] = newValue } }
  public var lastUsedAt: Double? { get { json[field: "last_used_at"] } set { json[field: "last_used_at"] = newValue } }
  public var backupEligible: Bool? {
    get { json[field: "backup_eligible"] }
    set { json[field: "backup_eligible"] = newValue }
  }
  public var backedUp: Bool? { get { json[field: "backed_up"] } set { json[field: "backed_up"] = newValue } }
  /// `operator` or `passkey`: how the enrolment code was minted; `self`: enrolled by signing in again.
  public var createdVia: String? { get { json[field: "created_via"] } set { json[field: "created_via"] = newValue } }
  /// Unix seconds: a self-enrolled credential cooling off cannot answer anything before then.
  /// Absent once it has passed, and for every credential without cooling-off.
  public var usableFrom: Double? { get { json[field: "usable_from"] } set { json[field: "usable_from"] = newValue } }
  public var transports: [String]? { get { json[field: "transports"] } set { json[field: "transports"] = newValue } }
}

/// `POST /api/auth/passkeys/register/begin` body. The app names the credential (plan P3). With a
/// fresh-authentication grant it carries `grant_id` and, from the app, the grant's `use_secret`, so
/// its description shows none of it.
public struct PasskeyRegisterBeginParams: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(rpID: String, baseURL: String, name: String, grantID: String? = nil, useSecret: String? = nil) {
    self.init()
    self.rpID = rpID
    self.baseURL = baseURL
    self.name = name
    self.grantID = grantID
    self.useSecret = useSecret
  }

  public var rpID: String? { get { json[field: "rp_id"] } set { json[field: "rp_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// The fresh-authentication grant that authorises this enrolment (contract §7.2).
  public var grantID: String? { get { json[field: "grant_id"] } set { json[field: "grant_id"] = newValue } }
  /// A native grant's binding, from the token route's fresh answer.
  public var useSecret: String? { get { json[field: "use_secret"] } set { json[field: "use_secret"] = newValue } }

  public var description: String { "PasskeyRegisterBeginParams(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// `{expires_at}` of the grant a registration was opened with.
public struct PasskeyGrantInfo: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
}

/// One entry of `exclude_credentials`.
public struct PasskeyCredentialDescriptor: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var type: String? { get { json[field: "type"] } set { json[field: "type"] = newValue } }
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var transports: [String]? { get { json[field: "transports"] } set { json[field: "transports"] = newValue } }
}

/// `{id, name}` of the RP a registration is for.
public struct PasskeyRPEntity: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
}

/// `POST /api/auth/passkeys/register/begin` answer. Lives 300 s.
public struct PasskeyRegisterBeginResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var registrationID: String? {
    get { json[field: "registration_id"] }
    set { json[field: "registration_id"] = newValue }
  }
  public var nonce: String? { get { json[field: "nonce"] } set { json[field: "nonce"] = newValue } }
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  public var gatewayID: String? { get { json[field: "gateway_id"] } set { json[field: "gateway_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var rp: PasskeyRPEntity? { get { json[field: "rp"] } set { json[field: "rp"] = newValue } }
  public var user: PasskeyStatusUser? { get { json[field: "user"] } set { json[field: "user"] = newValue } }
  public var excludeCredentials: [PasskeyCredentialDescriptor]? {
    get { json[field: "exclude_credentials"] }
    set { json[field: "exclude_credentials"] = newValue }
  }
  public var userVerification: String? {
    get { json[field: "user_verification"] }
    set { json[field: "user_verification"] = newValue }
  }
  public var attestation: String? { get { json[field: "attestation"] } set { json[field: "attestation"] = newValue } }
  /// Present when the registration was opened with a grant: when that grant runs out.
  public var grant: PasskeyGrantInfo? { get { json[field: "grant"] } set { json[field: "grant"] = newValue } }
}

/// The new credential of `register/finish`: what the authenticator returned, base64url.
public struct PasskeyNewCredential: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(id: String, clientDataJSON: String, attestationObject: String, transports: [String]) {
    self.init()
    self.id = id
    self.clientDataJSON = clientDataJSON
    self.attestationObject = attestationObject
    self.transports = transports
  }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var clientDataJSON: String? {
    get { json[field: "client_data_json"] }
    set { json[field: "client_data_json"] = newValue }
  }
  public var attestationObject: String? {
    get { json[field: "attestation_object"] }
    set { json[field: "attestation_object"] = newValue }
  }
  public var transports: [String]? { get { json[field: "transports"] } set { json[field: "transports"] = newValue } }
}

/// `POST /api/auth/passkeys/register/finish` body: the enrolment code, or a fresh-authentication
/// grant (with the app's `use_secret`), never both. Its description shows none of it.
public struct PasskeyRegisterFinishParams: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(registrationID: String, baseURL: String, code: String, credential: PasskeyNewCredential) {
    self.init()
    self.registrationID = registrationID
    self.baseURL = baseURL
    self.code = code
    self.credential = credential
  }

  /// The self-enrolment form: a grant instead of a code.
  public init(
    registrationID: String,
    baseURL: String,
    grantID: String,
    useSecret: String?,
    credential: PasskeyNewCredential
  ) {
    self.init()
    self.registrationID = registrationID
    self.baseURL = baseURL
    self.grantID = grantID
    self.useSecret = useSecret
    self.credential = credential
  }

  public var registrationID: String? {
    get { json[field: "registration_id"] }
    set { json[field: "registration_id"] = newValue }
  }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var code: String? { get { json[field: "code"] } set { json[field: "code"] = newValue } }
  public var grantID: String? { get { json[field: "grant_id"] } set { json[field: "grant_id"] = newValue } }
  public var useSecret: String? { get { json[field: "use_secret"] } set { json[field: "use_secret"] = newValue } }
  public var credential: PasskeyNewCredential? {
    get { json[field: "credential"] }
    set { json[field: "credential"] = newValue }
  }

  public var description: String { "PasskeyRegisterFinishParams(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// `POST /api/auth/passkeys/register/finish` answer.
public struct PasskeyRegisterFinishResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var ok: Bool? { get { json[field: "ok"] } set { json[field: "ok"] = newValue } }
  public var credential: PasskeyCredentialInfo? {
    get { json[field: "credential"] }
    set { json[field: "credential"] = newValue }
  }
}

/// What a step-up proves: minting an enrolment code, or revoking one credential.
public enum PasskeyStepupPurpose: String, Sendable, Hashable {
  case invite, revoke
}

/// `POST /api/auth/passkeys/stepup/begin` body. `subject` is `"invite"` for an invite and the
/// credential id for a revoke.
public struct PasskeyStepupBeginParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(purpose: PasskeyStepupPurpose, subject: String? = nil) {
    self.init()
    json["purpose"] = .string(purpose.rawValue)
    self.subject = subject
  }

  public var purpose: String? { get { json[field: "purpose"] } set { json[field: "purpose"] = newValue } }
  public var subject: String? { get { json[field: "subject"] } set { json[field: "subject"] = newValue } }
}

/// `POST /api/auth/passkeys/stepup/begin` answer. Lives 120 s, single use.
public struct PasskeyStepupBeginResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var stepupID: String? { get { json[field: "stepup_id"] } set { json[field: "stepup_id"] = newValue } }
  public var purpose: String? { get { json[field: "purpose"] } set { json[field: "purpose"] = newValue } }
  public var subject: String? { get { json[field: "subject"] } set { json[field: "subject"] = newValue } }
  public var nonce: String? { get { json[field: "nonce"] } set { json[field: "nonce"] = newValue } }
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  public var credentials: [PasskeyCredentialIDs]? {
    get { json[field: "credentials"] }
    set { json[field: "credentials"] = newValue }
  }
}

/// `POST /api/auth/passkeys/invites` body.
public struct PasskeyInviteParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(stepupID: String, baseURL: String, assertion: PasskeyAssertion) {
    self.init()
    self.stepupID = stepupID
    self.baseURL = baseURL
    self.assertion = assertion
  }

  public var stepupID: String? { get { json[field: "stepup_id"] } set { json[field: "stepup_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var assertion: PasskeyAssertion? { get { json[field: "assertion"] } set { json[field: "assertion"] = newValue } }
}

/// `POST /api/auth/passkeys/invites` answer: a fresh enrolment code. Its description shows none of it.
public struct PasskeyInviteResult: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var code: String? { get { json[field: "code"] } set { json[field: "code"] = newValue } }
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }

  public var description: String { "PasskeyInviteResult(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// `POST /api/auth/passkeys/revoke` body.
public struct PasskeyRevokeParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(credentialID: String, stepupID: String, baseURL: String, assertion: PasskeyAssertion) {
    self.init()
    self.credentialID = credentialID
    self.stepupID = stepupID
    self.baseURL = baseURL
    self.assertion = assertion
  }

  public var credentialID: String? { get { json[field: "credential_id"] } set { json[field: "credential_id"] = newValue } }
  public var stepupID: String? { get { json[field: "stepup_id"] } set { json[field: "stepup_id"] = newValue } }
  public var baseURL: String? { get { json[field: "base_url"] } set { json[field: "base_url"] = newValue } }
  public var assertion: PasskeyAssertion? { get { json[field: "assertion"] } set { json[field: "assertion"] = newValue } }
}

/// `{ok: true}` of `register/finish` and `revoke`.
public struct PasskeyOKResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var ok: Bool? { get { json[field: "ok"] } set { json[field: "ok"] = newValue } }
}

/// A refusal of a passkey route: `{error, detail, reason?}`.
public struct PasskeyRouteErrorBody: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `bad_request`, `no_identity`, `origin_not_listed`, `invites_disabled`, `stepup_invalid`,
  /// `code_invalid`, `expired`, `credential_exists`, `body_too_large`, `attestation_invalid`,
  /// `assertion_invalid`, `rate_limited`, `protected_setting`.
  public var error: String? { get { json[field: "error"] } set { json[field: "error"] = newValue } }
  public var detail: String? { get { json[field: "detail"] } set { json[field: "detail"] = newValue } }
  /// The contract's refusal reason (`challenge_mismatch`, `rp_not_accepted`, …), when there is one.
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
  /// With `reauth_invalid` and `reason: failed`: why the sign-in did not count (`user_mismatch`,
  /// `provider_mismatch`, `auth_time_missing`, `auth_not_fresh`).
  public var failure: String? { get { json[field: "failure"] } set { json[field: "failure"] = newValue } }
}

// MARK: - Self-enrolment (contract §7.2, §8)

/// `POST /api/auth/passkeys/reauth/begin` answer. A bearer caller (the app) gets no `login_path`.
public struct PasskeyReauthBeginResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// 16 random bytes, base64url. Useless without its binding (contract §7.2), and never logged.
  public var grantID: String? { get { json[field: "grant_id"] } set { json[field: "grant_id"] = newValue } }
  /// Unix seconds; a grant lives 600 s.
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  /// The sign-in provider the grant must be completed with.
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  /// Cookie callers only.
  public var loginPath: String? { get { json[field: "login_path"] } set { json[field: "login_path"] = newValue } }
}

/// `POST /auth/native/token` answer for a re-authentication code: `{reauth: {…}}` and no tokens.
public struct NativeReauthTokenAnswer: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var reauth: NativeReauthOutcome? { get { json[field: "reauth"] } set { json[field: "reauth"] = newValue } }

  public var description: String { "NativeReauthTokenAnswer(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// What the sign-in did to the grant: `use_secret` only when `fresh`, `reason` only when `failed`.
/// It carries the grant's binding, so its description shows none of it.
public struct NativeReauthOutcome: JSONObjectBacked, CustomDebugStringConvertible, CustomReflectable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var grantID: String? { get { json[field: "grant_id"] } set { json[field: "grant_id"] = newValue } }
  /// `fresh` or `failed`.
  public var state: String? { get { json[field: "state"] } set { json[field: "state"] = newValue } }
  /// A failure of contract §7.2, or `unknown`, `not_open`, `client_mismatch` when the grant could not
  /// be completed at all.
  public var reason: String? { get { json[field: "reason"] } set { json[field: "reason"] = newValue } }
  public var expiresAt: Double? { get { json[field: "expires_at"] } set { json[field: "expires_at"] = newValue } }
  public var useSecret: String? { get { json[field: "use_secret"] } set { json[field: "use_secret"] = newValue } }

  public var description: String { "NativeReauthOutcome(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}
