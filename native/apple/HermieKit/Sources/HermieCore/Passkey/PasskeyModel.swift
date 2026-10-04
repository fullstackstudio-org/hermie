import Foundation
import HermieGateway
import HermieProtocol
import Observation

/**
 One gateway's passkeys (plan `confirm-passkey.md`, contract `contract/confirm-passkey/`): the
 `confirm` requests at level `passkey`, enrolment with an operator's code, the step-ups that mint an
 invite or revoke a credential, the credential list, and the `client.capabilities` advertisement.

 How it answers, and what it never does:

 - every answer goes through `request.answer`, so a refusal comes back (4033, 4034 with a reason);
   `ok` means "received and valid", never "confirmed" (`PasskeyConfirmPhase.received`), and the
   `request.cancel` reasons are the outcome; a client never sends `verified`;
 - a decline is exactly `{decision: "declined", method: "tap"}`;
 - when the ceremony cannot run here, the frame is answered with error 4040 and `data.reason`;
 - a frame without a credential for this build's RP, with an unknown `v`, or whose `gateway_id`
   breaks the pin is refused (4040) AND leaves a notice: never a silent failure;
 - nothing from a frame, an assertion or a code is logged.

 The challenge is computed from the `ConfirmDisplay` the sheet shows and nothing else of its kind.
 */
@MainActor
@Observable
public final class PasskeyModel {
  /// The last `GET /api/auth/passkeys`, `nil` until one answered.
  public internal(set) var status: PasskeyStatus?
  /// Why the last read failed (`notOffered` on a gateway without the routes).
  public internal(set) var statusError: PasskeyRouteError?
  /// The signed-in user's active credentials, every RP.
  public internal(set) var credentials: [PasskeyCredentialInfo] = []
  /// Open confirmations first, then the most recent finished ones.
  public private(set) var confirmations: [PasskeyConfirmation] = []
  public private(set) var notices: [PasskeyNotice] = []
  /// The last `client.capabilities` run on this connection.
  public private(set) var capability: ConfirmCapabilityReport?
  /// Adding a passkey by signing in again, while it runs and after it ended (`nil` when none was
  /// started, or after `forgetSelfEnrolment()`).
  public internal(set) var selfEnrolment: PasskeySelfEnrolment?

  @ObservationIgnored public let configuration: PasskeyConfiguration
  /// The serialised base URL of the stored gateway, `nil` when its address cannot be one.
  @ObservationIgnored public let baseURL: String?
  @ObservationIgnored let storedGatewayID: String
  @ObservationIgnored let link: any GatewayLink
  @ObservationIgnored let client: PasskeyClient?
  @ObservationIgnored let authenticator: any PasskeyAuthenticator
  @ObservationIgnored let pins: any PasskeyPinStore
  @ObservationIgnored let source: ConfirmCapabilitySource?
  @ObservationIgnored let now: @Sendable () -> Double
  /// Signs in again for a self-enrolment grant; `nil`: this session cannot (no browser sign-in).
  @ObservationIgnored let reauthenticator: (any PasskeyReauthenticating)?
  /// The self-enrolment step running, by its number: another is `busy` meanwhile. A forget or a
  /// shutdown lets go of it, and a step that finds it is no longer the one running drops its result.
  @ObservationIgnored var selfEnrolmentRun: UInt64?
  /// The last step's number.
  @ObservationIgnored var selfEnrolmentAttempt: UInt64 = 0

  /// What the challenge of each open confirmation commits to, and where to answer it.
  @ObservationIgnored var contexts: [String: ConfirmContext] = [:]
  /// Credential ids this device is adding or revoking: their `passkey.changed` is no news.
  @ObservationIgnored var expectedAdditions: Set<String> = []
  @ObservationIgnored var expectedRevocations: Set<String> = []
  @ObservationIgnored var pin = PasskeyPinRecord()
  /// What is stored for this gateway is not a record: it is never written over.
  @ObservationIgnored var pinUnreadable = false
  /// The other stored gateways' pins, read again before every check (another session may have
  /// pinned meanwhile).
  @ObservationIgnored var others: [PasskeyOtherPin] = []
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var started = false
  @ObservationIgnored var isShutDown = false
  @ObservationIgnored private var nextNoticeID: UInt64 = 0

  /// At most this many finished confirmations are kept for the sheet to show their end.
  static let finishedKept = 20

  struct ConfirmContext {
    var inbound: InboundRequest
    var binding: PasskeyChallengeBinding
    var allowCredentialIDs: [[UInt8]]
  }

  /// - Parameters:
  ///   - storedGatewayID: the registry's id of the gateway (the pins' key).
  ///   - address: the stored gateway address; the challenge commits to its base URL (contract §3).
  ///   - client: the REST routes; `nil` for a link without them (a test of the confirm path only).
  ///   - source: what the connection advertises from; the model keeps its policy current.
  ///   - reauthenticator: the browser sign-in that completes a self-enrolment grant.
  public init(
    storedGatewayID: String,
    address: String,
    link: any GatewayLink,
    client: PasskeyClient?,
    authenticator: any PasskeyAuthenticator,
    configuration: PasskeyConfiguration,
    pins: any PasskeyPinStore,
    source: ConfirmCapabilitySource?,
    reauthenticator: (any PasskeyReauthenticating)? = nil,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.storedGatewayID = storedGatewayID
    self.baseURL = try? GatewayAddress.passkeyBaseURL(of: address)
    self.link = link
    self.client = client
    self.authenticator = authenticator
    self.configuration = configuration
    self.pins = pins
    self.source = source
    self.reauthenticator = reauthenticator
    self.now = now
  }

  // MARK: - Lifecycle

  /// Read the pins, set the advertising policy and subscribe to the link's server requests and
  /// events. Call (and await) before the link starts, as the session does.
  public func start() async {
    guard !started, !isShutDown else {
      return
    }

    started = true
    // The pins first: a frame is checked against them the moment it arrives.
    await loadPins()
    applyPolicy()

    // Subscribed before the link starts, so nothing it delivers from its start is missed.
    let requests = link.serverRequests
    let events = link.events
    let reports = source?.reports

    tasks.append(
      Task { [weak self] in
        for await inbound in requests where inbound.method == ServerRequestBody.Method.confirm {
          await self?.ingest(inbound)
        }
      }
    )
    // Off the main actor: the stream carries every token of every reply, and only two types
    // are this model's business.
    tasks.append(
      Task.detached { [weak self] in
        for await wire in events where Self.isOurs(wire.event.type) {
          await self?.receive(wire.event)
        }
      }
    )

    if let reports {
      tasks.append(
        Task { [weak self] in
          for await report in reports {
            await self?.receive(report)
          }
        }
      )
    }
  }

  /// Stop listening; every open confirmation is left to the gateway's deadline.
  public func shutdown() async {
    guard !isShutDown else {
      return
    }

    isShutDown = true

    for task in tasks {
      task.cancel()
    }

    tasks.removeAll()
    contexts.removeAll()
    // A self-enrolment ends with the session: its sheet closes, and nothing of the grant is kept.
    selfEnrolment = nil
    selfEnrolmentRun = nil
    await reauthenticator?.cancel()
    await authenticator.cancel()
  }

  /// The person closed a notice.
  public func dismissNotice(_ id: UInt64) {
    notices.removeAll { $0.id == id }
  }

  /// A confirmation by id.
  public func confirmation(_ id: String) -> PasskeyConfirmation? {
    confirmations.first { $0.id == id }
  }

  // MARK: - Events

  nonisolated static func isOurs(_ type: String) -> Bool {
    type == GatewayEventType.requestCancel || type == PasskeyChangedPayload.eventType
  }

  private func receive(_ event: GatewayEvent) async {
    switch event.type {
    case GatewayEventType.requestCancel:
      let payload = RequestCancelPayload(json: event.payload?.objectValue ?? [:])
      await withdrawn(payload.id ?? "", reason: payload.cancelReason ?? .unknown(""))
    case PasskeyChangedPayload.eventType:
      await changed(PasskeyChangedPayload(json: event.payload?.objectValue ?? [:]))
    default:
      return
    }
  }

  private func receive(_ report: ConfirmCapabilityReport) async {
    capability = report
    await loadOthers()

    // Another session pinned or linked since the policy this run decided from: run it again.
    if applyPolicy() {
      await link.refreshCapabilities()
      return
    }

    switch report.verdict {
    case .gatewayIDMismatch:
      notify(.gatewayIDMismatch)
    case .gatewayIDConflict(let presented):
      notify(pinProblem(presented) ?? .gatewayIDConflict)
    case .notEnrolled:
      // A passkey synced from another device, or enrolled in a browser: read the list.
      await refresh()
    case .advertised, .notOffered, .unavailable, .rpNotAccepted:
      if status == nil, report.first?.confirmPasskey != nil {
        await refresh()
      }
    }
  }

  /// `passkey.changed`: a credential of this account was added or revoked somewhere.
  private func changed(_ payload: PasskeyChangedPayload) async {
    let id = payload.credential?.id ?? ""
    let name = payload.credential?.name ?? ""

    switch payload.change {
    case .added?:
      if !expectedAdditions.contains(id), !pin.knownCredentialIDs.contains(id) {
        notify(.credentialAdded(name: name))
      }
    case .revoked?:
      if !expectedRevocations.contains(id), pin.knownCredentialIDs.contains(id) {
        notify(.credentialRevoked(name: name))
      }
    default:
      break
    }

    await refresh()
  }

  // MARK: - Notices

  func notify(_ unchecked: PasskeyNotice.Kind) {
    let kind = Self.bounded(unchecked)

    guard !notices.contains(where: { $0.kind == kind }) else {
      return
    }

    nextNoticeID += 1
    notices.append(PasskeyNotice(id: nextNoticeID, kind: kind, at: now()))
  }

  // MARK: - Confirmations list

  func upsert(_ confirmation: PasskeyConfirmation) {
    if let index = confirmations.firstIndex(where: { $0.id == confirmation.id }) {
      confirmations[index] = confirmation
    } else {
      confirmations.append(confirmation)
    }

    let finished = confirmations.filter { !$0.isOpen }

    if finished.count > Self.finishedKept {
      let drop = Set(finished.prefix(finished.count - Self.finishedKept).map(\.id))
      confirmations.removeAll { drop.contains($0.id) }
    }
  }

  /// An ending that would say "nothing was confirmed" is `outcomeUnknown` once an assertion may
  /// have been delivered. What the gateway decided itself (`verification_failed`, too many
  /// attempts, not allowed) keeps its meaning, and so does a reply of `ok`.
  static func worded(_ phase: PasskeyConfirmPhase, mayHaveArrived: Bool) -> PasskeyConfirmPhase {
    guard mayHaveArrived, case .ended(let end) = phase else {
      return phase
    }

    switch end {
    case .timedOut, .answeredElsewhere, .withdrawn, .unavailable:
      return .ended(.outcomeUnknown)
    case .tooManyAttempts, .verificationFailed, .notAllowed, .outcomeUnknown:
      return phase
    }
  }

  /// The name of a passkey, which the gateway holds: one line, no control or direction characters,
  /// bounded (`SecurePrompt.displayText`), whatever the account holds.
  public static func displayName(_ raw: String?) -> String {
    SecurePrompt.displayText(raw, limit: SecurePrompt.nameLimit).replacingOccurrences(of: "\n", with: " ")
  }

  static func bounded(_ kind: PasskeyNotice.Kind) -> PasskeyNotice.Kind {
    switch kind {
    case .credentialAdded(let name):
      .credentialAdded(name: displayName(name))
    case .credentialRevoked(let name):
      .credentialRevoked(name: displayName(name))
    default:
      kind
    }
  }

  func markAnswerMayHaveArrived(_ id: String) {
    guard let index = confirmations.firstIndex(where: { $0.id == id }) else {
      return
    }

    confirmations[index].answerMayHaveArrived = true
  }

  func setPasskeyMissingHere(_ id: String, _ missing: Bool) {
    guard let index = confirmations.firstIndex(where: { $0.id == id }),
      confirmations[index].passkeyMissingHere != missing
    else {
      return
    }

    confirmations[index].passkeyMissingHere = missing
  }

  func setPhase(_ id: String, _ phase: PasskeyConfirmPhase) {
    guard let index = confirmations.firstIndex(where: { $0.id == id }) else {
      return
    }

    confirmations[index].phase = Self.worded(phase, mayHaveArrived: confirmations[index].answerMayHaveArrived)

    if !phase.isOpen {
      contexts[id] = nil
    }
  }

  // MARK: - Pins and policy

  func loadPins() async {
    switch await pins.read(storedGatewayID) {
    case .record(let record):
      pin = record
      pinUnreadable = false
    case .unreadable:
      pin = PasskeyPinRecord()
      pinUnreadable = true
      notify(.pinUnreadable(storedGatewayID: storedGatewayID))
    }

    await loadOthers()
  }

  /// Read the other gateways' pins again.
  func loadOthers() async {
    others = await pins.others(except: storedGatewayID)
  }

  /// Write this gateway's record, never over one that could not be read.
  func savePin() async {
    guard !pinUnreadable else {
      return
    }

    pin.seenAt = now()
    await pins.save(pin, for: storedGatewayID)
  }

  /// The person said `other` is this same gateway: the two records describe one gateway.
  func isLinked(_ other: PasskeyOtherPin) -> Bool {
    pin.linkedGatewayIDs.contains(other.storedGatewayID)
      || other.record?.linkedGatewayIDs.contains(storedGatewayID) == true
  }

  /// The `gateway_id`s pinned for every other stored gateway that is not this one.
  var foreignGatewayIDs: Set<String> {
    Set(others.filter { !isLinked($0) }.compactMap(\.record?.gatewayID))
  }

  /// The credential ids pinned for every other stored gateway that is not this one: never offered
  /// to this gateway's sheet.
  var foreignCredentialIDs: Set<String> {
    Set(others.filter { !isLinked($0) }.flatMap { $0.record?.appCredentialIDs ?? [] })
  }

  /// "Same gateway as <name>": the person confirmed that the stored gateway `otherGatewayID`, whose
  /// pinned `gateway_id` this gateway presents, is this gateway under another address. This
  /// gateway's pins take that `gateway_id` and its credential ids, and record the link, so neither
  /// side reads the other as a conflict again. `false` when there is nothing to link: no stored
  /// gateway by that id, no pin there, or this gateway is pinned to another id already.
  @discardableResult
  public func linkPins(with otherGatewayID: String) async -> Bool {
    await loadOthers()

    guard !pinUnreadable, let other = others.first(where: { $0.storedGatewayID == otherGatewayID }),
      other.name != nil, let record = other.record, let shared = record.gatewayID,
      pin.gatewayID == nil || pin.gatewayID == shared
    else {
      return false
    }

    pin.gatewayID = shared
    pin.knownCredentialIDs = Self.union(pin.knownCredentialIDs, record.knownCredentialIDs)
    pin.appCredentialIDs = Self.union(pin.appCredentialIDs, record.appCredentialIDs)
    pin.deviceCredentialIDs = Self.union(pin.deviceCredentialIDs, record.deviceCredentialIDs)
    pin.linkedGatewayIDs = Self.union(pin.linkedGatewayIDs, [otherGatewayID])
    await savePin()

    notices.removeAll { notice in
      guard case .sameGatewayAs(let id, _) = notice.kind else { return false }
      return id == otherGatewayID
    }

    await policyChanged()
    await refresh()
    return true
  }

  /// None of `allowed` is a passkey this device is known to hold (one it made, or signed with, here).
  /// The system answers "no passkey on this device" and a dismissal with the same cancellation, so a
  /// cancellation only reads as the first when this is so: a device that has answered with one of these
  /// passkeys before is trusted to have offered it, and its dismissal stays a plain one.
  func holdsNoneHere(_ allowed: [[UInt8]]) -> Bool {
    let held = Set(pin.deviceCredentialIDs)

    return !allowed.contains { held.contains(Base64URL.encode($0)) }
  }

  /// This device signed with `credentialID`: it holds that passkey.
  func rememberHere(_ credentialID: [UInt8]) async {
    let id = Base64URL.encode(credentialID)

    guard !pin.deviceCredentialIDs.contains(id) else {
      return
    }

    pin.deviceCredentialIDs.append(id)
    await savePin()
  }

  private static func union(_ first: [String], _ second: [String]) -> [String] {
    first + second.filter { !first.contains($0) }
  }

  /// The advertising policy from what this device knows now. A build without an RP, or a gateway
  /// address that cannot be a base URL, advertises no passkey.
  var policy: ConfirmCapabilityPolicy {
    // This model draws a confirmation's structured fields and, at level `passkey`, commits to them
    // (`text_digest_v2`). Fields are advertised only beside a level this app actually renders: `plain`
    // confirmations are declined here, so `confirm_fields` never rides next to them, and a passkey that
    // is not advertised (no credential on this device yet) takes no request with fields either.
    guard let rpID = configuration.rpID, baseURL != nil else {
      return ConfirmCapabilityPolicy(plain: configuration.plain)
    }

    return ConfirmCapabilityPolicy(
      plain: configuration.plain,
      passkey: PasskeyAdvertisingPolicy(
        kind: configuration.kind,
        rpID: rpID,
        hasCredential: !pin.appCredentialIDs.isEmpty,
        pinnedGatewayID: pin.gatewayID,
        foreignGatewayIDs: foreignGatewayIDs
      ),
      fields: !pin.appCredentialIDs.isEmpty
    )
  }

  /// Hand the policy to the connection; `true` when it changed.
  @discardableResult
  func applyPolicy() -> Bool {
    guard let source else {
      return false
    }

    let next = policy

    guard source.policy != next else {
      return false
    }

    source.setPolicy(next)
    return true
  }

  /// Re-advertise when what this device can do changed.
  func policyChanged() async {
    if applyPolicy() {
      await link.refreshCapabilities()
    }
  }

  /// A `gateway_id` presented by the gateway, checked against the pins (contract §10). One pinned
  /// for another stored gateway is a question ("same gateway as <name>"); one pinned for a gateway
  /// no longer in the list is a conflict.
  func pinProblem(_ gatewayID: String) -> PasskeyNotice.Kind? {
    if pinUnreadable {
      return .pinUnreadable(storedGatewayID: storedGatewayID)
    }

    if let pinned = pin.gatewayID, pinned != gatewayID {
      return .gatewayIDMismatch
    }

    guard let other = others.first(where: { !isLinked($0) && $0.record?.gatewayID == gatewayID }) else {
      return nil
    }

    guard let name = other.name else {
      return .gatewayIDConflict
    }

    return .sameGatewayAs(storedGatewayID: other.storedGatewayID, name: name)
  }

  /// The 4040 `data.reason` for a frame refused over the pins.
  static func reason(for problem: PasskeyNotice.Kind) -> String {
    switch problem {
    case .gatewayIDMismatch: "gateway_id_mismatch"
    case .pinUnreadable: "pin_unreadable"
    default: "gateway_id_conflict"
    }
  }
}
