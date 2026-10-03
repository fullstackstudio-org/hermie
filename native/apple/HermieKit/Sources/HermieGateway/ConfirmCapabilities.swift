import Foundation
import HermieProtocol
import Synchronization

// The two-step `client.capabilities` of `contract/confirm-passkey/README.md` §8.
//
// 1. `{server_requests: true}`. A gateway that knows the passkey level answers `confirm_passkey`.
// 2. Depending on that answer and on what this client can do: `confirm` with the levels, and
//    `confirm_passkey {v: 1, kind, rp_id}` beside `passkey`, or no second call at all.
//
// The decision is a pure function (`ConfirmAdvertisement.secondCall`); what it decides from lives
// in a `ConfirmCapabilitySource` the app keeps up to date (the passkey model), and the connection
// runs both calls after every `gateway.ready` and on `advertiseCapabilities()`.

/// What this client can perform for `confirm`, as the app knows it right now.
public struct ConfirmCapabilityPolicy: Sendable, Equatable {
  /// The client shows a `plain` confirmation (a tap). Off until the app has a sheet for it.
  public var plain: Bool
  /// The client can run a passkey ceremony; `nil` for a build without an RP.
  public var passkey: PasskeyAdvertisingPolicy?

  public init(plain: Bool = false, passkey: PasskeyAdvertisingPolicy? = nil) {
    self.plain = plain
    self.passkey = passkey
  }
}

/// The passkey half of the policy (plan P9 and contract §10).
public struct PasskeyAdvertisingPolicy: Sendable, Equatable {
  public var kind: PasskeyRPKind
  /// The RP this build asserts under (the native apps' associated domain).
  public var rpID: String
  /// This client knows a credential of the signed-in user for `rpID` on this gateway. Without one
  /// the gateway could not send it anything it can answer, so `passkey` is not advertised.
  public var hasCredential: Bool
  /// The `gateway_id` pinned for this stored gateway on its first successful enrolment.
  public var pinnedGatewayID: String?
  /// Ids pinned for OTHER stored gateways: a gateway presenting one of them is impersonating it.
  public var foreignGatewayIDs: Set<String>

  public init(
    kind: PasskeyRPKind = .native,
    rpID: String,
    hasCredential: Bool,
    pinnedGatewayID: String? = nil,
    foreignGatewayIDs: Set<String> = []
  ) {
    self.kind = kind
    self.rpID = rpID
    self.hasCredential = hasCredential
    self.pinnedGatewayID = pinnedGatewayID
    self.foreignGatewayIDs = foreignGatewayIDs
  }
}

/// Why the passkey level was, or was not, advertised on a connection.
public enum PasskeyAdvertisingVerdict: Sendable, Equatable {
  case advertised
  /// The gateway does not know the level (no `confirm_passkey`), or speaks another version of it.
  case notOffered
  /// The gateway knows the level and says it is off for this connection (`reason` as it came).
  case unavailable(reason: String)
  /// This build has no RP, or the gateway does not accept it for its kind.
  case rpNotAccepted
  /// No credential of the signed-in user for this build's RP is known here.
  case notEnrolled
  /// The gateway presents another `gateway_id` than the one pinned for it.
  case gatewayIDMismatch(presented: String)
  /// The gateway presents a `gateway_id` pinned for another stored gateway.
  case gatewayIDConflict(presented: String)
}

/// The decision of the second `client.capabilities` call.
public enum ConfirmAdvertisement {
  /// The passkey verdict for a first result under `policy`.
  public static func verdict(
    _ capability: ConfirmPasskeyCapability?,
    policy: PasskeyAdvertisingPolicy?
  ) -> PasskeyAdvertisingVerdict {
    guard let capability, capability.v == 1 else {
      return .notOffered
    }

    guard capability.enabled == true else {
      return .unavailable(reason: capability.reason ?? "")
    }

    guard let policy, capability.rp?.ids(for: policy.kind).contains(policy.rpID) == true else {
      return .rpNotAccepted
    }

    let presented = capability.gatewayID ?? ""

    if let pinned = policy.pinnedGatewayID, pinned != presented {
      return .gatewayIDMismatch(presented: presented)
    }

    if policy.foreignGatewayIDs.contains(presented) {
      return .gatewayIDConflict(presented: presented)
    }

    return policy.hasCredential ? .advertised : .notEnrolled
  }

  /// The params of the second call, or `nil` for none:
  ///
  /// - passkey advertised → `confirm` lists `passkey` (and `plain` when the client shows it) with
  ///   `confirm_passkey {v: 1, kind, rp_id}`;
  /// - otherwise, when the gateway sends `confirm` at all and the client shows `plain` →
  ///   `confirm: ["plain"]` and nothing about passkeys;
  /// - otherwise none.
  public static func secondCall(
    after first: ClientCapabilitiesResult,
    policy: ConfirmCapabilityPolicy
  ) -> ClientCapabilitiesParams? {
    var params = ClientCapabilitiesParams(serverRequests: true)

    if verdict(first.confirmPasskey, policy: policy.passkey) == .advertised, let passkey = policy.passkey {
      params.confirm = policy.plain ? [.plain, .passkey] : [.passkey]
      params.confirmPasskey = ConfirmPasskeyAdvertisement(kind: passkey.kind, rpID: passkey.rpID)
      return params
    }

    guard policy.plain, first.serverRequests?.contains(ServerRequestBody.Method.confirm) == true else {
      return nil
    }

    params.confirm = [.plain]
    return params
  }
}

/// One run of the two calls, as the connection saw it.
public struct ConfirmCapabilityReport: Sendable, Equatable {
  /// The first result; `nil` when the gateway refused the call (an older backend).
  public var first: ClientCapabilitiesResult?
  public var verdict: PasskeyAdvertisingVerdict
  /// The levels the second result accepted; empty without a second call or when it failed.
  public var accepted: [ConfirmLevel]

  public init(first: ClientCapabilitiesResult?, verdict: PasskeyAdvertisingVerdict, accepted: [ConfirmLevel]) {
    self.first = first
    self.verdict = verdict
    self.accepted = accepted
  }

  /// `passkey` was accepted on this connection.
  public var passkeyAccepted: Bool { accepted.contains(.passkey) }
}

/// What the connection decides the second call from, kept current by the app, and what each run
/// came back with. Hand one to `GatewayConnection.Options.confirm`; without one the connection
/// makes the single call it always made.
public final class ConfirmCapabilitySource: Sendable {
  private let state: Mutex<ConfirmCapabilityPolicy>
  private let hub = Broadcast<ConfirmCapabilityReport>(latest: nil, replaysLatest: true)

  public init(policy: ConfirmCapabilityPolicy = ConfirmCapabilityPolicy()) {
    state = Mutex(policy)
  }

  deinit {
    hub.finish()
  }

  /// The policy the next run decides from.
  public var policy: ConfirmCapabilityPolicy {
    state.withLock { $0 }
  }

  public func setPolicy(_ policy: ConfirmCapabilityPolicy) {
    state.withLock { $0 = policy }
  }

  /// The last run's report, `nil` before the first.
  public var latest: ConfirmCapabilityReport? { hub.latest }

  /// Every run's report from now on, starting with the latest one.
  public var reports: AsyncStream<ConfirmCapabilityReport> { hub.subscribe() }

  func record(_ report: ConfirmCapabilityReport) {
    hub.publish(report)
  }
}
