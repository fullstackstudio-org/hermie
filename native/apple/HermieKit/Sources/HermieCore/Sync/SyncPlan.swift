import Foundation

/// A change to this device's own data that a plan asks for.
public enum SyncLocalOp: Sendable, Equatable {
  /// A gateway found in iCloud Keychain: a new registry entry (with the id the plan took from the
  /// snapshot's `newIds`), its per-gateway config and its shareable credentials.
  case add(LocalGateway)
  /// Write the listed fields of this gateway; the value is the whole gateway as it should be.
  /// A secret field whose new value is `nil` means: delete that device-only credential.
  case update(LocalGateway, fields: Set<SyncField>)
  /// The gateway was removed on all devices: the ADR-0024 purge, including its device-only
  /// credentials, after `GatewayLifecycle.willPurge`.
  case purge(gatewayId: String)

  public var gatewayId: String {
    switch self {
    case let .add(gateway): gateway.id
    case let .update(gateway, _): gateway.id
    case let .purge(gatewayId): gatewayId
    }
  }
}

/// Something the person may want to hear about. Carries ids and names, never a credential.
public enum SyncEvent: Sendable, Equatable {
  case adopted(gatewayId: String)
  case removedElsewhere(gatewayId: String, name: String)
  /// The gateway is here but has no credential this device can use: "Sign in to continue".
  case needsSignIn(gatewayId: String)
}

/**
 What one reconcile decided: the local changes, the items to write and delete, the sync state to
 store afterwards, and the events to announce.

 Apply it in this order, each step safe to repeat: `localOps` (registry and config in one
 transaction, then the credentials), `remotePuts` and `remoteDeletes`, then `state`. A plan that
 `isEmpty` needs nothing done.
 */
public struct SyncPlan: Sendable, Equatable {
  public var localOps: [SyncLocalOp]
  /// Records to write, each under `record.account` with `record.encoded()` as the value.
  public var remotePuts: [SyncedGatewayRecord]
  /// Accounts to delete.
  public var remoteDeletes: [String]
  public var state: SyncState
  public var events: [SyncEvent]
  /// Whether `state` differs from the state the plan was computed from.
  public var stateChanged: Bool

  public init(
    localOps: [SyncLocalOp] = [],
    remotePuts: [SyncedGatewayRecord] = [],
    remoteDeletes: [String] = [],
    state: SyncState,
    events: [SyncEvent] = [],
    stateChanged: Bool = false
  ) {
    self.localOps = localOps
    self.remotePuts = remotePuts
    self.remoteDeletes = remoteDeletes
    self.state = state
    self.events = events
    self.stateChanged = stateChanged
  }

  /// Nothing to write anywhere and nothing to announce.
  public var isEmpty: Bool {
    localOps.isEmpty && remotePuts.isEmpty && remoteDeletes.isEmpty && events.isEmpty && !stateChanged
  }

  /// Something to write to or delete from the store.
  public var hasRemoteWrites: Bool {
    !remotePuts.isEmpty || !remoteDeletes.isEmpty
  }
}

extension SyncLocalOp: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    switch self {
    case let .add(gateway): "add(\(gateway.id))"
    case let .update(gateway, fields): "update(\(gateway.id), \(fields.sorted().map(\.rawValue)))"
    case let .purge(gatewayId): "purge(\(gatewayId))"
    }
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(self, children: ["op": description], displayStyle: .enum)
  }
}

extension SyncEvent: CustomStringConvertible {
  public var description: String {
    switch self {
    case let .adopted(gatewayId): "adopted(\(gatewayId))"
    case let .removedElsewhere(gatewayId, _): "removedElsewhere(\(gatewayId))"
    case let .needsSignIn(gatewayId): "needsSignIn(\(gatewayId))"
    }
  }
}

extension SyncPlan: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "SyncPlan(local: \(localOps), puts: \(remotePuts.map(\.account)), deletes: \(remoteDeletes), "
      + "events: \(events), stateChanged: \(stateChanged))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "localOps": localOps.map(\.description), "remotePuts": remotePuts.map(\.description),
        "remoteDeletes": remoteDeletes, "state": state.description, "events": events.map(\.description),
        "stateChanged": stateChanged
      ],
      displayStyle: .struct
    )
  }
}
