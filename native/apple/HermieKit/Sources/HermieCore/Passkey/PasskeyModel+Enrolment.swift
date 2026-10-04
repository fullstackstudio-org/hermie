import Foundation
import HermieGateway
import HermieProtocol

// The credential list, enrolment with a one-time code, and the step-ups that mint an invite or
// revoke a credential (plan P6, P7; contract §5, §7, §11).

extension PasskeyModel {
  /// What the routes say about the signed-in user, decoded once per action.
  struct Account {
    var gatewayID: [UInt8]
    var gatewayIDText: String
    var userID: String
    var handle: [UInt8]
    var rpID: String
    var baseURL: String
  }

  // MARK: - The list

  /// Read `GET /api/auth/passkeys`: the state, the credentials, and what changed without this
  /// device. Never throws; `statusError` says why it failed.
  public func refresh() async {
    guard let client, !isShutDown else {
      return
    }

    do {
      let next = try await client.status()
      statusError = nil
      await adopt(next)
    } catch let error as PasskeyRouteError {
      statusError = error
    } catch {
      statusError = PasskeyRouteError(.refused, status: 0, detail: "The gateway could not be reached.")
    }
  }

  /// Take in a status read: notice a gateway id that breaks the pin and credentials added without
  /// this device, remember the ids, and re-advertise when that changed what can be advertised.
  private func adopt(_ next: PasskeyStatus) async {
    status = next
    credentials = next.credentials ?? []
    await loadOthers()

    if let gatewayID = next.gatewayID, !gatewayID.isEmpty, let problem = pinProblem(gatewayID) {
      // Not this gateway's list as this device knows it: nothing of it is remembered.
      notify(problem)
      return
    }

    let ids = credentials.compactMap(\.id)
    let firstRead = pin.seenAt == 0
    let added = credentials.filter { credential in
      guard let id = credential.id else { return false }
      return !pin.knownCredentialIDs.contains(id) && !expectedAdditions.contains(id)
    }

    if !firstRead, let first = added.first {
      notify(.credentialAdded(name: first.name ?? ""))
    }

    pin.knownCredentialIDs = ids
    pin.appCredentialIDs = credentials.filter { $0.rpID == configuration.rpID }.compactMap(\.id)
    await savePin()
    await policyChanged()
  }

  // MARK: - Enrolment

  /// Enrol a passkey of this device for this gateway, with a one-time code from the operator (or
  /// from one's own passkey elsewhere). Pins the gateway's id on success (contract §10).
  @discardableResult
  public func enrol(code: String) async throws(PasskeyActionError) -> PasskeyCredentialInfo {
    guard let canonical = EnrolmentCode.canonical(code) else {
      throw .invalidCode
    }

    return try await enrol(authority: .code(canonical))
  }

  /// What authorises one enrolment (contract §7): a canonical code, or a fresh grant with its
  /// use secret.
  enum EnrolmentAuthority {
    case code(String)
    case grant(id: String, useSecret: String)
  }

  /// The enrolment itself, the same for both authorities: open the registration, run the system
  /// sheet, finish, then pin and read the list again.
  private func enrol(authority: EnrolmentAuthority) async throws(PasskeyActionError) -> PasskeyCredentialInfo {
    let account = try await account()
    let name = configuration.credentialName(host: ConfirmDisplay.subject("", baseURL: account.baseURL).host)
    let beginParams: PasskeyRegisterBeginParams

    switch authority {
    case .code:
      beginParams = PasskeyRegisterBeginParams(rpID: account.rpID, baseURL: account.baseURL, name: name)
    case .grant(let id, let secret):
      beginParams = PasskeyRegisterBeginParams(
        rpID: account.rpID,
        baseURL: account.baseURL,
        name: name,
        grantID: id,
        useSecret: secret
      )
    }

    let begin: PasskeyRegisterBeginResult = try await route(grant: authority.isGrant) {
      try await $0.registerBegin(beginParams)
    }

    guard let registrationID = begin.registrationID, let nonce = begin.nonce.flatMap(Base64URL.decode), nonce.count == 32
    else {
      throw .badAnswer
    }

    let binding = PasskeyChallengeBinding(
      purpose: .register,
      gatewayID: account.gatewayID,
      userID: account.userID,
      requestID: registrationID,
      nonce: nonce
    )
    let challenge = PasskeyChallenge.challenge(.subject(name, baseURL: account.baseURL), binding)
    let excluded = (begin.excludeCredentials ?? []).compactMap { $0.id.flatMap(Base64URL.decode) }
    let request = PasskeyRegistrationRequest(
      rpID: account.rpID,
      challenge: challenge,
      userHandle: begin.user?.handle.flatMap(Base64URL.decode) ?? account.handle,
      name: name,
      displayName: name,
      excludeCredentialIDs: excluded
    )
    let registration: PasskeyRegistration

    do {
      registration = try await authenticator.register(request)
    } catch {
      throw .ceremony(error)
    }

    let id = Base64URL.encode(registration.credentialID)
    let credential = PasskeyNewCredential(
      id: id,
      clientDataJSON: Base64URL.encode(registration.clientDataJSON),
      attestationObject: Base64URL.encode(registration.attestationObject),
      transports: registration.transports
    )
    let finishParams: PasskeyRegisterFinishParams

    switch authority {
    case .code(let canonical):
      finishParams = PasskeyRegisterFinishParams(
        registrationID: registrationID,
        baseURL: account.baseURL,
        code: canonical,
        credential: credential
      )
    case .grant(let grantID, let secret):
      finishParams = PasskeyRegisterFinishParams(
        registrationID: registrationID,
        baseURL: account.baseURL,
        grantID: grantID,
        useSecret: secret,
        credential: credential
      )
    }

    expectedAdditions.insert(id)

    let finish: PasskeyRegisterFinishResult

    do {
      finish = try await route(grant: authority.isGrant) { try await $0.registerFinish(finishParams) }
    } catch {
      expectedAdditions.remove(id)
      throw error
    }

    // The first successful enrolment pins the id; a later one keeps the pin it has.
    pin.gatewayID = pin.gatewayID ?? account.gatewayIDText
    pin.knownCredentialIDs.append(id)
    pin.appCredentialIDs.append(id)
    await savePin()

    // Shut down while it finished: the device remembers its passkey, and nothing more runs.
    guard !isShutDown else {
      expectedAdditions.remove(id)
      return finish.credential ?? PasskeyCredentialInfo(json: ["id": .string(id), "name": .string(name), "rp_id": .string(account.rpID)])
    }
    await refresh()
    await policyChanged()
    expectedAdditions.remove(id)

    return finish.credential ?? PasskeyCredentialInfo(json: ["id": .string(id), "name": .string(name), "rp_id": .string(account.rpID)])
  }

  // MARK: - Step-ups

  /// Mint an enrolment code with a passkey of this device (`invite` step-up), for another device or
  /// a browser. Only where the operator allows it (`user_invites`).
  public func mintInvite() async throws(PasskeyActionError) -> PasskeyInvite {
    let (stepupID, assertion, account) = try await stepUp(.invite, subject: "invite")
    let result: PasskeyInviteResult = try await route {
      try await $0.invite(PasskeyInviteParams(stepupID: stepupID, baseURL: account.baseURL, assertion: assertion))
    }

    guard let code = result.code else {
      throw .badAnswer
    }

    return PasskeyInvite(code: code, expiresAt: result.expiresAt.map { Date(timeIntervalSince1970: $0) })
  }

  /// Revoke one of this account's credentials with a passkey of this device (`revoke` step-up).
  public func revoke(credentialID: String) async throws(PasskeyActionError) {
    expectedRevocations.insert(credentialID)

    do {
      let (stepupID, assertion, account) = try await stepUp(.revoke, subject: credentialID)
      let params = PasskeyRevokeParams(
        credentialID: credentialID,
        stepupID: stepupID,
        baseURL: account.baseURL,
        assertion: assertion
      )
      let _: PasskeyOKResult = try await route { try await $0.revoke(params) }
    } catch {
      expectedRevocations.remove(credentialID)
      throw error
    }

    pin.knownCredentialIDs.removeAll { $0 == credentialID }
    pin.appCredentialIDs.removeAll { $0 == credentialID }
    await savePin()
    await refresh()
    await policyChanged()
    expectedRevocations.remove(credentialID)
  }

  /// Open a step-up and sign it: `subject` is `"invite"` or the credential id (contract §5).
  private func stepUp(_ purpose: PasskeyStepupPurpose, subject: String) async throws(PasskeyActionError)
    -> (String, PasskeyAssertion, Account)
  {
    let account = try await account()
    let begin: PasskeyStepupBeginResult = try await route {
      try await $0.stepupBegin(PasskeyStepupBeginParams(purpose: purpose, subject: subject))
    }

    guard let stepupID = begin.stepupID, let nonce = begin.nonce.flatMap(Base64URL.decode), nonce.count == 32,
      (begin.subject ?? subject) == subject
    else {
      throw .badAnswer
    }

    let allow = (begin.credentials ?? []).filter { $0.rpID == account.rpID }.flatMap { $0.ids ?? [] }
      .compactMap(Base64URL.decode)

    guard !allow.isEmpty else {
      throw .notEnrolled
    }

    let binding = PasskeyChallengeBinding(
      purpose: purpose == .invite ? .invite : .revoke,
      gatewayID: account.gatewayID,
      userID: account.userID,
      requestID: stepupID,
      nonce: nonce
    )
    let challenge = PasskeyChallenge.challenge(.subject(subject, baseURL: account.baseURL), binding)
    let response: PasskeyAssertionResponse

    do {
      response = try await authenticator.assert(
        PasskeyAssertionRequest(rpID: account.rpID, challenge: challenge, allowCredentialIDs: allow)
      )
    } catch {
      throw .ceremony(error)
    }

    return (stepupID, Self.assertion(response, rpID: account.rpID, baseURL: account.baseURL), account)
  }

  // MARK: - Support

  /// A fresh status read, decoded and checked against the pins and this build's RP.
  private func account() async throws(PasskeyActionError) -> Account {
    guard let rpID = configuration.rpID, let baseURL else {
      throw .notConfigured
    }

    let fresh: PasskeyStatus = try await route { try await $0.status() }
    status = fresh
    credentials = fresh.credentials ?? []

    guard fresh.enabled == true else {
      throw .unavailable(reason: fresh.reason ?? "")
    }

    guard fresh.rp?.ids(for: configuration.kind).contains(rpID) == true else {
      throw .rpNotAccepted
    }

    guard let gatewayIDText = fresh.gatewayID, let gatewayID = Base64URL.decode(gatewayIDText), gatewayID.count == 16,
      let userID = fresh.user?.id, !userID.isEmpty, let handle = fresh.user?.handle.flatMap(Base64URL.decode)
    else {
      throw .badAnswer
    }

    // Another session may have pinned since: check against the pins as they are now.
    await loadOthers()

    if let problem = pinProblem(gatewayIDText) {
      notify(problem)
      throw Self.actionError(for: problem)
    }

    return Account(
      gatewayID: gatewayID,
      gatewayIDText: gatewayIDText,
      userID: userID,
      handle: handle,
      rpID: rpID,
      baseURL: baseURL
    )
  }

  private static func actionError(for problem: PasskeyNotice.Kind) -> PasskeyActionError {
    switch problem {
    case .gatewayIDMismatch: .gatewayIDMismatch
    case .pinUnreadable: .pinUnreadable
    default: .gatewayIDConflict
    }
  }

  /// One route call through the client, its failures as `PasskeyActionError`. With `grant`, a call
  /// of self-enrolment: the refusals that concern the grant (and a 429) are `.reauth`.
  private func route<T: Sendable>(grant: Bool = false, _ call: (PasskeyClient) async throws -> T)
    async throws(PasskeyActionError) -> T
  {
    guard let client else {
      throw .notConfigured
    }

    do {
      return try await call(client)
    } catch let error as PasskeyRouteError {
      if grant, let reason = Self.reauthReason(error) {
        throw .reauth(reason)
      }

      throw error.kind == .notOffered ? .unavailable(reason: "disabled") : .refused(error)
    } catch let error as GatewayError {
      throw .transport(error.message)
    } catch {
      throw .transport("The gateway could not be reached.")
    }
  }

  /// A refusal of `reauth/begin`, or of `register/begin|finish` with a grant, that is about the
  /// grant (contract §8): `nil` for the rest (an attestation refused, a credential that exists).
  static func reauthReason(_ error: PasskeyRouteError) -> PasskeyReauthReason? {
    switch error.kind {
    case .notOffered:
      return .notOffered
    case .rateLimited:
      return .rateLimited(retryAfter: error.retryAfter)
    case .originNotListed, .unexpectedAnswer:
      return nil
    case .refused:
      break
    }

    switch error.error {
    case "self_enrol_disabled":
      return .disabled
    case "provider_no_reauth":
      return .providerNoReauth
    case "reauth_invalid":
      switch error.reason {
      case "not_fresh": return .notFresh
      case "spent": return .spent
      case "failed": return .failed(failure: error.failure)
      default: return .expired
      }
    default:
      return nil
    }
  }

  // MARK: - Self-enrolment (contract §7.2; plan "Flows — Native app")

  /// "Add a passkey" by signing in again may be offered: the gateway says the person can and accepts
  /// this build's RP, and this session can sign in through the browser. A gateway without
  /// `self_enrol` cannot.
  public var canSelfEnrol: Bool {
    guard reauthenticator != nil, let status, status.enabled == true, status.selfEnrol?.available == true,
      let rpID = configuration.rpID
    else {
      return false
    }

    return status.rp?.ids(for: configuration.kind).contains(rpID) == true
  }

  /**
   Step 1, "Sign in again": open a fresh-authentication grant (`reauth/begin`) and sign in again
   through the system browser for it. Answers the self-enrolment, `ready` when the sign-in counted;
   throws `.reauth` with why not (and `selfEnrolment` says it too).

   A sign-in that ended before it came back (the sheet closed, the app went away and the listener
   with it) leaves the grant open, and calling this again signs in for the same grant until it
   expires, without opening another (`reauth/begin` allows five in ten minutes). While a step runs,
   another call is `busy`: it neither opens a grant nor touches the one running.
   */
  @discardableResult
  public func beginSelfEnrolment(presenter: any BrowserSessionPresenting) async throws(PasskeyActionError)
    -> PasskeySelfEnrolment
  {
    guard !isShutDown else {
      throw .notConfigured
    }

    guard let reauthenticator else {
      throw .reauth(.notOffered)
    }

    guard selfEnrolmentRun == nil else {
      throw .reauth(.busy)
    }

    let run = startSelfEnrolmentRun()
    defer { endSelfEnrolmentRun(run) }
    expireSelfEnrolmentIfDue()

    // The status decides first, a reused grant included: the operator may have switched it off.
    _ = try await account()
    try checkSelfEnrolmentRun(run)

    if let reason = Self.selfEnrolUnavailable(status?.selfEnrol) {
      throw .reauth(reason)
    }

    var attempt: PasskeySelfEnrolment

    if let held = selfEnrolment, case .signInEnded = held.phase, !held.isExpired(at: nowDate) {
      attempt = held
    } else {
      let begin: PasskeyReauthBeginResult = try await route(grant: true) { try await $0.reauthBegin() }
      try checkSelfEnrolmentRun(run)

      guard let grantID = begin.grantID, !grantID.isEmpty, let expiresAt = begin.expiresAt else {
        throw .badAnswer
      }

      attempt = PasskeySelfEnrolment(
        grantID: grantID,
        provider: begin.provider.flatMap { $0.isEmpty ? nil : $0 },
        expiresAt: Date(timeIntervalSince1970: expiresAt),
        phase: .signingIn
      )
    }

    attempt.phase = .signingIn
    selfEnrolment = attempt

    let result = await reauthenticator.reauthenticate(
      grantID: attempt.grantID,
      provider: attempt.provider,
      presenter: presenter
    )

    // Shut down, forgotten or replaced meanwhile: this result is nobody's any more.
    try checkSelfEnrolmentRun(run)

    guard let current = selfEnrolment, current.grantID == attempt.grantID, current.phase == .signingIn else {
      throw .reauth(.signIn(.cancelled))
    }

    switch result {
    case .failure(let problem):
      if Self.leavesGrantOpen(problem) {
        update { $0.phase = .signInEnded(problem) }
        throw .reauth(.signIn(problem))
      }

      update { $0.phase = .failed(.signIn(problem)) }

      if case .exchange(.protocol, _) = problem {
        throw .badAnswer
      }

      throw .reauth(.signIn(problem))
    case .success(let completion):
      switch completion.state {
      case .fresh(let secret):
        update {
          $0.useSecret = secret
          $0.expiresAt = Date(timeIntervalSince1970: completion.expiresAt)
          $0.phase = .ready
        }
      case .failed(let reason):
        let why = Self.tokenFailure(reason)
        update { $0.phase = .failed(why) }
        throw .reauth(why)
      }
    }

    return selfEnrolment ?? attempt
  }

  /**
   Step 2, "Create the passkey": `enrol(code:)` with the grant `beginSelfEnrolment` completed
   instead of a code, the same pin and list read afterwards. A cancelled system sheet, a refused
   attestation or a 429 leaves the grant ready to try again until it expires; a refusal of the grant
   itself ends it (`selfEnrolment.phase` is `failed`).
   */
  @discardableResult
  public func enrol(grantID: String) async throws(PasskeyActionError) -> PasskeyCredentialInfo {
    guard !isShutDown else {
      throw .notConfigured
    }

    guard selfEnrolmentRun == nil else {
      throw .reauth(.busy)
    }

    expireSelfEnrolmentIfDue()

    guard let held = selfEnrolment, held.grantID == grantID else {
      throw .reauth(.expired)
    }

    guard held.phase == .ready, let secret = held.useSecret else {
      switch held.phase {
      case .done: throw .reauth(.spent)
      case .failed(.expired): throw .reauth(.expired)
      default: throw .reauth(.notFresh)
      }
    }

    let run = startSelfEnrolmentRun()
    defer { endSelfEnrolmentRun(run) }
    update { $0.phase = .enrolling }

    do {
      let credential = try await enrol(authority: .grant(id: grantID, useSecret: secret))

      // The passkey exists at the gateway whatever happened here meanwhile; only the state is left alone.
      guard selfEnrolmentRun == run, !isShutDown else {
        return credential
      }

      update(grantID) {
        $0.phase = .done
        $0.useSecret = nil
      }

      return credential
    } catch {
      guard selfEnrolmentRun == run, !isShutDown else {
        throw isShutDown ? .notConfigured : error
      }

      update(grantID) { held in
        if case .reauth(let reason) = error, Self.endsGrant(reason) {
          held.phase = .failed(reason)
          held.useSecret = nil
        } else {
          held.phase = .ready
        }
      }

      throw error
    }
  }

  /**
   A grant past its `expires_at` is over: its phase becomes `failed(expired)` and its use secret is
   dropped. The steps call this themselves; the page's countdown calls it when it reaches zero.
   */
  public func expireSelfEnrolmentIfDue() {
    guard let held = selfEnrolment, held.isExpired(at: nowDate) else {
      return
    }

    switch held.phase {
    case .ready, .signInEnded:
      update {
        $0.phase = .failed(.expired)
        $0.useSecret = nil
      }
    case .signingIn, .enrolling, .failed, .done:
      update { $0.useSecret = nil }
    }
  }

  /// Forget the self-enrolment: the page closed, or the person starts over. A sign-in sheet still
  /// up closes; the grant is left to expire at the gateway.
  public func forgetSelfEnrolment() {
    selfEnrolment = nil
    // A step still running is nobody's now; a new one may start at once.
    selfEnrolmentRun = nil

    if let reauthenticator {
      Task { await reauthenticator.cancel() }
    }
  }

  /// The app is in front again: a sign-in in progress listens again (see `PasskeyReauthenticating`).
  public func appBecameActive() async {
    await reauthenticator?.appBecameActive()
  }

  private func startSelfEnrolmentRun() -> UInt64 {
    selfEnrolmentAttempt &+= 1
    selfEnrolmentRun = selfEnrolmentAttempt
    return selfEnrolmentAttempt
  }

  private func endSelfEnrolmentRun(_ run: UInt64) {
    if selfEnrolmentRun == run {
      selfEnrolmentRun = nil
    }
  }

  /// After every wait of step 1: shut down, or let go of by a forget, ends it here.
  private func checkSelfEnrolmentRun(_ run: UInt64) throws(PasskeyActionError) {
    guard !isShutDown else {
      throw .notConfigured
    }

    guard selfEnrolmentRun == run else {
      throw .reauth(.signIn(.cancelled))
    }
  }

  /// The token route's `failed` reason: a failure of contract §7.2, or a grant that could not be
  /// completed at all (`unknown`, `not_open`, `client_mismatch`), which is over as if it expired.
  static func tokenFailure(_ reason: String) -> PasskeyReauthReason {
    switch reason {
    case "unknown", "not_open", "client_mismatch": .expired
    default: .failed(failure: reason)
    }
  }

  private var nowDate: Date {
    Date(timeIntervalSince1970: now())
  }

  /// Change the self-enrolment in place, if it is still the one for `grantID` (any, when `nil`).
  private func update(_ grantID: String? = nil, _ change: (inout PasskeySelfEnrolment) -> Void) {
    guard var held = selfEnrolment, grantID == nil || held.grantID == grantID else {
      return
    }

    change(&held)
    selfEnrolment = held
  }

  /// Why the status says self-enrolment is not available, `nil` when it is.
  static func selfEnrolUnavailable(_ selfEnrol: PasskeySelfEnrolStatus?) -> PasskeyReauthReason? {
    guard let selfEnrol else {
      return .notOffered
    }

    if selfEnrol.available == true {
      return nil
    }

    switch selfEnrol.reason {
    case "disabled": return .disabled
    case "provider_no_reauth": return .providerNoReauth
    default: return .notOffered
    }
  }

  /// The sign-in ended before its code was redeemed, so the grant is still open. Once a code was
  /// redeemed (`exchange`), whether the grant was completed is not known here: start again.
  static func leavesGrantOpen(_ problem: SignInProblem) -> Bool {
    switch problem {
    case .exchange, .rejected, .check:
      false
    case .portInUse, .listenerUnavailable, .browserUnavailable, .cancelled, .timedOut, .couldNotStart, .stateMismatch,
      .noCode, .blockedNavigation, .provider, .pageLoad:
      true
    }
  }

  /// A step-2 refusal after which the grant cannot be used again.
  static func endsGrant(_ reason: PasskeyReauthReason) -> Bool {
    switch reason {
    case .rateLimited, .signIn, .busy:
      false
    case .notOffered, .disabled, .providerNoReauth, .expired, .notFresh, .spent, .failed:
      true
    }
  }
}

extension PasskeyModel.EnrolmentAuthority {
  var isGrant: Bool {
    if case .grant = self { true } else { false }
  }
}
