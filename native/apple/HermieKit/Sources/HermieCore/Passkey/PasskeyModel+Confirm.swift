import Foundation
import HermieGateway
import HermieProtocol

// `confirm` at level `passkey`: reading a frame, answering it, and what the gateway says afterwards.

/// Why a frame cannot be answered here; `reason` is the 4040 `data.reason`.
struct PasskeyFrameProblem: Error, Equatable {
  var reason: String
  var notice: PasskeyNotice.Kind?
}

extension PasskeyModel {
  /// The 4040 message (contract §8 `error_cannot_run_ceremony`).
  static let unavailableMessage = "passkey ceremony unavailable"
  /// What `request.answer` refuses with: not allowed (4033), not valid (4034).
  static let notAllowedCode = 4033
  static let refusedCode = 4034
  static let cannotRunCode = 4040
  /// The longest a confirmation stays open here, whatever `expires_at` says.
  static let maxConfirmSeconds: Double = 120

  // MARK: - Arrival

  func ingest(_ inbound: InboundRequest) async {
    guard !isShutDown, case .confirm(let params) = inbound.body else {
      return
    }

    guard params.level == .passkey else {
      // `plain` belongs to a sheet the app does not have yet (CP-10's). Until it does, a `plain`
      // request is declined `-32601` here, whether or not `configuration.plain` advertised it:
      // never left for the gateway's deadline.
      _ = await inbound.decline()
      return
    }

    let id = inbound.id

    // A copy of one already here: a reconnect re-delivered it. Answer over the new socket.
    if let existing = confirmation(id) {
      if existing.isOpen {
        contexts[id]?.inbound = inbound
      }
      return
    }

    // Another session may have pinned since: the frame is checked against the pins as they are.
    await loadOthers()

    do {
      let (confirmation, context) = try read(id: id, params, inbound: inbound)
      contexts[id] = context
      upsert(confirmation)
      // Past its `expires_at` on arrival (a re-delivery that outlived it, or a clock that is off):
      // over here too, without a sheet, and the person is told.
      if await endIfExpired(id) {
        notify(.expiredOnArrival)
      }
    } catch {
      if let notice = error.notice {
        notify(notice)
      }

      _ = await inbound.fail(
        code: Self.cannotRunCode,
        message: Self.unavailableMessage,
        data: ["reason": .string(error.reason)]
      )
    }
  }

  /// Read a frame into what the sheet shows and what the challenge commits to, or say why not.
  func read(id: String, _ params: ConfirmRequestParams, inbound: InboundRequest) throws(PasskeyFrameProblem)
    -> (PasskeyConfirmation, ConfirmContext)
  {
    guard let rpID = configuration.rpID else {
      throw PasskeyFrameProblem(reason: "rp_not_configured")
    }

    guard let baseURL else {
      throw PasskeyFrameProblem(reason: "bad_base_url")
    }

    guard let passkey = params.passkey, passkey.v == 1 else {
      throw PasskeyFrameProblem(reason: "unsupported_version", notice: .unsupportedVersion)
    }

    let frame = try Self.fields(params, passkey)

    if let problem = pinProblem(frame.gatewayIDText) {
      throw PasskeyFrameProblem(reason: Self.reason(for: problem), notice: problem)
    }

    guard let frameExpiry = passkey.expiresAt, frameExpiry.isFinite else {
      throw PasskeyFrameProblem(reason: "bad_request", notice: .malformedRequest)
    }

    let allow = try allowList(passkey, rpID: rpID)
    let display = ConfirmDisplay(title: frame.title, summary: frame.summary, detail: params.detail, baseURL: baseURL)
    let binding = PasskeyChallengeBinding(
      purpose: .confirm,
      gatewayID: frame.gatewayID,
      userID: frame.userID,
      sessionID: frame.sessionID,
      requestID: id,
      nonce: frame.nonce
    )
    let confirmation = PasskeyConfirmation(
      id: id,
      sessionID: frame.sessionID,
      display: display,
      userName: passkey.user?.name ?? "",
      expiresAt: Date(timeIntervalSince1970: min(frameExpiry, now() + Self.maxConfirmSeconds)),
      receivedAt: Date(timeIntervalSince1970: now()),
      phase: .waiting
    )

    return (confirmation, ConfirmContext(inbound: inbound, binding: binding, allowCredentialIDs: allow))
  }

  /// The credentials the system sheet may offer: the frame's ids for this build's RP, minus any
  /// pinned for another stored gateway. Once this device has seen the account's credentials here,
  /// the list must share one with them; a list of strangers is refused (`no_credential`).
  private func allowList(_ passkey: ConfirmPasskeyParams, rpID: String) throws(PasskeyFrameProblem) -> [[UInt8]] {
    let foreign = foreignCredentialIDs
    let listed = (passkey.credentials ?? []).filter { $0.rpID == rpID }.flatMap { $0.ids ?? [] }
    let usable = listed.filter { !foreign.contains($0) }
    let known = pin.knownCredentialIDs
    let familiar = known.isEmpty || usable.contains { known.contains($0) }
    let allow = familiar ? usable.compactMap(Base64URL.decode) : []

    guard !allow.isEmpty else {
      throw PasskeyFrameProblem(reason: "no_credential", notice: .noCredentialForApp)
    }

    return allow
  }

  private struct FrameFields {
    var title: String
    var summary: String
    var sessionID: String
    var userID: String
    var gatewayID: [UInt8]
    var gatewayIDText: String
    var nonce: [UInt8]
  }

  /// The fields the challenge needs, present and well-formed.
  private static func fields(_ params: ConfirmRequestParams, _ passkey: ConfirmPasskeyParams) throws(PasskeyFrameProblem)
    -> FrameFields
  {
    guard let title = params.title, let summary = params.summary, let sessionID = params.sessionID,
      let userID = passkey.user?.id, !userID.isEmpty,
      let gatewayIDText = passkey.gatewayID, let gatewayID = Base64URL.decode(gatewayIDText), gatewayID.count == 16,
      let nonceText = passkey.nonce, let nonce = Base64URL.decode(nonceText), nonce.count == 32
    else {
      throw PasskeyFrameProblem(reason: "bad_request", notice: .malformedRequest)
    }

    return FrameFields(
      title: title,
      summary: summary,
      sessionID: sessionID,
      userID: userID,
      gatewayID: gatewayID,
      gatewayIDText: gatewayIDText,
      nonce: nonce
    )
  }

  // MARK: - Answering

  /// The person pressed Confirm: run the ceremony over the challenge of what the sheet shows, then
  /// answer through `request.answer`. Dismissing the system sheet sends nothing.
  public func confirm(_ id: String) async {
    guard let current = confirmation(id), current.phase.isActionable, let context = contexts[id],
      let rpID = configuration.rpID, !(await endIfExpired(id))
    else {
      return
    }

    let before = current.phase
    setPhase(id, .signing)

    let challenge = PasskeyChallenge.challenge(current.display, context.binding)
    let response: PasskeyAssertionResponse

    do {
      response = try await authenticator.assert(
        PasskeyAssertionRequest(rpID: rpID, challenge: challenge, allowCredentialIDs: context.allowCredentialIDs)
      )
    } catch {
      await ceremonyFailed(id, error, before: before)
      return
    }

    // Re-check after the suspension: the gateway may have withdrawn it meanwhile.
    guard confirmation(id)?.phase == .signing else {
      return
    }

    let assertion = Self.assertion(response, rpID: rpID, baseURL: current.display.baseURL)
    await answer(id, ConfirmResult.confirmed(assertion), done: .received)
  }

  /// The person pressed Decline: exactly `{decision: "declined", method: "tap"}`.
  public func decline(_ id: String) async {
    guard confirmation(id)?.phase.isActionable == true, !(await endIfExpired(id)) else {
      return
    }

    await answer(id, ConfirmResult.declined, done: .declined)
  }

  /// The countdown reached zero: end the confirmation locally as timed out when its `expires_at`
  /// has passed (the gateway's own `request.cancel` ends it too, whichever comes first).
  public func expireIfDue(_ id: String) async {
    await endIfExpired(id)
  }

  /// End an open confirmation past its `expires_at` locally, as timed out: the gateway has given
  /// up on it, so no ceremony runs and nothing is sent. `true` when it was ended.
  ///
  /// An answer in flight (`sending`) keeps its phase, as in `withdrawn(_:reason:)`: the reply may
  /// still say it was received, and that is what the person must read. A ceremony in progress
  /// (`signing`) ends first and is cancelled after, so the system's passkey sheet goes away with it
  /// and the ceremony, returning, finds the request over and sends nothing.
  @discardableResult
  func endIfExpired(_ id: String) async -> Bool {
    guard let current = confirmation(id), current.isOpen, current.phase != .sending,
      current.isExpired(at: Date(timeIntervalSince1970: now()))
    else {
      return false
    }

    let signing = current.phase == .signing
    setPhase(id, .ended(.timedOut))

    if signing {
      await authenticator.cancel()
    }

    return true
  }

  private func ceremonyFailed(_ id: String, _ error: PasskeyCeremonyError, before: PasskeyConfirmPhase) async {
    guard confirmation(id)?.phase == .signing else {
      return
    }

    guard let reason = error.refusalReason else {
      // Dismissed, busy or a platform hiccup: nothing goes out, the sheet stays.
      setPhase(id, error == .cancelled || error == .busy ? before : .notSent(Self.describe(error)))
      return
    }

    let inbound = contexts[id]?.inbound
    setPhase(id, .ended(.unavailable(reason: reason)))
    _ = await inbound?.fail(code: Self.cannotRunCode, message: Self.unavailableMessage, data: ["reason": .string(reason)])
  }

  private static func describe(_ error: PasskeyCeremonyError) -> String {
    if case .failed(let text) = error {
      return text
    }

    return "The passkey sheet could not finish."
  }

  /// The wire form of what the authenticator returned.
  static func assertion(_ response: PasskeyAssertionResponse, rpID: String, baseURL: String) -> PasskeyAssertion {
    PasskeyAssertion(
      rpID: rpID,
      baseURL: baseURL,
      credentialID: Base64URL.encode(response.credentialID),
      authenticatorData: Base64URL.encode(response.authenticatorData),
      clientDataJSON: Base64URL.encode(response.clientDataJSON),
      signature: Base64URL.encode(response.signature),
      userHandle: response.userHandle.map(Base64URL.encode)
    )
  }

  /// Send `result` through `request.answer` and read what came back.
  private func answer(_ id: String, _ result: ConfirmResult, done: PasskeyConfirmPhase) async {
    setPhase(id, .sending)

    let params = RequestAnswerParams(id: id, result: result.json)
    let outcome: PasskeyConfirmPhase

    do {
      let reply = try await link.requestReply(RPC.RequestAnswer.name, params: params.jsonValue)
      let status = RequestAnswerResult(jsonValue: reply.result)?.status
      outcome = status == .ok ? done : .ended(.withdrawn(reason: status?.rawValue ?? ""))
    } catch let error as GatewayRPCError {
      outcome = Self.phase(after: error)
    } catch {
      outcome = .notSent("The answer did not reach the gateway.")
    }

    // Re-check after the suspension: a `request.cancel` may have ended it already. Only
    // `verification_failed` overrides an answer that went through, and it comes later.
    guard confirmation(id)?.phase == .sending else {
      return
    }

    // A call that got no reply may have been delivered: for an assertion that is remembered, and
    // nothing said from here on claims that nothing was confirmed.
    if done == .received, case .notSent = outcome {
      markAnswerMayHaveArrived(id)
    }

    setPhase(id, outcome)
    // The countdown ran out while this was in flight: now it can end.
    await endIfExpired(id)
  }

  /// What a refused `request.answer` means for the confirmation.
  static func phase(after error: GatewayRPCError) -> PasskeyConfirmPhase {
    guard error.kind == .rejected else {
      return .notSent(error.message)
    }

    let reason = error.data?["reason"]?.stringValue ?? ""

    if error.code == notAllowedCode {
      return .ended(.notAllowed)
    }

    guard error.code == refusedCode else {
      return .notSent(error.message)
    }

    return reason == RequestCancelReason.tooManyAttempts.rawValue ? .ended(.tooManyAttempts) : .refused(reason: reason)
  }

  // MARK: - Withdrawals

  /// `request.cancel` for one of ours: the reason is the outcome.
  func withdrawn(_ id: String, reason: RequestCancelReason) async {
    guard let current = confirmation(id) else {
      return
    }

    let answered = current.phase == .received || current.phase == .declined || current.phase == .sending
    let next: PasskeyConfirmPhase?

    switch reason {
    case .verificationFailed:
      // The one reason that overrides an answer that went through: it is NOT confirmed.
      next = .ended(.verificationFailed)
    case .tooManyAttempts:
      next = .ended(.tooManyAttempts)
    case .resolved:
      next = answered ? nil : .ended(.answeredElsewhere)
    case .timeout:
      next = answered ? nil : .ended(.timedOut)
    default:
      next = answered ? nil : .ended(.withdrawn(reason: reason.rawValue))
    }

    guard let next else {
      return
    }

    // The phase moves first: a ceremony that returns while `cancel()` runs finds the request
    // over and sends nothing. (`setPhase` words an ending after a possible delivery as unknown.)
    let signing = current.phase == .signing
    setPhase(id, next)

    if signing {
      await authenticator.cancel()
    }
  }
}
