import Foundation

/// What the planner knows about one stored registration.
public struct PushPlanRecord: Sendable, Equatable {
  public var registration: PushRegistration
  /// The manage secret is in the keychain: the registration can be refreshed and revoked.
  public var hasManageSecret: Bool
  /// The send secret is in the keychain: the gateway's push row can be written.
  public var hasSendSecret: Bool

  public init(registration: PushRegistration, hasManageSecret: Bool = true, hasSendSecret: Bool = true) {
    self.registration = registration
    self.hasManageSecret = hasManageSecret
    self.hasSendSecret = hasSendSecret
  }
}

/// Everything a planning pass decides from. No clock is read and no store is touched inside.
public struct PushPlanInput: Sendable, Equatable {
  /// Unix seconds.
  public var now: Double
  /// The APNs token this launch was given, or nil until `didRegister…` has answered.
  public var token: APNsDeviceToken?
  public var environment: APNsEnvironment
  /// The bundle id, which is the APNs topic.
  public var topic: String
  /// The relay origin this build talks to.
  public var relay: String
  /// The reader switched notifications on AND the system lets this app show them.
  public var wanted: Bool
  /// The gateways that should have a registration, most important first (the live one, then the
  /// registry's order). Only the first `PushPlan.maxRegistrations` are registered.
  public var gatewayIds: [String]
  public var stored: [PushPlanRecord]
  /// Gateways not to register in this pass, because storing their last registration failed.
  public var backedOff: Set<String>

  public init(
    now: Double,
    token: APNsDeviceToken?,
    environment: APNsEnvironment,
    topic: String,
    relay: String,
    wanted: Bool,
    gatewayIds: [String],
    stored: [PushPlanRecord],
    backedOff: Set<String> = []
  ) {
    self.now = now
    self.token = token
    self.environment = environment
    self.topic = topic
    self.relay = relay
    self.wanted = wanted
    self.gatewayIds = gatewayIds
    self.stored = stored
    self.backedOff = backedOff
  }
}

/// One thing a pass does.
public enum PushStep: Sendable, Equatable {
  /// `POST`: there is no registration for this gateway yet.
  case register(gatewayId: String)
  /// `PUT` with the current token and environment.
  case refresh(gatewayId: String, reason: RefreshReason)
  /// `DELETE`, then forget it locally.
  case delete(gatewayId: String, reason: DeleteReason)
  /// Forget it locally without asking the relay, which cannot be asked (see `ForgetReason`).
  case forget(gatewayId: String, reason: ForgetReason)

  public enum RefreshReason: String, Sendable, Equatable {
    /// APNs handed out a different token.
    case tokenChanged
    /// The build now gets tokens from the other APNs endpoint.
    case environmentChanged
    /// The daily confirmation, so the relay's idle sweep never takes a live registration.
    case daily
    /// The last refresh is stamped in the future: the clock moved back. Refreshing re-stamps it
    /// with the current time, so the daily rhythm resumes from here.
    case clockSkew
  }

  public enum DeleteReason: String, Sendable, Equatable {
    /// The reader turned notifications off, or the system no longer lets the app show them.
    case notWanted
    /// The gateway was removed or signed out of.
    case gatewayGone
    /// The build's bundle id changed, so the registration names a topic this app no longer is.
    case topicChanged
    /// The send secret is gone, so the push row cannot be written; the manage secret is still
    /// here, so the old registration is revoked before a new one is made.
    case sendSecretMissing
    /// More gateways than the relay keeps per device token: this one is past the limit.
    case overLimit
  }

  public enum ForgetReason: String, Sendable, Equatable {
    /// The keychain has no manage secret for it (a backup restored onto another device, a reset):
    /// it cannot be revoked from here, and the old one expires on the relay by itself.
    case manageSecretMissing
    /// The registration was made at another relay origin. Its manage secret is not sent to the
    /// relay this build talks to, and the old origin is not contacted.
    case relayChanged
  }

  public var gatewayId: String {
    switch self {
    case .register(let id), .refresh(let id, _), .delete(let id, _), .forget(let id, _): id
    }
  }
}

/**
 Decides, from a snapshot, what to do about each gateway's relay registration. Pure: the same input
 always gives the same steps, so the rules are a table in a test (`PushPlanTests`).

 The gateways that get a registration are the first `maxRegistrations` of `gatewayIds` when
 `wanted`, and none otherwise. Then, per gateway:

 - **Not selected** (switched off, permission gone, gateway gone, past the limit): its stored
   registration is deleted at the relay, or only forgotten when it cannot be (no manage secret,
   another relay). A token is not needed to delete.
 - **Selected, no token yet**: nothing; registering and refreshing both need the token.
 - **No record**: register, unless storing the last one failed (`backedOff`).
 - **No manage secret**: forget, then register. **No send secret**: delete, then register.
 - **Another relay origin**: forget, then register. **Another topic**: delete, then register.
 - **Different token or environment**: refresh (`PUT`).
 - **Refreshed a day or more ago**, or **stamped more than `futureTolerance` in the future**:
   refresh. Otherwise nothing, which is what keeps the `PUT` to at most once a day.

 Steps come back with every removal first (sorted by gateway id), then the registrations and
 refreshes in gateway order.
 */
public enum PushPlan {
  /// The most often a registration is confirmed without a reason.
  public static let refreshInterval: Double = 86_400
  /// How far in the future a stamp may be before the clock is taken to have moved back. Small
  /// enough to catch a clock reset, large enough not to fire on an NTP correction.
  public static let futureTolerance: Double = 300
  /// The relay keeps at most eight live registrations per device token and evicts the least
  /// recently used, so a ninth would evict another on every daily refresh.
  public static let maxRegistrations = 8

  /// The gateways that get a registration and the ones past the limit, duplicates removed.
  public static func selection(_ gatewayIds: [String]) -> (selected: [String], limited: [String]) {
    var seen = Set<String>()
    let unique = gatewayIds.filter { seen.insert($0).inserted }

    return (Array(unique.prefix(maxRegistrations)), Array(unique.dropFirst(maxRegistrations)))
  }

  public static func steps(_ input: PushPlanInput) -> [PushStep] {
    var removals: [PushStep] = []
    var work: [PushStep] = []

    let selection = selection(input.gatewayIds)
    let selected = input.wanted ? selection.selected : []
    let selectedSet = Set(selected)
    let limited = Set(selection.limited)
    let records = Dictionary(input.stored.map { ($0.registration.gatewayId, $0) }, uniquingKeysWith: { first, _ in first })

    for record in input.stored.sorted(by: { $0.registration.gatewayId < $1.registration.gatewayId })
    where !selectedSet.contains(record.registration.gatewayId) {
      let id = record.registration.gatewayId

      if record.registration.relay != input.relay {
        removals.append(.forget(gatewayId: id, reason: .relayChanged))
      } else if !record.hasManageSecret {
        removals.append(.forget(gatewayId: id, reason: .manageSecretMissing))
      } else {
        let reason: PushStep.DeleteReason =
          !input.wanted ? .notWanted : limited.contains(id) ? .overLimit : .gatewayGone
        removals.append(.delete(gatewayId: id, reason: reason))
      }
    }

    guard let token = input.token else {
      return removals
    }

    for id in selected {
      guard let record = records[id] else {
        if !input.backedOff.contains(id) {
          work.append(.register(gatewayId: id))
        }

        continue
      }

      let registration = record.registration
      var replace: PushStep?

      if registration.relay != input.relay {
        replace = .forget(gatewayId: id, reason: .relayChanged)
      } else if !record.hasManageSecret {
        replace = .forget(gatewayId: id, reason: .manageSecretMissing)
      } else if !record.hasSendSecret {
        replace = .delete(gatewayId: id, reason: .sendSecretMissing)
      } else if registration.topic != input.topic {
        replace = .delete(gatewayId: id, reason: .topicChanged)
      }

      if let replace {
        work.append(replace)

        if !input.backedOff.contains(id) {
          work.append(.register(gatewayId: id))
        }
      } else if registration.tokenFingerprint != token.fingerprint {
        work.append(.refresh(gatewayId: id, reason: .tokenChanged))
      } else if registration.environment != input.environment {
        work.append(.refresh(gatewayId: id, reason: .environmentChanged))
      } else if input.now - registration.refreshedAt >= refreshInterval {
        work.append(.refresh(gatewayId: id, reason: .daily))
      } else if registration.refreshedAt - input.now > futureTolerance {
        work.append(.refresh(gatewayId: id, reason: .clockSkew))
      }
    }

    return removals + work
  }
}
