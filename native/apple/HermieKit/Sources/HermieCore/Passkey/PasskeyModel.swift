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

  /// What the challenge of each open confirmation commits to, and where to answer it.
  @ObservationIgnored var contexts: [String: ConfirmContext] = [:]
  /// Credential ids this device is adding or revoking: their `passkey.changed` is no news.
  @ObservationIgnored var expectedAdditions: Set<String> = []
  @ObservationIgnored var expectedRevocations: Set<String> = []
  @ObservationIgnored var pin = PasskeyPinRecord()
  @ObservationIgnored var foreignGatewayIDs: Set<String> = []
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
  public init(
    storedGatewayID: String,
    address: String,
    link: any GatewayLink,
    client: PasskeyClient?,
    authenticator: any PasskeyAuthenticator,
    configuration: PasskeyConfiguration,
    pins: any PasskeyPinStore,
    source: ConfirmCapabilitySource?,
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

    switch report.verdict {
    case .gatewayIDMismatch:
      notify(.gatewayIDMismatch)
    case .gatewayIDConflict:
      notify(.gatewayIDConflict)
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

  func notify(_ kind: PasskeyNotice.Kind) {
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

  func setPhase(_ id: String, _ phase: PasskeyConfirmPhase) {
    guard let index = confirmations.firstIndex(where: { $0.id == id }) else {
      return
    }

    confirmations[index].phase = phase

    if !phase.isOpen {
      contexts[id] = nil
    }
  }

  // MARK: - Pins and policy

  func loadPins() async {
    pin = await pins.record(for: storedGatewayID)
    foreignGatewayIDs = await pins.foreignGatewayIDs(except: storedGatewayID)
  }

  func savePin() async {
    pin.seenAt = now()
    await pins.save(pin, for: storedGatewayID)
  }

  /// The advertising policy from what this device knows now. A build without an RP, or a gateway
  /// address that cannot be a base URL, advertises no passkey.
  var policy: ConfirmCapabilityPolicy {
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
      )
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

  /// A `gateway_id` presented by the gateway, checked against the pins (contract §10).
  func pinProblem(_ gatewayID: String) -> PasskeyNotice.Kind? {
    if let pinned = pin.gatewayID, pinned != gatewayID {
      return .gatewayIDMismatch
    }

    return foreignGatewayIDs.contains(gatewayID) ? .gatewayIDConflict : nil
  }
}
