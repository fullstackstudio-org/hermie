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

    let account = try await account()
    let name = configuration.credentialName(host: ConfirmDisplay.subject("", baseURL: account.baseURL).host)
    let begin: PasskeyRegisterBeginResult = try await route {
      try await $0.registerBegin(PasskeyRegisterBeginParams(rpID: account.rpID, baseURL: account.baseURL, name: name))
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
    let finishParams = PasskeyRegisterFinishParams(
      registrationID: registrationID,
      baseURL: account.baseURL,
      code: canonical,
      credential: credential
    )

    expectedAdditions.insert(id)

    let finish: PasskeyRegisterFinishResult

    do {
      finish = try await route { try await $0.registerFinish(finishParams) }
    } catch {
      expectedAdditions.remove(id)
      throw error
    }

    // The first successful enrolment pins the id; a later one keeps the pin it has.
    pin.gatewayID = pin.gatewayID ?? account.gatewayIDText
    pin.knownCredentialIDs.append(id)
    pin.appCredentialIDs.append(id)
    await savePin()
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

    if let problem = pinProblem(gatewayIDText) {
      notify(problem)
      throw problem == .gatewayIDMismatch ? .gatewayIDMismatch : .gatewayIDConflict
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

  /// One route call through the client, its failures as `PasskeyActionError`.
  private func route<T: Sendable>(_ call: (PasskeyClient) async throws -> T) async throws(PasskeyActionError) -> T {
    guard let client else {
      throw .notConfigured
    }

    do {
      return try await call(client)
    } catch let error as PasskeyRouteError {
      throw error.kind == .notOffered ? .unavailable(reason: "disabled") : .refused(error)
    } catch let error as GatewayError {
      throw .transport(error.message)
    } catch {
      throw .transport("The gateway could not be reached.")
    }
  }
}
