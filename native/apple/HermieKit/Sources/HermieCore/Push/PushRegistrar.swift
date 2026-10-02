import Foundation
import os

/// The inputs of a pass that come from outside the registrar: the device and the reader.
public struct PushContext: Sendable, Equatable {
  public var token: APNsDeviceToken?
  public var environment: APNsEnvironment
  public var topic: String
  /// Switched on and permitted.
  public var wanted: Bool
  /// The gateways that should be registered, most important first. A gateway that is signed out
  /// of is left out. Only ever a KNOWN list: an unread or unreadable gateway list is not a context.
  public var gatewayIds: [String]

  public init(token: APNsDeviceToken?, environment: APNsEnvironment, topic: String, wanted: Bool, gatewayIds: [String]) {
    self.token = token
    self.environment = environment
    self.topic = topic
    self.wanted = wanted
    self.gatewayIds = gatewayIds
  }
}

/// Why a step did not complete. Never carries a secret.
public enum PushPassFailure: Error, Sendable, Equatable {
  case relay(PushRelayError)
  /// The registration could not be read or written on this device.
  case storage
}

/// What a gateway's push row should say, as far as this device can tell.
public enum PushAddressState: Sendable, Equatable {
  /// Registered: write this.
  case registered(PushRelayAddress)
  /// Nothing registered (off, removed, never made): remove the row.
  case none
  /// The registration or its secrets cannot be read right now: leave the row as it is.
  case unknown
}

/// What one pass ended with.
public struct PushPassReport: Sendable, Equatable {
  /// The registrations held after the pass, by gateway id. Meaningless when `skipped`.
  public var registrations: [String: PushRegistration]
  /// The steps that failed, by gateway id. They are tried again on the next pass.
  public var failures: [String: PushPassFailure]
  /// The gateways whose address (handle and send secret) appeared, changed or went away in this
  /// pass: the ones whose ui_meta push row has to be written again.
  public var addressChanged: Set<String>
  /// The steps the planner asked for, in order. For tests and the developer row.
  public var steps: [PushStep]
  /// The stored registrations could not be read, so nothing was planned or done.
  public var skipped: Bool
  /// Registrations whose record was lost (a reinstall) that this pass revoked at the relay.
  public var orphansRevoked: Int = 0
  /// Gateways whose map entry this build cannot decode; kept, skipped, never written over.
  public var undecodable: [String] = []

  public init(
    registrations: [String: PushRegistration] = [:],
    failures: [String: PushPassFailure] = [:],
    addressChanged: Set<String> = [],
    steps: [PushStep] = [],
    skipped: Bool = false
  ) {
    self.registrations = registrations
    self.failures = failures
    self.addressChanged = addressChanged
    self.steps = steps
    self.skipped = skipped
  }
}

/**
 Carries out `PushPlan` against the relay and the registration store: the effectful shell around a
 pure decision, and the only owner of the registrations and their secrets.

 Passes run one at a time, in the order they were asked for: a pass awaits the one before it, then
 plans from what the store holds at that moment and the context it was handed. Each call carries
 the newest context, so the last pass always converges on it.

 Failures are kept, never retried in a loop: a failed step is planned again by the next pass, which
 comes with the next launch, token, switch or gateway change. A `429` stops every further call in
 the same pass. A registration that could not be stored is not tried again for that gateway for a
 day or until the next launch, so a keychain this build cannot write to does not turn every pass
 into a register-and-revoke.

 Unknown is never read as none: registrations that cannot be read skip the pass, and a gateway
 whose secrets cannot be read right now is left exactly as it is.
 */
public actor PushRegistrar {
  public nonisolated let client: any PushRelayClient
  private let store: any PushRegistrationStoring
  private let clock: @Sendable () -> Double
  private var tail: Task<Void, Never>?
  /// When storing a gateway's new registration last failed, in Unix seconds. Memory only.
  private var storeFailedAt: [String: Double] = [:]
  /// Whether this launch has looked for manage secrets whose record is gone.
  private var orphansSwept = false

  /// How long a gateway whose registration could not be stored is left alone.
  public static let storeFailureBackoff: Double = 86_400

  /// - Parameter clock: Unix seconds. Injected so the daily rule is tested without waiting.
  public init(
    client: any PushRelayClient,
    store: any PushRegistrationStoring,
    clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.client = client
    self.store = store
    self.clock = clock
  }

  /// Plan and carry out one pass.
  @discardableResult
  public func reconcile(_ context: PushContext) async -> PushPassReport {
    await serialized { registrar in await registrar.pass(context) }
  }

  /**
   Revoke one gateway's registration now: the sign-out seam. The caller also stops listing the
   gateway in later contexts, or the next pass registers it again.

   Returns true only when nothing is left at the relay to revoke (deleted, unknown to it, or never
   registered). On a network or read failure the record is kept, so a later pass that no longer
   lists the gateway deletes it then.
   */
  @discardableResult
  public func retire(gatewayId: String) async -> Bool {
    await serialized { registrar in await registrar.retireNow(gatewayId) }
  }

  /// The address a gateway's push row is written from, or nil when there is no usable registration
  /// (or it cannot be read; `addressState` tells the two apart).
  public func address(gatewayId: String) async -> PushRelayAddress? {
    if case .registered(let address) = await addressState(gatewayId: gatewayId) { address } else { nil }
  }

  /// What a gateway's push row should say: registered, none, or unknown (unreadable right now).
  public func addressState(gatewayId: String) async -> PushAddressState {
    let stored: [PushRegistration]
    let undecodable: [String]

    do {
      stored = try await store.registrations()
      undecodable = try await store.undecodable()
    } catch {
      return .unknown
    }

    if undecodable.contains(gatewayId) {
      return .unknown
    }

    guard let registration = stored.first(where: { $0.gatewayId == gatewayId }), registration.relay == client.origin
    else {
      return .none
    }

    let secrets: PushRegistrationSecrets

    do {
      secrets = try await store.secrets(gatewayId: gatewayId)
    } catch {
      return .unknown
    }

    guard let sendSecret = secrets.sendSecret else {
      // The next pass revokes it and registers again; until then there is nothing to send with.
      return .none
    }

    return .registered(
      PushRelayAddress(
        relay: registration.relay,
        handle: registration.handle,
        sendSecret: sendSecret,
        platform: PushRelayAddress.currentPlatform,
        updatedAt: registration.refreshedAt
      )
    )
  }

  /// The stored registrations, without their secrets; nil when they cannot be read.
  public func registrations() async -> [PushRegistration]? {
    try? await store.registrations()
  }

  /**
   Start over on this device: revoke every registration a manage secret in the keychain still
   names (record or not), drop the stored map even when it cannot be read, and forget the
   back-offs. For Settings' "Reset notifications on this device". Returns the gateways whose
   registration could not be revoked (their secrets are kept, so a later reset can try again).
   */
  @discardableResult
  public func resetDevice() async -> [String] {
    await serialized { registrar in await registrar.resetNow() }
  }

  // MARK: Ordering

  private func serialized<T: Sendable>(_ body: @escaping @Sendable (isolated PushRegistrar) async -> T) async -> T {
    let previous = tail
    let task = Task<T, Never> {
      await previous?.value
      return await body(self)
    }

    tail = Task { _ = await task.value }

    return await task.value
  }

  // MARK: Passes

  private func pass(_ context: PushContext) async -> PushPassReport {
    let now = clock()
    var report = PushPassReport()

    let stored: [PushRegistration]

    do {
      stored = try await store.registrations()
    } catch {
      // Without knowing what is registered, anything done now could duplicate a registration or
      // leave one unrevoked.
      PushLog.logger.error("push: registrations unreadable, pass skipped")
      report.skipped = true
      report.failures = Dictionary(context.gatewayIds.map { ($0, .storage) }, uniquingKeysWith: { first, _ in first })
      return report
    }

    var records: [PushPlanRecord] = []
    // A keychain that cannot be read right now (before the first unlock, say) is not one that has
    // lost the secrets, and an entry this build cannot decode is not an absent one: such a gateway
    // is left exactly as it is, slot included, until a pass can read it.
    var unreadable = Set((try? await store.undecodable()) ?? [])

    report.undecodable = unreadable.sorted()

    if !orphansSwept {
      let sweep = await sweepOrphans(known: Set(stored.map(\.gatewayId)).union(unreadable))
      report.orphansRevoked = sweep.revoked

      // A gateway whose old registration could not be revoked is left alone this pass: registering
      // it now would put a new manage secret where the only copy of the old one is.
      for id in sweep.unfinished {
        unreadable.insert(id)
        report.failures[id] = .storage
      }
    }

    for registration in stored {
      do {
        let secrets = try await store.secrets(gatewayId: registration.gatewayId)
        records.append(
          PushPlanRecord(
            registration: registration,
            hasManageSecret: secrets.manageSecret != nil,
            hasSendSecret: secrets.sendSecret != nil
          )
        )
      } catch {
        unreadable.insert(registration.gatewayId)
        report.failures[registration.gatewayId] = .storage
      }
    }

    let backedOff = Set(
      storeFailedAt.filter { abs(now - $0.value) < Self.storeFailureBackoff }.keys
    )

    for id in backedOff {
      report.failures[id] = .storage
    }

    let input = PushPlanInput(
      now: now,
      token: context.token,
      environment: context.environment,
      topic: context.topic,
      relay: client.origin,
      wanted: context.wanted,
      gatewayIds: context.gatewayIds,
      stored: records,
      backedOff: backedOff,
      frozen: unreadable
    )

    let steps = PushPlan.steps(input)
    var held = Dictionary(stored.map { ($0.gatewayId, $0) }, uniquingKeysWith: { first, _ in first })
    var halted: PushRelayError?

    report.steps = steps

    for step in steps {
      let id = step.gatewayId

      // A rate limit is for the device, not one gateway: nothing else is sent in this pass.
      if let halted, step.needsRelay {
        report.failures[id] = .relay(halted)
        continue
      }

      switch step {
      case .forget(_, let reason):
        if await forget(id) {
          held[id] = nil
          report.addressChanged.insert(id)
          PushLog.logger.info("push: forgot \(id, privacy: .public) (\(reason.rawValue, privacy: .public))")
        } else {
          report.failures[id] = .storage
        }

      case .delete(_, let reason):
        guard let registration = held[id] else {
          continue
        }

        switch await revoke(registration) {
        case .success:
          held[id] = nil
          report.addressChanged.insert(id)
          PushLog.logger.info("push: deleted \(id, privacy: .public) (\(reason.rawValue, privacy: .public))")
        case .failure(let failure):
          report.failures[id] = failure
          halted = failure.rateLimit ?? halted
        }

      case .register:
        // A replaced registration that could not be revoked is not registered over.
        guard let token = context.token, held[id] == nil else {
          continue
        }

        switch await register(id, token: token, context: context, now: now) {
        case .success(let registration):
          held[id] = registration
          report.addressChanged.insert(id)
          report.failures[id] = nil
        case .failure(let failure):
          report.failures[id] = failure
          halted = failure.rateLimit ?? halted
        }

      case .refresh(_, let reason):
        guard let token = context.token, let registration = held[id] else {
          continue
        }

        switch await refresh(registration, token: token, context: context, now: now, reason: reason) {
        case .success(let outcome):
          held[id] = outcome.registration
          if outcome.replaced {
            report.addressChanged.insert(id)
          }
        case .failure(let failure):
          report.failures[id] = failure
          halted = failure.rateLimit ?? halted
        }
      }
    }

    report.registrations = held
    return report
  }

  /// Revoke what a manage secret names when no record does (a reinstall keeps the keychain and
  /// loses the database), and every registration kept for revoking; then delete the item. Returns
  /// how many were revoked and the gateways whose orphan (not a pending one) is still held. Stays
  /// due until a sweep had nothing it could not finish.
  private func sweepOrphans(known: Set<String>) async -> (revoked: Int, unfinished: Set<String>) {
    guard let held = try? await store.heldCapabilities() else {
      return (0, [])
    }

    var revoked = 0
    var unfinished = Set<String>()
    var failed = false

    for capability in held where capability.pendingRevoke || !known.contains(capability.gatewayId) {
      switch await revokeHeld(capability) {
      case .revoked:
        revoked += 1
      case .dropped:
        break
      case .failed:
        failed = true

        if !capability.pendingRevoke {
          unfinished.insert(capability.gatewayId)
        }
      }
    }

    orphansSwept = !failed
    return (revoked, unfinished)
  }

  private enum HeldOutcome {
    case revoked
    /// Nothing that could be revoked from here (no handle, another relay); the secrets are gone.
    case dropped
    case failed
  }

  private func revokeHeld(_ capability: PushHeldCapability) async -> HeldOutcome {
    let id = capability.gatewayId

    guard let handle = capability.handle, capability.relay == client.origin else {
      return (try? await store.removeHeld(capability)) != nil ? .dropped : .failed
    }

    do {
      try await client.delete(handle: handle, manageSecret: capability.manageSecret)
    } catch where error.capabilityLost {
      // Already gone at the relay.
    } catch {
      PushLog.logger.notice("push: orphan delete failed for \(id, privacy: .public): \(error.description, privacy: .public)")
      return .failed
    }

    PushLog.logger.info("push: revoked an orphaned registration for \(id, privacy: .public)")
    return (try? await store.removeHeld(capability)) != nil ? .revoked : .failed
  }

  private func resetNow() async -> [String] {
    var failed: [String] = []

    for capability in (try? await store.heldCapabilities()) ?? [] {
      if case .failed = await revokeHeld(capability) {
        failed.append(capability.gatewayId)
      }
    }

    try? await store.clearRecords()
    storeFailedAt = [:]
    orphansSwept = true

    return failed.sorted()
  }

  private func retireNow(_ gatewayId: String) async -> Bool {
    let stored: [PushRegistration]

    do {
      stored = try await store.registrations()
    } catch {
      return false
    }

    guard let registration = stored.first(where: { $0.gatewayId == gatewayId }) else {
      return true
    }

    guard registration.relay == client.origin else {
      return await forget(gatewayId)
    }

    switch await revoke(registration) {
    case .success:
      PushLog.logger.info("push: deleted \(gatewayId, privacy: .public) (signed out)")
      return true
    case .failure:
      return false
    }
  }

  // MARK: Steps

  private func forget(_ gatewayId: String) async -> Bool {
    do {
      try await store.remove(gatewayId: gatewayId)
      return true
    } catch {
      return false
    }
  }

  /// `DELETE`, then forget. A relay that no longer knows the handle has nothing left to revoke.
  private func revoke(_ registration: PushRegistration) async -> Result<Void, PushPassFailure> {
    let id = registration.gatewayId
    let manageSecret: String?

    do {
      manageSecret = try await store.secrets(gatewayId: id).manageSecret
    } catch {
      return .failure(.storage)
    }

    guard let manageSecret else {
      // Nothing to revoke with, and the relay only sweeps a registration that went 180 days with
      // no send and no refresh: if a gateway keeps sending to it, it lives on. Nothing here can
      // change that; the record goes so it is not retried for ever.
      return await forget(id) ? .success(()) : .failure(.storage)
    }

    do {
      try await client.delete(handle: registration.handle, manageSecret: manageSecret)
    } catch where error.capabilityLost {
      // Already gone at the relay.
    } catch {
      PushLog.logger.notice("push: delete failed for \(id, privacy: .public): \(error.description, privacy: .public)")
      return .failure(.relay(error))
    }

    return await forget(id) ? .success(()) : .failure(.storage)
  }

  private func register(_ gatewayId: String, token: APNsDeviceToken, context: PushContext, now: Double) async
    -> Result<PushRegistration, PushPassFailure>
  {
    let capability: PushCapability

    do {
      capability = try await client.register(token: token, environment: context.environment, topic: context.topic)
    } catch {
      PushLog.logger.notice(
        "push: register failed for \(gatewayId, privacy: .public): \(error.description, privacy: .public)")
      return .failure(.relay(error))
    }

    let registration = PushRegistration(
      gatewayId: gatewayId,
      handle: capability.handle,
      relay: client.origin,
      topic: context.topic,
      environment: context.environment,
      tokenFingerprint: token.fingerprint,
      refreshedAt: now
    )

    do {
      try await store.save(registration, secrets: capability)
    } catch {
      // A registration this device cannot remember is one nobody can revoke: take it back now,
      // while the manage secret is still in hand, and leave this gateway alone for a while.
      try? await client.delete(handle: capability.handle, manageSecret: capability.manageSecret)
      try? await store.remove(gatewayId: gatewayId)
      storeFailedAt[gatewayId] = now
      PushLog.logger.error("push: registration for \(gatewayId, privacy: .public) could not be stored")
      return .failure(.storage)
    }

    storeFailedAt[gatewayId] = nil

    let prefix = PushRelay.handlePrefix(capability.handle)
    let environment = context.environment.rawValue

    PushLog.logger.info(
      "push: registered \(gatewayId, privacy: .public) as \(prefix, privacy: .public)… (\(environment, privacy: .public))"
    )

    return .success(registration)
  }

  private struct Refreshed {
    var registration: PushRegistration
    /// The relay had lost the capability and a new one was registered.
    var replaced: Bool
  }

  private func refresh(
    _ registration: PushRegistration,
    token: APNsDeviceToken,
    context: PushContext,
    now: Double,
    reason: PushStep.RefreshReason
  ) async -> Result<Refreshed, PushPassFailure> {
    let id = registration.gatewayId

    guard let manageSecret = try? await store.secrets(gatewayId: id).manageSecret else {
      return .failure(.storage)
    }

    do {
      try await client.update(
        handle: registration.handle,
        manageSecret: manageSecret,
        token: token,
        environment: context.environment
      )
    } catch where error.capabilityLost {
      // The relay dropped it (expired, swept, or evicted as the ninth registration of a token):
      // a new capability, and the gateway's row has to be written again.
      PushLog.logger.info("push: \(id, privacy: .public) unknown to the relay, registering again")

      guard await forget(id) else {
        return .failure(.storage)
      }

      return await register(id, token: token, context: context, now: now)
        .map { Refreshed(registration: $0, replaced: true) }
    } catch {
      PushLog.logger.notice("push: refresh failed for \(id, privacy: .public): \(error.description, privacy: .public)")
      return .failure(.relay(error))
    }

    var updated = registration
    updated.tokenFingerprint = token.fingerprint
    updated.environment = context.environment
    updated.refreshedAt = now

    do {
      try await store.save(updated, secrets: nil)
    } catch {
      return .failure(.storage)
    }

    PushLog.logger.info("push: refreshed \(id, privacy: .public) (\(reason.rawValue, privacy: .public))")

    return .success(Refreshed(registration: updated, replaced: false))
  }
}

extension PushStep {
  /// Whether carrying it out calls the relay.
  var needsRelay: Bool {
    if case .forget = self { false } else { true }
  }
}

extension PushPassFailure {
  /// The rate limit this failure is, if it is one.
  var rateLimit: PushRelayError? {
    if case .relay(let error) = self, case .rateLimited = error { error } else { nil }
  }
}

/// The push log. Lines name gateway ids, handle prefixes, environments and error kinds; never a
/// token, a full handle or a secret.
enum PushLog {
  static let logger = Logger(subsystem: "dev.hermie.app", category: "push")
}
