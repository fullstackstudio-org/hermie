import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One test (or more) per finding of the third review of the merge.
@Suite struct ThirdReviewTests {
  static let address = "https://gateway.test"
  static let alpha = "https://alpha.gateway.test"
  static let key = GatewayKey.of(address)
  static let account = SyncedGatewayRecord.account(forKey: key)

  static func shared(devices: Int = 2, conflict: TestCloud.ConflictPolicy = .newestWrite) -> (SyncWorld, [String]) {
    var world = SyncWorld(devices: devices, conflict: conflict)
    world.add(0, address: address, name: "Home", token: "tok-1")
    world.settle()
    return (world, world.devices.map { $0.gateways.first!.id })
  }

  // MARK: C1. "Stop syncing" deletes an item this device never read back

  /// A: published here, never read back, switched off: the item goes, and the other device keeps
  /// its copy device-only instead of syncing the token on.
  @Test func stopSyncingDeletesAnItemThisDeviceNeverReadBack() {
    var world = SyncWorld(devices: 2)
    let id = world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.reconcile(0)
    world.cloud.deliverAll()
    world.reconcile(1)
    #expect(world.devices[0].state.entries[id]?.seen == false)

    world.setGatewaySynced(0, id, false)
    let plan = world.reconcile(0)

    #expect(plan.remoteDeletes == [Self.account])
    #expect(plan.traces.contains(.stopSyncingDeletedUnread))
    world.settle()
    #expect(world.cloud.cloudItems.isEmpty)
    #expect(world.devices[1].state.entries[world.devices[1].gateways[0].id]?.detached == .absent)
  }

  /// B: off, deleted, on (published again, not read back), off again: deleted again.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func stopSyncingAfterSwitchingBackOnDeletesAgain(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(conflict: conflict)

    world.setGatewaySynced(0, ids[0], false)
    world.reconcile(0)
    world.cloud.deliverAll()
    world.setGatewaySynced(0, ids[0], true)
    #expect(world.reconcile(0).remotePuts.map(\.key) == [Self.key])
    world.setGatewaySynced(0, ids[0], false)
    let again = world.reconcile(0)

    #expect(again.remoteDeletes == [Self.account])
    world.settle()
    #expect(world.cloud.cloudItems.isEmpty)
    #expect(world.reconcile(0).isEmpty)
  }

  // MARK: I1. A republish elsewhere is not undone by an earlier "stop syncing"

  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func aResyncElsewhereIsNotUndoneByAnEarlierStopSyncing(conflict: TestCloud.ConflictPolicy) throws {
    var (world, ids) = Self.shared(conflict: conflict)

    // The phone stops syncing and deletes the item, then sleeps.
    world.setGatewaySynced(0, ids[0], false)
    world.reconcile(0)
    world.cloud.deliverAll()
    // The tablet sees it go, and the person publishes it again from there.
    world.reconcile(1)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
    world.advance(1_000)
    world.resync(1, ids[1])
    let republish = world.reconcile(1)
    let address = try #require(republish.remotePuts.first?.registers[.address])
    #expect(address.stamp.d == world.devices[1].state.device)
    #expect(address.stamp != world.devices[0].state.entries[ids[0]]?.stamp(.address))
    world.cloud.deliverAll()

    // The phone wakes: the item is not the one it deleted.
    let wake = world.reconcile(0)
    #expect(wake.remoteDeletes.isEmpty)
    #expect(wake.traces.contains(.stopSyncingLeftRepublished))
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == nil)
  }

  /// The fresh stamp of a switch-on is one above the newest address register known, not `now`, so
  /// it never outranks a removal on all devices it has not seen (found by the property test, seed
  /// 292): switched on later than the removal, the gateway still goes.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func switchingOnDoesNotOutrankARemovalNotSeenYet(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(conflict: conflict)

    // Device 1 switched off, and the keychain lost its delete: the item stays live.
    world.setGatewaySynced(1, ids[1], false)
    var lost = world.plan(1)
    lost.remoteDeletes = []
    world.apply(lost, to: 1)

    world.advance(1_000)
    world.remove(0, ids[0], scope: .allDevices)
    world.reconcile(0)
    world.cloud.deliverAll(except: 1)

    // Later, device 1 switches it on, before the removal reaches it.
    world.advance(60_000)
    world.setGatewaySynced(1, ids[1], true)
    let plan = world.reconcile(1)
    #expect(plan.traces.contains(.republishedWithFreshStamp))
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[1].gateways.isEmpty)
  }

  /// Found by the wide property run (seed 110692): a removal stamped just above the address by a
  /// slow clock, and the person resyncing the gateway twice before it arrives. The address
  /// register is this device's own already, so it is not stamped again; nothing climbs past the
  /// removal a millisecond at a time.
  @Test func repeatedResyncsDoNotClimbPastARemovalFromASlowClock() {
    var world = SyncWorld(devices: 2)
    world.devices[1].clockOffset = -year
    let id = world.add(0, address: Self.address, name: "Home", token: "tok-1")
    world.settle()
    let theirs = world.devices[1].gateways[0].id

    world.remove(1, theirs, scope: .allDevices)
    let removal = world.reconcile(1)
    let deleted = removal.remotePuts.first?.deleted
    #expect(deleted?.t == startOfTime + 1)

    for _ in 0..<2 {
      world.advance(1_000)
      world.resync(0, id)
      #expect(!world.reconcile(0).traces.contains(.republishedWithFreshStamp))
    }
    world.cloud.deliverAll()
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
    #expect(world.devices[0].gateways.isEmpty)
  }

  /// A switched-on gateway removed on all devices while it was off is purged, not brought back.
  @Test func switchingOnAfterARemovalEverywherePurges() {
    var (world, ids) = Self.shared()
    world.setGatewaySynced(1, ids[1], false)
    world.settle()
    world.advance(1_000)
    world.add(0, address: Self.address, name: "Again", token: "tok-2")
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()
    world.remove(0, world.devices[0].gateways[0].id, scope: .allDevices)
    world.settle()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)

    world.setGatewaySynced(1, ids[1], true)
    let plan = world.reconcile(1)

    #expect(plan.localOps == [.purge(gatewayId: ids[1])])
    #expect(!plan.remotePuts.contains { $0.isLive })
  }

  // MARK: I2. Intents do not outlive "Sync with iCloud Keychain" switched off

  /// The headers were cleared just before sync was switched off here; a month later, with newer
  /// headers set elsewhere, sync comes back: the old clear does not go out.
  @Test(arguments: [true, false])
  func aClearMadeAroundSwitchingSyncOffNeverGoesOut(clearFirst: Bool) {
    var (world, ids) = Self.shared()
    world.setHeaders(0, ids[0], ["X-Team": "blue"])
    world.settle()

    if clearFirst {
      world.setHeaders(1, ids[1], nil)
      world.setEnabled(1, false)
    } else {
      world.setEnabled(1, false)
      world.setHeaders(1, ids[1], nil)
    }
    #expect(world.devices[1].state.entries[ids[1]]?.clearing.isEmpty == true)

    world.advance(1_000)
    world.setHeaders(0, ids[0], ["X-Team": "green"])
    world.settle()
    world.advance(30 * day)
    world.setEnabled(1, true)
    world.settle()

    #expect(world.devices[0].gateways[0].headers?.headers == ["X-Team": "green"])
    #expect(world.devices[1].gateways[0].headers?.headers == ["X-Team": "green"])
  }

  /// A state saved with a clear intent and sync off (written by an earlier build, or switched off
  /// outside the property): a reconcile while off drops it.
  @Test func aReconcileWhileSyncIsOffDropsLeftoverIntents() {
    var (world, ids) = Self.shared()
    var state = world.devices[1].state
    state.markClearing(.sessionToken, gatewayId: ids[1], key: Self.key)
    state.markRemoved(gatewayId: ids[1], key: Self.key, scope: .allDevices, at: world.now)
    let encoded = (try? state.encoded())!.replacingOccurrences(of: #""enabled":true"#, with: #""enabled":false"#)
    world.devices[1].state = SyncState.decode(encoded)!
    #expect(world.devices[1].state.entries[ids[1]]?.clearing == [.sessionToken])

    let plan = world.reconcile(1)

    #expect(plan.stateChanged)
    #expect(plan.state.entries[ids[1]]?.clearing.isEmpty == true)
    #expect(plan.state.entries[ids[1]]?.removal == .thisDevice)
  }

  /// "Remove from all devices" with sync off here is a removal from this device only.
  @Test(arguments: [true, false])
  func aRemovalAroundSwitchingSyncOffStaysOnThisDevice(removeFirst: Bool) {
    var (world, ids) = Self.shared()

    if removeFirst {
      world.remove(1, ids[1], scope: .allDevices)
      world.setEnabled(1, false)
    } else {
      world.setEnabled(1, false)
      world.remove(1, ids[1], scope: .allDevices)
    }
    world.advance(30 * day)
    world.setEnabled(1, true)
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
    #expect(world.devices[0].gateways.map(\.id) == [ids[0]])
    #expect(world.devices[1].gateways.isEmpty)
    #expect(world.devices[1].state.hidden.contains(Self.key))
  }

  // MARK: I3. One update per gateway

  /// A move to an origin that already has a live record: the token left behind and the record's
  /// values are one update, with the record's token in it.
  @Test func aMoveOntoALiveRecordIsOneUpdate() throws {
    var world = SyncWorld(devices: 2)
    let mine = world.add(1, address: Self.address, name: "Mine", token: "tok-mine")
    world.settle()
    world.add(0, address: Self.alpha, name: "Alpha", token: "tok-alpha")
    world.reconcile(0)
    world.cloud.deliverAll()

    // Device 1 moves its gateway onto alpha before it has adopted alpha's record.
    world.advance(1_000)
    world.setAddress(1, mine, to: Self.alpha)
    let plan = world.reconcile(1)

    let updates = plan.localOps.filter { $0.gatewayId == mine }
    #expect(updates.count == 1)
    guard case let .update(gateway, fields) = try #require(updates.first) else {
      Issue.record("not an update: \(updates)")
      return
    }
    #expect(fields.contains(.sessionToken))
    #expect(gateway.sessionToken?.token == "tok-alpha")
    #expect(Set(plan.localOps.map(\.gatewayId)).count == plan.localOps.count)
    world.settle()
    #expect(world.reconcile(1).isEmpty)
  }

  /// A device-only gateway (its move writes no tombstone) moves away in a plan that died before the
  /// keychain, then back, and the live record still holds the very token that was left behind. It
  /// comes back as the record's (in the same single update as the drop), stops counting as left
  /// behind, and the next reconcile has nothing to do.
  @Test func aLeftBehindTokenTheRecordStillHoldsSettles() {
    var (world, ids) = Self.shared()
    world.cloud.wipeLocal(1)
    world.reconcile(1)
    #expect(world.devices[1].state.entries[ids[1]]?.detached == .absent)
    world.advance(1_000)
    world.setAddress(1, ids[1], to: Self.alpha)
    world.applyCrash(world.plan(1), to: 1, at: .afterRegistry)
    #expect(world.devices[1].state.entries[ids[1]]?.leftBehind.isEmpty == false)
    world.cloud.rejoin(1)
    world.cloud.deliverAll()

    world.advance(1_000)
    world.setAddress(1, ids[1], to: Self.address)
    let back = world.reconcile(1)

    #expect(back.localOps.filter { $0.gatewayId == ids[1] }.count <= 1)
    #expect(world.devices[1].gateways[0].sessionToken?.token == "tok-1")
    #expect(world.devices[1].state.entries[ids[1]]?.leftBehind.isEmpty == true)
    #expect(world.reconcile(1).localOps.isEmpty)
  }

  // MARK: O1. A pending write of a value is not an earlier life

  /// The engine died while writing token B over A (the provisional state holds the mark); the
  /// next read is a stale copy of a re-added record without a token register. Token A stays.
  @Test func aPendingTokenChangeIsNotTakenForAnEarlierLife() {
    let origin = GatewayAddress.origin(of: Self.address)
    let local = LocalGateway(
      id: "g01", name: "Home", address: Self.address, authKind: "session_token", addedAt: startOfTime,
      sessionToken: SyncSessionToken(origin: origin, token: "tok-a"))
    let tokenB = SyncSessionToken(origin: origin, token: "tok-b")
    let live = SyncStamp(t: startOfTime + 2_000, d: "a1b2c300")

    var record = SyncedGatewayRecord(key: Self.key)
    record.deleted = SyncStamp(t: startOfTime + 1_000, d: "a1b2c300")
    record.addedAt = startOfTime
    for (field, value) in [(SyncField.address, JSONValue.string(Self.address)), (.name, "Home"), (.authKind, "session_token")] {
      record.registers[field] = SyncRegister(value: value, stamp: live)
    }

    var entry = SyncEntry(key: Self.key, seen: true)
    for field in [SyncField.address, .name, .authKind] {
      entry.stamps[field.rawValue] = live
      entry.prints[field.rawValue] = testPrinter.print(record.registers[field]!.value)
    }
    entry.prints[SyncField.user.rawValue] = testPrinter.print(.null)
    entry.prints[SyncField.provider.rawValue] = testPrinter.print(.null)
    entry.prints[SyncField.frontDoor.rawValue] = testPrinter.print(.null)
    entry.prints[SyncField.headers.rawValue] = testPrinter.print(.null)
    entry.stamps[SyncField.sessionToken.rawValue] = SyncStamp(t: startOfTime + 3_000, d: "a1b2c301")
    entry.prints[SyncField.sessionToken.rawValue] = SyncEntry.pendingPrint(
      from: testPrinter.print(local.sessionToken!.json), to: testPrinter.print(tokenB.json))
    var state = SyncState(device: "a1b2c302", enabled: true, disclosed: true, entries: ["g01": entry])
    state.printCheck = testPrinter.check

    let plan = GatewaySync.reconcile(
      local: LocalSyncSnapshot(gateways: [local], newIds: [], printer: testPrinter), remote: [record], state: state,
      now: startOfTime + 10_000)

    #expect(!plan.traces.contains(.earlierLifeDropped))
    #expect(!plan.localOps.contains { op in
      if case let .update(gateway, fields) = op { return fields.contains(.sessionToken) && gateway.sessionToken == nil }
      return false
    })
    #expect(SyncEntry.pending(plan.state.entries["g01"]?.prints[SyncField.sessionToken.rawValue]) != nil)
  }

  // MARK: O2. "Delete everything from iCloud Keychain"

  /// The engine review's scenario: device 1 holds a gateway it published but has not read back;
  /// device 0 deletes everything. Nothing of device 1's goes out again; every gateway there stays,
  /// device-only, until the person resyncs one.
  @Test(arguments: TestCloud.ConflictPolicy.allCases)
  func afterDeletingEverythingNothingIsPublishedAgain(conflict: TestCloud.ConflictPolicy) {
    var (world, ids) = Self.shared(conflict: conflict)
    let unread = world.add(1, address: Self.alpha, name: "Unread", token: "tok-u")
    world.reconcile(1)
    world.cloud.deliverAll()
    #expect(world.devices[1].state.entries[unread]?.seen == false)

    world.deleteEverything(0)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)

    #expect(plan.traces.contains(.deletedEverything))
    #expect(!plan.hasRemoteWrites)
    #expect(plan.localOps.isEmpty)
    #expect(plan.state.entries[ids[1]]?.detached == .absent)
    #expect(plan.state.entries[unread]?.detached == .absent)
    world.settle()
    #expect(world.cloud.cloudItems.isEmpty)
    #expect(world.devices.map(\.gateways.count) == [1, 2])

    // `resync` is the way back.
    world.resync(1, unread)
    world.settle()
    #expect(world.cloudRecord(key: GatewayKey.of(Self.alpha))?.isLive == true)
    #expect(world.devices[0].gateways.count == 2)
  }

  /// Remembered tombstones are not written back after everything was deleted, and stay retired once
  /// the store fills again.
  @Test func afterDeletingEverythingNoTombstoneIsWrittenBack() {
    var (world, ids) = Self.shared()
    let gone = world.add(0, address: Self.alpha, name: "Gone")
    world.settle()
    world.remove(0, gone, scope: .allDevices)
    world.settle()
    #expect(world.devices[1].state.tombstones[GatewayKey.of(Self.alpha)] != nil)

    world.deleteEverything(0)
    world.cloud.deliverAll()
    let plan = world.reconcile(1)

    #expect(!plan.hasRemoteWrites)
    #expect(plan.state.tombstones[GatewayKey.of(Self.alpha)]?.rewrites == 3)
    world.settle()
    #expect(world.cloud.cloudItems.isEmpty)

    world.resync(1, ids[1])
    world.settle()
    #expect(world.cloudRecord(key: GatewayKey.of(Self.alpha)) == nil)
    #expect(world.cloudRecord(key: Self.key)?.isLive == true)
  }

  /// Found by the wide property run (seed 110570): three tombstone rewrites whose plans died before
  /// iCloud do not use up the three tries; the removal still goes out.
  @Test func aTombstoneRewriteCutShortByACrashIsNotSpent() {
    var (world, ids) = Self.shared()
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()
    world.cloud.delete(1, account: Self.account)
    world.cloud.deliverAll()

    for _ in 0..<3 {
      let plan = world.plan(0)
      #expect(plan.traces.contains(.tombstoneRewrittenOverMissing))
      world.applyCrash(plan, to: 0, at: .afterKeychain)
    }
    #expect(world.devices[0].state.tombstones[Self.key]?.rewrites == 0)

    #expect(world.reconcile(0).traces.contains(.tombstoneRewrittenOverMissing))
    world.cloud.deliverAll()
    #expect(world.cloudRecord(key: Self.key)?.isTombstone == true)
  }

  /// Why a remembered tombstone alone is not evidence of a deleted store (found by the property
  /// test, seed 10): a "stop syncing" delete swallowed a removal that was the only item. A gateway
  /// the remover adds right then is published, and the removal is written back.
  @Test func aGatewayAddedAfterARaceOnAnEmptiedStoreIsPublished() {
    var (world, ids) = Self.shared(devices: 3)
    world.remove(1, ids[1], scope: .allDevices)
    world.reconcile(1)
    world.setGatewaySynced(0, ids[0], false)
    world.reconcile(0)
    world.cloud.deliverAll()
    #expect(world.cloud.cloudItems.isEmpty)

    let added = world.add(1, address: Self.alpha, name: "New")
    let plan = world.reconcile(1)

    #expect(!plan.traces.contains(.deletedEverything))
    #expect(plan.state.entries[added]?.detached == nil)
    #expect(Set(plan.remotePuts.map(\.key)) == [Self.key, GatewayKey.of(Self.alpha)])
    world.settle()
    #expect(world.devices[2].gateways.map(\.address) == [Self.alpha])
  }

  /// O2, second case, not changed: a device that missed a re-add writes a stale tombstone back after
  /// a "stop syncing" delete; the re-adder takes it for stale and publishes again; the device that
  /// stopped syncing deletes that again (it is the item it knew), and the re-adder then keeps its
  /// copy device-only. Stop syncing holds.
  @Test func aStaleTombstoneWrittenBackDoesNotUndoStopSyncing() {
    var (world, ids) = Self.shared(devices: 3)
    world.remove(0, ids[0], scope: .allDevices)
    world.settle()
    #expect(world.devices.allSatisfy { $0.gateways.isEmpty })

    // Device 1 adds it again while device 2 is away; device 0 adopts it and stops syncing it.
    world.advance(1_000)
    let again = world.add(1, address: Self.address, name: "Again", token: "tok-2")
    world.reconcile(1)
    world.cloud.deliverAll(except: 2)
    world.reconcile(0)
    let adopted = world.devices[0].gateways[0].id
    world.reconcile(1)
    world.setGatewaySynced(0, adopted, false)
    world.reconcile(0)
    world.cloud.deliverAll()

    // Device 2 sees nothing at the key and writes its remembered removal back.
    #expect(world.reconcile(2).traces.contains(.tombstoneRewrittenOverMissing))
    world.cloud.deliverAll()
    world.settle()

    #expect(world.cloudRecord(key: Self.key)?.isLive != true)
    #expect(world.devices[1].state.entries[again]?.detached == .absent)
    // Whoever still holds it keeps it device-only, as after any "stop syncing".
    #expect(world.devices[2].gateways.allSatisfy { world.devices[2].state.entries[$0.id]?.detached == .absent })
  }
}
