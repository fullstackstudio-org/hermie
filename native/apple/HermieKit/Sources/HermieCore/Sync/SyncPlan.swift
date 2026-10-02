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
  /// The record would be over 8 KB with its headers, so they stay on this device only (I16).
  case headersNotSynced(gatewayId: String)
  /// Credentials that went missing here without anyone clearing them were put back from iCloud.
  case credentialRestored(gatewayId: String, fields: Set<SyncField>)
  /// The store read empty while this device had read items in it ("Delete everything from iCloud
  /// Keychain", or this device's copy was lost): these gateways stay here but are no longer synced
  /// ("Sync again" is `SyncState.resync(gatewayId:)`). Ids only.
  case storeEmptied(gatewayIds: [String])
  /// These gateways were added here before a removal on all devices made elsewhere (with sync off
  /// here, say): they stay here but are no longer synced ("Sync again" is
  /// `SyncState.resync(gatewayId:)`, which does not outrank the removal). Ids only.
  case removedElsewhereKeptHere(gatewayIds: [String])
}

/// Which rule of the merge a reconcile used, for tests and diagnostics. Carries nothing else.
enum SyncTrace: String, Sendable, Hashable {
  /// A gateway added here was published over a removal on all devices.
  case readded
  /// A gateway that already existed here met a removal on all devices and stayed, device-only.
  case existingKeptAbsent
  /// A gateway added here before a removal on all devices (with sync off, say) stayed, device-only.
  case addedBeforeRemovalKeptAbsent
  /// An `absent` gateway met a newer tombstone and was purged.
  case absentPurged
  /// A credential from before a removal on all devices was dropped.
  case earlierLifeDropped
  /// A remembered tombstone was merged back into its record.
  case tombstoneRewritten
  /// A credential missing here without an intent was put back from iCloud.
  case credentialRestored
  /// A credential missing here while signed out was left missing.
  case credentialLeftSignedOut
  /// "Sign Out on All Devices" went out while signed out here.
  case clearedWhileSignedOut
  /// Without a print, a local credential went back at its old stamp and a newer one from elsewhere won.
  case printRebuildYielded
  /// A young remembered tombstone whose item had vanished was written again.
  case tombstoneRewrittenOverMissing
  /// "Stop syncing" deleted the item again because a read still showed it.
  case stopSyncingDeleteRepeated
  /// "Stop syncing" deleted an item this device had not read back as seen (its own publish).
  case stopSyncingDeletedUnread
  /// A switched-off gateway left alone an item published again since under a fresh address stamp.
  case stopSyncingLeftRepublished
  /// A gateway switched on again or resynced published its address register under a fresh stamp.
  case republishedWithFreshStamp
  /// The store showed no items at all after holding some: "Delete everything from iCloud Keychain".
  case deletedEverything
  /// The print key changed: every print was void and gateways were attached as on first sight.
  case printsReset
  /// A record went out without its headers (I16).
  case headersOverLimit
  /// A foreign record (newer build, unreadable, invalid) was in the store.
  case foreignRecord
  /// A record whose address hashes to a key but names another origin (a hash collision) was left alone.
  case originCollision
  /// A gateway the sync had purged before its state was saved was not hidden.
  case crashedPurgeRecovered
  /// A local write a plan saved as pending had not landed, and was made again.
  case pendingWriteRedone
  /// Credentials bound to an origin the gateway no longer has were deleted here.
  case credentialsLeftBehind
}

/**
 What one reconcile decided: the local changes, the items to write and delete, the sync state to
 store afterwards, and the events to announce.

 Apply it in this order, each step safe to repeat after a crash:

 1. One SQLite transaction: the registry and config changes of `localOps`, and `provisionalState`,
    under a check that the stored state is still the one the plan was made from (an intent the
    person recorded meanwhile would otherwise be lost). When it is not, nothing of the plan is
    applied; reconcile again.
 2. The credentials of `localOps` in the device-only keychain (and the purge of a purged gateway's).
 3. `remotePuts` and `remoteDeletes`.
 4. `state`, under the same check: when the stored state has moved since step 1 (an intent arrived
    while steps 2 and 3 ran), step 4 is skipped. The stored state then keeps the pending marks of
    `provisionalState` plus the new intent, and the next reconcile settles the marks against the
    values steps 2 and 3 left.

 Each gateway has at most one op in `localOps`: an `.update` carries every field the plan writes to
 that gateway (credentials a move left behind and values from the record, resolved field by field),
 and a `.purge` is never accompanied by an update.

 `provisionalState` is what makes a crash between the steps harmless. It is `state` with every
 field this plan writes locally marked pending (`SyncEntry.pendingPrint(from:to:)`: the print of
 the value before and after). After a crash, the next reconcile compares the local value with
 both: the write landed, or it did not and the record's value is written again, or the person
 changed it since. So a credential this device received never passes for one entered here, and an
 adopted gateway is never in the registry without its entry. A plan that `isEmpty` needs nothing
 done.

 Tombstone rewrites are counted in `state` only, not in `provisionalState`: a plan that dies
 before step 3 does not use up one of the three tries. The merge's known limits (what "Delete
 everything" cannot tell apart, a switch-on that goes out without a fresh address stamp, clock
 skew in "added after the removal") are listed on `GatewaySync`.
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
  /// What to save with the registry changes, before anything else (see above).
  public var provisionalState: SyncState
  /// The rules this reconcile used. Not part of the plan's meaning; `isEmpty` ignores it.
  var traces: Set<SyncTrace> = []

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
    self.provisionalState = state
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
    case let .headersNotSynced(gatewayId): "headersNotSynced(\(gatewayId))"
    case let .credentialRestored(gatewayId, fields): "credentialRestored(\(gatewayId), \(fields.sorted().map(\.rawValue)))"
    case let .storeEmptied(gatewayIds): "storeEmptied(\(gatewayIds))"
    case let .removedElsewhereKeptHere(gatewayIds): "removedElsewhereKeptHere(\(gatewayIds))"
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
