import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore

// MARK: - Seams

/// The live session layer's hook (Task 16): stop a gateway's connection and retire what is bound
/// to it before its registry entry and credentials disappear. Called before the purge commits; a
/// purge that is then abandoned (the plan went stale) leaves the gateway in place, so an
/// implementation must cope with a gateway that stays after `willPurge`.
public protocol GatewayLifecycle: Sendable {
  func willPurge(gatewayId: String) async
}

/// Until the session layer exists.
public struct NoGatewayLifecycle: GatewayLifecycle {
  public init() {}
  public func willPurge(gatewayId: String) async {}
}

/// The device-only keychain as the engine needs it: `SecretStore` plus the prefix clean-up that
/// `KeychainStore` and `InMemorySecretStore` already have, used only for the reinstall clean-up.
public protocol SyncDeviceSecretStore: SecretStore {
  @discardableResult
  func removeAll(prefix: String) throws -> Int
}

extension KeychainStore: SyncDeviceSecretStore {}
extension InMemorySecretStore: SyncDeviceSecretStore {}

/// What the gateway list needs from sync: removing a gateway, and asking for a reconcile (Settings
/// → Gateways opened). The sync engine in the app, a fake in tests.
public protocol GatewayListSync: Sendable {
  func removeGateway(id: String, scope: RemovalScope) async throws
  func trigger(_ reason: SyncReason) async
}

extension GatewaySyncEngine: GatewayListSync {}

/// A gateway the add wizard completed, with what it stores.
public struct NewGateway: Sendable {
  public var id: String
  public var name: String
  public var address: String
  public var authKind: GatewayAuthKind
  public var provider: SyncProvider?
  public var user: String?
  /// Epoch milliseconds; the engine's clock when `nil`.
  public var addedAt: Double?
  public var frontDoor: FrontDoor
  /// The headers as typed under Custom headers.
  public var customHeaders: [String: String]
  public var sessionToken: String?
  /// Native PKCE only; never synced.
  public var tokens: TokenSet?

  public init(
    id: String = GatewayRegistry.newGatewayId(),
    name: String,
    address: String,
    authKind: GatewayAuthKind,
    provider: SyncProvider? = nil,
    user: String? = nil,
    addedAt: Double? = nil,
    frontDoor: FrontDoor = .none,
    customHeaders: [String: String] = [:],
    sessionToken: String? = nil,
    tokens: TokenSet? = nil
  ) {
    self.id = id
    self.name = name
    self.address = address
    self.authKind = authKind
    self.provider = provider
    self.user = user
    self.addedAt = addedAt
    self.frontDoor = frontDoor
    self.customHeaders = customHeaders
    self.sessionToken = sessionToken
    self.tokens = tokens
  }
}

extension NewGateway: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "NewGateway(\(id), key: \(GatewayKey.of(address)))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["id": id]) }
}

/// A record a new device can take ("Found in iCloud Keychain"). Which credentials it carries, never
/// what they are.
public struct AdoptableGateway: Sendable, Equatable, Identifiable {
  public var key: String
  public var name: String
  public var address: String
  public var authKind: String
  public var providerLabel: String?
  public var hasSessionToken: Bool
  public var hasFrontDoor: Bool
  public var hasHeaders: Bool
  public var addedAt: Double?

  public var id: String { key }
}

/// The steps of applying a plan, for crash injection in tests.
enum SyncApplyStep: Sendable, Equatable, CaseIterable {
  case willPurge
  case localTransaction
  case secrets
  case remote
  case state
}

/// The points inside intents where a test can stop one (a crash there).
enum SyncIntentStep: Sendable, Equatable {
  /// "Remove": the removal and the purge are committed, the device-only items not yet deleted.
  case removeCommitted
  /// "Sign out": `signedOut` is committed, the credentials not yet deleted.
  case signOutCommitted
  /// "Clear" a credential: the clear is committed, the item not yet deleted.
  case clearCommitted
  /// "Change address" to another origin: the new address is committed, the old origin's credentials
  /// not yet deleted.
  case addressCommitted
}

/// The plan was computed from state that changed before it was committed.
struct StalePlan: Error {}

// MARK: - Engine

/**
 The one bridge between this device's gateways and iCloud Keychain (ADR-0032, I5): the only code
 that reads the synced set.

 A reconcile reads everything first — the registry, every per-gateway config, the device-only
 credentials, the print key, the synced records — and stops if any read fails for a reason other
 than "not found" (protected data unavailable counts as a failure), or if the synced store is
 unavailable: a partial snapshot must never reach the merge, where a missing credential or record
 reads as an "everything was deleted" (an empty store) or as a change. An empty store read
 without an error is passed on as empty: the merge takes it for "Delete everything from iCloud
 Keychain". Then `GatewaySync.reconcile` makes a plan with at most one local op per gateway (a plan
 that has more is refused whole), applied in this order, every step safe to repeat:

 0. `GatewayLifecycle.willPurge` for every gateway the plan purges;
 1. one SQLite transaction: a check that the sync state (with its `generation`) and the journal are
    exactly what the snapshot read and that every field an `.update` writes is unchanged since
    then, then the registry and config ops, `SyncPlan.provisionalState` (every local write marked
    pending) and the journal of gateways whose device-only items must go (review A3: no await
    between the check and the commit);
 2. the device-only credentials, each only if it is still what the snapshot read;
 3. the remote puts and deletes; a failure is logged and left to a later run, whose merge puts
    the registers back;
 4. one SQLite transaction: `SyncPlan.state`, if the stored state is still the provisional one,
    and the journal entries step 2 finished.

 A crash after any step leaves something the next reconcile finishes: the pending marks make the
 merge redo a credential write that did not land (and never take a received value for one entered
 here), the journal names the gateways whose device-only items are still to delete, and orphaned
 items of gateways that left the registry are deleted before anything else. With sync off, the
 merge's state scrubbed of intents is saved and iCloud is not reconciled; the one exception is a
 "Delete Everything from iCloud Keychain" the person asked for and that was cut short: the
 clean-up finishes it (only the items that were there at the request and are unchanged since).

 Every person's action that the merge must know of is an intent here, committed before its
 destructive step. Intents and reconciles interleave only at awaits; a reconcile that sees an
 intent arrive (an in-actor counter, and the stored state in the transaction) throws its plan
 away and computes a new one, so an intent is never overwritten.
 */
public actor GatewaySyncEngine {
  let database: SQLiteStore
  let secrets: any SyncDeviceSecretStore
  let synced: any SyncedItemStore
  let lifecycle: any GatewayLifecycle
  let clock: SyncClock
  let timing: SyncTiming
  let log: SyncLogger
  let randomBytes: @Sendable (Int) -> [UInt8]

  /// What the views read. Updated by the engine only.
  public nonisolated let status: SyncStatus
  let hub = SyncEventHub<SyncNotice>()

  /// Set by the app: republish the share extension's delivery record after a gateway's
  /// credentials changed here (or the gateway went).
  var credentialsChanged: (@Sendable (String) async -> Void)?

  // Scheduling (SyncTriggers.swift).
  var chain: Task<SyncOutcome, Never>?
  var queuedTicket: Int?
  var ticket = 0
  var chainFinished = true
  var debounce: Task<Void, Never>?
  var lastForeground: Double?

  /// Bumped when an intent starts and when it ends; a reconcile that sees it move discards its plan.
  var intents = 0
  /// Intents started and not yet finished. A reconcile waits for them before it looks at anything:
  /// one already running when the reconcile starts may commit without changing the sync state.
  var intentsRunning = 0
  var intentWaiters: [CheckedContinuation<Void, Never>] = []
  /// Tests only: runs at the named points inside intents; throwing there is a crash.
  var intentProbe: (@Sendable (SyncIntentStep) async throws -> Void)?
  /// Unreadable local credential items already reported, so each is said once.
  var reportedUnreadable: Set<String> = []
  /// Gateways whose credentials are bound to an origin they left; the loaders give them nothing.
  nonisolated let quarantine = CredentialQuarantine()
  var availability: SyncStatus.Availability = .unknown

  /// Tests: runs after each step of applying a plan; throwing there is a crash at that point.
  var probe: (@Sendable (SyncApplyStep) async throws -> Void)?
  /// Tests: the merge rules the last plan used.
  var lastTraces: Set<SyncTrace> = []
  /// Tests only: the gateway ids of the local ops of every plan applied.
  var opLog: [[String]] = []

  public init(
    database: SQLiteStore,
    secrets: any SyncDeviceSecretStore,
    synced: any SyncedItemStore,
    lifecycle: any GatewayLifecycle = NoGatewayLifecycle(),
    clock: SyncClock = .system,
    timing: SyncTiming = SyncTiming(),
    logger: SyncLogger = .system,
    status: SyncStatus = SyncStatus(),
    randomBytes: @escaping @Sendable (Int) -> [UInt8] = GatewaySyncEngine.systemRandomBytes
  ) {
    self.database = database
    self.secrets = secrets
    self.synced = synced
    self.lifecycle = lifecycle
    self.clock = clock
    self.timing = timing
    self.log = logger
    self.status = status
    self.randomBytes = randomBytes
  }

  public static let systemRandomBytes: @Sendable (Int) -> [UInt8] = { count in
    var generator = SystemRandomNumberGenerator()
    return (0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) }
  }

  /// The UI's events: adopted, removed elsewhere, needs sign-in, unavailable. Each access is a new
  /// subscription that hears everything from then on.
  public nonisolated var events: AsyncStream<SyncNotice> {
    hub.subscribe()
  }

  /// Set the share-delivery republish hook (see `credentialsChanged`).
  public func setCredentialsChangedHandler(_ handler: (@Sendable (String) async -> Void)?) {
    credentialsChanged = handler
  }

  func setProbe(_ probe: (@Sendable (SyncApplyStep) async throws -> Void)?) {
    self.probe = probe
  }

  // MARK: - Reconcile

  enum Attempt {
    case done(SyncOutcome)
    case retry
  }

  func reconcileSerially(_ reason: SyncReason) async -> SyncOutcome {
    var outcome = SyncOutcome.superseded

    attempts: for _ in 0..<5 {
      switch await attempt() {
      case let .done(result):
        outcome = result
        break attempts
      case .retry:
        continue
      }
    }

    log("reconcile(\(reason.rawValue)): \(outcome)")
    await flushCredentialChanges()
    let finished: Bool = if case .applied = outcome { true } else { outcome == .upToDate }
    await refreshStatus(outcome: outcome, reconciledAt: finished ? clock.now() : nil)
    return outcome
  }

  /// What the snapshot read of SQLite.
  struct LocalRead: Sendable {
    var stateText: String?
    var journalText: String?
    var registryText: String?
    var registry: GatewayRegistry
    var configs: [String: String]
    var origins: [String: String]
  }

  func readLocal() async throws -> LocalRead {
    try await database.read { db in
      let registryText = try db.kvValue(forKey: StoreKeys.gateways)
      let registry = try Self.checkedRegistry(registryText)
      var configs: [String: String] = [:]
      var origins: [String: String] = [:]

      for gateway in registry.gateways {
        configs[gateway.id] = try db.kvValue(forKey: SyncMaterializer.configKey(gateway.id))
        origins[gateway.id] = try db.kvValue(forKey: SyncMaterializer.credentialOriginKey(gateway.id))
      }

      return LocalRead(
        stateText: try db.kvValue(forKey: SyncState.storageKey),
        journalText: try db.kvValue(forKey: SyncJournal.storageKey),
        registryText: registryText,
        registry: registry,
        configs: configs,
        origins: origins
      )
    }
  }

  /// Everything one plan was computed from.
  struct Snapshot: Sendable {
    var stateText: String?
    var journalText: String?
    var stored: SyncState?
    /// The state the merge got: the stored one with this device's tag.
    var input: SyncState
    var gateways: [String: LocalGateway]
    /// The device-only items as read, by gateway id and field.
    var raw: [String: [SyncField: String]]
    var printer: SyncPrinter
  }

  func attempt() async -> Attempt {
    await waitForIntents()
    let mark = intents
    let read: LocalRead

    do {
      read = try await readLocal()
    } catch {
      return .done(fail(error, "read the local state"))
    }

    guard read.registry.unsupportedVersion == nil else {
      return .done(fail(SyncEngineError.unsupportedRegistry, "read the gateway list"))
    }

    quarantine.replace(with: Self.movedAway(read.registry, read.origins))

    let stored = SyncState.decode(read.stateText)

    if stored?.unsupportedVersion != nil {
      return .done(.skipped(.unsupportedState))
    }

    let journal = SyncJournal.decode(read.journalText)

    // Rule 2 and A8: what earlier runs left behind goes before anything is read for the merge.
    do {
      if try await cleanUp(read, stored: stored, journal: journal, mark: mark) {
        return .retry
      }
    } catch is StalePlan {
      return .retry
    } catch {
      return .done(fail(error, "clean up"))
    }

    guard mark == intents else { return .retry }

    let state = stored ?? SyncState(device: "", enabled: true, disclosed: false)

    guard state.enabled else {
      // Sync is off here: the merge only drops intents that would reach other devices (a clear,
      // a removal on all devices). That state is saved; nothing is read from or written to iCloud.
      if let stored {
        let plan = GatewaySync.reconcile(
          local: LocalSyncSnapshot(gateways: [], newIds: [], printer: Self.noPrinter), remote: [], state: stored,
          now: clock.now())

        if plan.stateChanged, plan.localOps.isEmpty, !plan.hasRemoteWrites {
          do {
            let text = try plan.state.encoded()
            let expected = read.stateText
            try await database.write { db in
              guard try db.kvValue(forKey: SyncState.storageKey) == expected else { throw StalePlan() }
              try db.kvSet(text, forKey: SyncState.storageKey)
            }
            log("sync is off: dropped the intents not acted on")
          } catch is StalePlan {
            return .retry
          } catch {
            return .done(fail(error, "save the sync state"))
          }
        }
      }

      return .done(.skipped(.disabled))
    }

    guard noteAvailability(synced.availability()) == .available else {
      return .done(.skipped(.unavailable))
    }

    guard state.disclosed else {
      return .done(.skipped(.notDisclosed))
    }

    // From here to the merge nothing awaits: the snapshot is one consistent read.
    let items: [SyncedItem]

    do {
      items = try synced.all()
    } catch {
      return .done(fail(SyncEngineError.wrap(error, synced: true), "list iCloud Keychain"))
    }

    // A list from a store that became unavailable while it was read is not what iCloud holds: an
    // empty one would read as "Delete everything". The read failed.
    guard noteAvailability(synced.availability()) == .available else {
      return .done(fail(SyncEngineError.storeUnavailable, "list iCloud Keychain"))
    }

    let records = items.compactMap { SyncedGatewayRecord.decode(account: $0.account, value: $0.value) }
    let snapshot: Snapshot

    do {
      snapshot = try buildSnapshot(read, stored: stored, state: state, records: records)
    } catch {
      return .done(fail(error, "read this device's gateways"))
    }

    let now = clock.now()
    let newIds: [String]

    do {
      newIds = try mintIds(records.count + 4)
    } catch {
      return .done(fail(error, "mint gateway ids"))
    }

    noteClockSkew(records, now: now)

    let plan = GatewaySync.reconcile(
      local: LocalSyncSnapshot(
        gateways: snapshot.gateways.values.sorted { $0.id < $1.id }, newIds: newIds, printer: snapshot.printer),
      remote: records,
      state: snapshot.input,
      now: now
    )
    lastTraces = plan.traces

    guard mark == intents else { return .retry }

    let saveState = stored != plan.state

    if plan.isEmpty, !saveState, journal.isEmpty {
      return .done(.upToDate)
    }

    log("plan: \(plan)")
    return await apply(plan, snapshot, saveState: saveState, mark: mark)
  }

  /// The device-only half of the snapshot: the identity, each gateway's config and credentials.
  /// Any read that fails throws; only "not found" is `nil`.
  func buildSnapshot(
    _ read: LocalRead, stored: SyncState?, state: SyncState, records: [SyncedGatewayRecord]
  ) throws -> Snapshot {
    let identity = try SyncPrintKey.load(
      from: secrets, stateDevice: stored?.device, stateCheck: stored?.printCheck, randomBytes: randomBytes)

    if identity.mintedKey, stored?.printCheck != nil || identity.replacedUnreadableKey {
      log("print key missing: minted a new key and device tag; every field is rebuilt from its stamp")
    } else if identity.mintedDevice, stored?.printCheck != nil {
      log("the sync state was made under another print key: minted a new device tag")
    }

    var gateways: [String: LocalGateway] = [:]
    var raw: [String: [SyncField: String]] = [:]

    for record in read.registry.gateways {
      let config = try SyncMaterializer.config(read.configs[record.id])
      let keys = try SecretKeys.gateway(record.id)
      var items: [SyncField: String] = [:]

      for slot in SyncMaterializer.Slot.allCases {
        items[slot.field] = try secrets.get(slot.key(keys))
      }

      let origin = read.origins[record.id] ?? GatewayAddress.origin(of: record.address)

      var gateway = SyncMaterializer.localGateway(
        record: record, config: config, credentialOrigin: origin, frontDoorRaw: items[.frontDoor],
        headersRaw: items[.headers], sessionTokenRaw: items[.sessionToken])

      // An item this build cannot read is never overwritten. It counts as holding whatever the
      // record holds, so the merge neither restores over it nor publishes anything for it.
      for slot in SyncMaterializer.Slot.allCases where SyncMaterializer.isUnreadable(slot, raw: items[slot.field]) {
        let synced = records.first { $0.key == gateway.key && $0.isSupported }
        switch slot {
        case .frontDoor: gateway.frontDoor = synced?.frontDoor
        case .headers: gateway.headers = synced?.headers
        case .sessionToken: gateway.sessionToken = synced?.sessionToken
        }
        if reportedUnreadable.insert("\(record.id).\(slot.field.rawValue)").inserted {
          notesBuffer.append("unreadable(\(record.id), \(slot.field.rawValue))")
          log("\(record.id): \(slot.field.rawValue) is an item this build cannot read; left alone")
        }
      }

      gateways[record.id] = gateway
      raw[record.id] = items
    }

    var input = state
    input.device = identity.device

    return Snapshot(
      stateText: read.stateText, journalText: read.journalText, stored: stored, input: input, gateways: gateways,
      raw: raw, printer: identity.printer)
  }

  // MARK: Clean-up before a reconcile

  /**
   Device-only items left by an earlier run, deleted before anything is read for the merge:

   - every gateway the journal lists as purged, and every gateway the sync state knows that is no
     longer in the registry (a crash between a purge and its keychain clean-up) loses its items;
   - a gateway whose address moved to another origin since its session token and headers were
     stored loses all six credentials (I13), and is then bound to its new origin; a gateway seen
     for the first time is bound to its origin now;
   - after a reinstall (no state row, an empty registry, but a print key: iOS keeps keychain
     items), every gateway credential left from the earlier install goes (A8).

   Deletions come first, the bookkeeping after them, so a crash in between repeats the deletion.
   Returns whether it wrote anything (the caller then reads again).
   */
  func cleanUp(_ read: LocalRead, stored: SyncState?, journal: SyncJournal, mark: Int) async throws -> Bool {
    // Nothing is deleted while an intent runs or after one ran since this reconcile looked: an add
    // in flight may already have written credentials under its new id.
    guard mark == intents, intentsRunning == 0 else {
      throw StalePlan()
    }

    let ids = Set(read.registry.gateways.map(\.id))
    var reinstall = false

    if read.stateText == nil, ids.isEmpty, try SyncPrintKey.exists(in: secrets) {
      // Push secrets are the push registrar's (see `deviceItems(of:)`), even after a reinstall.
      try secrets.removeAll(prefix: "hermie.auth.")
      reinstall = true
      log("first run after a reinstall: removed the credentials of the earlier install")
    }

    let orphans = journal.purge.union(Set(stored?.entries.keys.map { $0 } ?? [])).subtracting(ids)
      .filter(GatewayRegistry.isGatewayId)

    for id in orphans.sorted() where try deleteItems(try Self.deviceItems(of: id)) {
      changedCredentials.insert(id)
    }

    // Items an intent committed to delete: only while they still hold the value it saw.
    if !journal.keys.isEmpty {
      let printer = try journalPrinter(checking: true)
      for (key, print) in journal.keys.sorted(by: { $0.key < $1.key }) {
        if try deleteItem(key, ifPrint: print, printer: printer), let dash = key.lastIndex(of: "-") {
          changedCredentials.insert(String(key[key.index(after: dash)...]))
        }
      }
    }

    // "Delete everything" cut short: the rest of the items go before the store is read, so the
    // gateways marked absent are not attached again by the items that survived.
    // This writes to iCloud even with sync off: it finishes what the person asked for.
    var finishedDeleteEverything = false
    if !journal.deleteEverything.isEmpty, synced.availability() == .available {
      let printer = try journalPrinter(checking: true)
      do {
        for item in try synced.all() {
          guard let print = journal.deleteEverything[item.account],
            SyncJournal.print(item.value, key: item.account, printer: printer) == print
          else { continue }
          try synced.delete(account: item.account)
        }
      } catch {
        throw SyncEngineError.wrap(error, synced: true)
      }
      finishedDeleteEverything = true
      log("finished deleting everything from iCloud Keychain")
    }

    var markers: [String: String] = [:]

    for record in read.registry.gateways {
      let origin = GatewayAddress.origin(of: record.address)

      if let marker = read.origins[record.id] {
        guard marker != origin else { continue }

        quarantine.insert(record.id)
        if try deleteOldOriginCredentials(of: record.id, newOrigin: origin) {
          changedCredentials.insert(record.id)
        }
        log("\(record.id): address moved to another origin; its credentials for the old one were deleted")
      }

      markers[record.id] = origin
    }

    let purged = journal.purge
    let deletedKeys = Set(journal.keys.keys)

    guard reinstall || !markers.isEmpty || !purged.isEmpty || !deletedKeys.isEmpty || finishedDeleteEverything else {
      return false
    }

    let expected = (read.stateText, read.journalText, read.registryText)
    let (newMarkers, mintState, everythingDone) = (markers, reinstall, finishedDeleteEverything)

    try await database.write { db in
      guard try db.kvValue(forKey: SyncState.storageKey) == expected.0,
        try db.kvValue(forKey: SyncJournal.storageKey) == expected.1,
        try db.kvValue(forKey: StoreKeys.gateways) == expected.2
      else {
        throw StalePlan()
      }

      for (id, origin) in newMarkers {
        try db.kvSet(origin, forKey: SyncMaterializer.credentialOriginKey(id))
      }

      var next = journal
      next.purge.subtract(purged)
      for key in deletedKeys { next.keys[key] = nil }
      if everythingDone { next.deleteEverything = [:] }
      try Self.writeJournal(next, in: db)

      if mintState {
        try db.kvSet(try SyncState(device: "", enabled: true, disclosed: false).encoded(), forKey: SyncState.storageKey)
      }
    }

    for id in newMarkers.keys { quarantine.remove(id) }
    return true
  }

  /// The printer for journal entries: the device's print key (minted when there is none). When the
  /// key had to be minted, no print made before can match: every pending deletion it checks is left
  /// in place (a credential a crashed sign-out meant to delete stays), and the developer notes say so.
  func journalPrinter(checking: Bool = false) throws -> SyncPrinter {
    let identity = try SyncPrintKey.load(from: secrets, stateDevice: nil, stateCheck: nil, randomBytes: randomBytes)
    if checking, identity.mintedKey {
      notesBuffer.append("journalUnverifiable")
      log("print key missing: pending deletions cannot be checked and are left in place")
    }
    return identity.printer
  }

  /// Delete one item if it still holds the value whose print was journalled; whether it did.
  func deleteItem(_ key: String, ifPrint print: String, printer: SyncPrinter) throws -> Bool {
    guard let current = try secrets.get(key) else { return false }

    guard SyncJournal.print(current, key: key, printer: printer) == print else {
      log("an item an intent was to delete holds another value now; left alone")
      return false
    }

    try secrets.delete(key)
    return true
  }

  /// I13: what was stored for an origin the gateway left goes. Only the front door names its own
  /// origin; one already stored for the new origin is kept. Whether anything was deleted.
  func deleteOldOriginCredentials(of id: String, newOrigin: String) throws -> Bool {
    let keys = try SecretKeys.gateway(id)
    var doomed = keys.credentials.filter { $0 != keys.frontDoor }

    if SyncMaterializer.frontDoor(try secrets.get(keys.frontDoor))?.origin != newOrigin {
      doomed.append(keys.frontDoor)
    }

    return try deleteItems(doomed)
  }

  /**
   The device-only items of a gateway that sync deletes when the gateway goes (a purge, "Remove",
   the orphan sweep): its six credentials, named one by one. Never a push key (`pushManage` and the
   rest): push registration belongs to the push registrar alone, which still needs the manage
   secret after the gateway is gone, to unregister at the relay, and removes its own items then.
   */
  static func deviceItems(of id: String) throws -> [String] {
    try SecretKeys.gateway(id).credentials
  }

  /// Delete device-only items; whether any of them was there.
  func deleteItems(_ keys: [String]) throws -> Bool {
    var any = false
    for key in keys where try secrets.get(key) != nil {
      try secrets.delete(key)
      any = true
    }
    return any
  }

  /// The registry, refusing a stored value that is there but is not a whole v1 list: a damaged
  /// one would read as "no gateways", and every credential would look orphaned.
  static func checkedRegistry(_ text: String?) throws -> GatewayRegistry {
    let registry = GatewayRegistry.decode(text)

    if registry.unsupportedVersion != nil {
      throw SyncEngineError.unsupportedRegistry
    }

    guard let text else {
      return registry
    }

    guard let root = (try? JSONValue(parsing: text))?.objectValue, root["v"]?.doubleValue == 1,
      let rows = root["gateways"]?.arrayValue, rows.count == registry.gateways.count
    else {
      throw SyncEngineError.unreadableRegistry
    }

    return registry
  }

  /// For a merge call that must never print: with sync off the merge only scrubs intents. A print
  /// made here would hold a value in clear, so this one stops the process instead.
  static let noPrinter = SyncPrinter { _ in
    preconditionFailure("the merge printed a value while sync was off")
  }

  // MARK: Intents in flight

  func beginIntent() {
    intents += 1
    intentsRunning += 1
  }

  func endIntent() {
    intents += 1
    intentsRunning -= 1

    if intentsRunning == 0 {
      let waiters = intentWaiters
      intentWaiters = []
      for waiter in waiters { waiter.resume() }
    }
  }

  func waitForIntents() async {
    while intentsRunning > 0 {
      await withCheckedContinuation { intentWaiters.append($0) }
    }
  }

  /// Tests: how many reconciles are waiting for intents to finish.
  var waitingForIntents: Int { intentWaiters.count }

  func intentStep(_ step: SyncIntentStep) async throws {
    if let intentProbe {
      try await intentProbe(step)
    }
  }

  func setIntentProbe(_ probe: (@Sendable (SyncIntentStep) async throws -> Void)?) {
    intentProbe = probe
  }

  // MARK: Applying a plan

  /// The merge's promise (`SyncPlan`): at most one local op per gateway. A plan that breaks it is
  /// not applied at all.
  static func validate(_ plan: SyncPlan) throws {
    let ids = plan.localOps.map(\.gatewayId)

    guard Set(ids).count == ids.count else {
      throw SyncEngineError.invalidPlan
    }
  }

  func apply(_ plan: SyncPlan, _ snapshot: Snapshot, saveState: Bool, mark: Int) async -> Attempt {
    do {
      try Self.validate(plan)
    } catch {
      return .done(fail(error, "apply the plan"))
    }

    opLog.append(plan.localOps.map(\.gatewayId))
    var changed = Set<String>()
    defer { changedCredentials.formUnion(changed) }

    // 0. The session layer lets go of what is about to be purged.
    for case let .purge(id) in plan.localOps {
      await lifecycle.willPurge(gatewayId: id)
    }

    if let crash = await step(.willPurge) { return .done(crash) }
    guard mark == intents else { return .retry }

    // 1. Registry, config, provisional state and the purge journal: one transaction.
    var journal = SyncJournal.decode(snapshot.journalText)
    for case let .purge(id) in plan.localOps { journal.purge.insert(id) }
    let committedJournal = journal

    let provisionalText: String?
    do {
      provisionalText = try await database.write { db in
        try Self.commit(plan, snapshot, journal: committedJournal, saveState: saveState, in: db)
      }
    } catch is StalePlan {
      log("plan discarded: the state or a gateway changed since it was read")
      return .retry
    } catch {
      return .done(fail(error, "commit the plan"))
    }

    // What the plan did to the gateway list is committed: say so now, whatever happens next.
    announce(plan.events)

    if let crash = await step(.localTransaction) { return .done(crash) }
    // An intent arrived while the transaction committed: its own effects must not be undone by
    // this plan's credential writes. The pending marks keep them; the next plan does them right.
    guard mark == intents else { return .retry }

    // 2. Device-only credentials.
    var summary = SyncSummary()
    var purged = Set<String>()

    do {
      try writeSecrets(plan, snapshot, summary: &summary, purged: &purged, changed: &changed)
    } catch {
      return .done(fail(error, "write this device's credentials"))
    }

    if let crash = await step(.secrets) { return .done(crash) }
    guard mark == intents else { return .retry }

    // 3. iCloud Keychain. A failure is not a reason to stop: the merge puts back every register
    // the store lacks at the next reconcile.
    writeRemote(plan, summary: &summary)

    if let crash = await step(.remote) { return .done(crash) }

    // 4. The final state, unless something was recorded since the provisional one (then the
    // pending marks stay, and the next reconcile settles them), and the finished purges.
    do {
      let finalText = try plan.state.encoded()
      let finishedPurges = purged
      try await database.write { db in
        var current = SyncJournal.decode(try db.kvValue(forKey: SyncJournal.storageKey))
        current.purge.subtract(finishedPurges)
        try Self.writeJournal(current, in: db)

        guard let provisionalText, finalText != provisionalText,
          try db.kvValue(forKey: SyncState.storageKey) == provisionalText
        else { return }
        try db.kvSet(finalText, forKey: SyncState.storageKey)
      }
    } catch {
      return .done(fail(error, "save the sync state"))
    }

    if let crash = await step(.state) { return .done(crash) }

    return .done(.applied(summary))
  }

  /// Tests only: the probe after a step; a throw is a crash there.
  func step(_ step: SyncApplyStep) async -> SyncOutcome? {
    guard let probe else { return nil }

    do {
      try await probe(step)
      return nil
    } catch {
      return .failed(.other("interrupted after \(step)"))
    }
  }

  /// Step 1, inside the transaction. Throws `StalePlan` when the plan no longer fits. Returns the
  /// state text it stored, for step 4 to tell whether anything was recorded since.
  static func commit(
    _ plan: SyncPlan,
    _ snapshot: Snapshot,
    journal: SyncJournal,
    saveState: Bool,
    in db: SQLiteDatabase
  ) throws -> String? {
    // The generation check (and more): the stored state and journal are byte for byte what the
    // plan was computed from. No await between this and the commit.
    guard try db.kvValue(forKey: SyncState.storageKey) == snapshot.stateText,
      try db.kvValue(forKey: SyncJournal.storageKey) == snapshot.journalText
    else {
      throw StalePlan()
    }

    let start = try checkedRegistry(try db.kvValue(forKey: StoreKeys.gateways))
    var registry = start

    for op in plan.localOps {
      switch op {
      case let .add(gateway):
        // A repeat of an add that landed: nothing to do.
        if registry.gateway(id: gateway.id) != nil {
          continue
        }

        // Someone added this origin here since the snapshot.
        if registry.gateways.contains(where: { GatewayKey.of($0.address) == gateway.key }) {
          throw StalePlan()
        }

        registry = registry.adding(SyncMaterializer.newRecord(gateway))
        let current = try SyncMaterializer.config(try db.kvValue(forKey: SyncMaterializer.configKey(gateway.id)))
        let config = SyncMaterializer.config(current, writing: gateway, fields: Set(SyncField.allCases))
        try db.kvSet(try SyncMaterializer.configText(config), forKey: SyncMaterializer.configKey(gateway.id))
        try db.kvSet(
          GatewayAddress.origin(of: gateway.address), forKey: SyncMaterializer.credentialOriginKey(gateway.id))

      case let .update(gateway, fields):
        guard let row = registry.gateway(id: gateway.id), let before = snapshot.gateways[gateway.id] else {
          throw StalePlan()
        }

        let configText = try db.kvValue(forKey: SyncMaterializer.configKey(gateway.id))
        let config = try SyncMaterializer.config(configText)
        let now = SyncMaterializer.storedGateway(record: row, config: config)

        // Instruction 8: only the listed fields, and only if they are as the snapshot read them.
        // The address always, because the credentials written next are bound to its origin.
        guard now.address == before.address,
          fields.allSatisfy({ SyncMaterializer.same($0, now, before) })
        else {
          throw StalePlan()
        }

        let signedOut = plan.state.entries[gateway.id]?.signedOut ?? false
        registry = registry.updating(id: gateway.id) { record in
          SyncMaterializer.apply(gateway, fields: fields, signedOut: signedOut, to: &record)
        }

        if !fields.isDisjoint(with: [.address, .authKind, .provider]) {
          let next = SyncMaterializer.config(config, writing: gateway, fields: fields)
          try db.kvSet(try SyncMaterializer.configText(next), forKey: SyncMaterializer.configKey(gateway.id))
        }

      case let .purge(id):
        // The gateway the plan saw, at the address it saw: one moved meanwhile holds credentials
        // for its new origin, and is not this plan's to remove.
        if let row = registry.gateway(id: id) {
          guard let before = snapshot.gateways[id], row.address == before.address else {
            throw StalePlan()
          }
        }
        registry = registry.removing(id: id)
        try GatewayRegistryStore.purge(gatewayId: id, in: db)
      }
    }

    if registry != start {
      try db.kvSet(try registry.encoded(), forKey: StoreKeys.gateways)
    }

    var stateText = snapshot.stateText

    if saveState || plan.provisionalState != plan.state {
      stateText = try plan.provisionalState.encoded()
      try db.kvSet(stateText!, forKey: SyncState.storageKey)
    }

    try writeJournal(journal, in: db)
    return stateText
  }

  static func writeJournal(_ journal: SyncJournal, in db: SQLiteDatabase) throws {
    if journal.isEmpty {
      try db.kvRemove(SyncJournal.storageKey)
    } else {
      try db.kvSet(try journal.encoded(), forKey: SyncJournal.storageKey)
    }
  }

  /// Step 2. Synchronous: nothing else on the engine runs in between. Each op writes its listed
  /// fields only.
  func writeSecrets(
    _ plan: SyncPlan,
    _ snapshot: Snapshot,
    summary: inout SyncSummary,
    purged: inout Set<String>,
    changed: inout Set<String>
  ) throws {
    for op in plan.localOps {
      switch op {
      case let .add(gateway):
        let keys = try SecretKeys.gateway(gateway.id)
        for slot in SyncMaterializer.Slot.allCases {
          let key = slot.key(keys)
          if try perform(
            SyncMaterializer.write(slot, of: gateway, signedOut: false, currentRaw: try secrets.get(key)),
            key: key, gatewayId: gateway.id, field: slot.field) {
            changed.insert(gateway.id)
          }
        }
        summary.added += 1

      case let .update(gateway, fields):
        let keys = try SecretKeys.gateway(gateway.id)
        let signedOut = plan.state.entries[gateway.id]?.signedOut ?? false

        for field in fields.sorted() {
          guard let slot = SyncMaterializer.Slot(field) else { continue }
          let key = slot.key(keys)
          let current = try secrets.get(key)

          // Changed outside the engine since the snapshot: leave it. Its pending mark makes the
          // next reconcile see it as the person's change.
          guard current == snapshot.raw[gateway.id]?[field] else {
            log("\(gateway.id): \(field.rawValue) changed since the snapshot; left for the next reconcile")
            continue
          }

          let write = SyncMaterializer.write(slot, of: gateway, signedOut: signedOut, currentRaw: current)
          if try perform(write, key: key, gatewayId: gateway.id, field: field) {
            changed.insert(gateway.id)
          }
        }
        summary.updated += 1

      case let .purge(id):
        for key in try Self.deviceItems(of: id) {
          try secrets.delete(key)
        }
        changed.insert(id)
        purged.insert(id)
        summary.purged += 1
      }
    }
  }

  /// One credential write. Returns whether the item changed.
  func perform(_ write: SyncMaterializer.SecretWrite, key: String, gatewayId: String, field: SyncField) throws -> Bool {
    switch write {
    case let .set(value):
      guard try secrets.get(key) != value else { return false }
      try secrets.set(key, value)
      return true
    case .delete:
      guard try secrets.get(key) != nil else { return false }
      try secrets.delete(key)
      return true
    case let .keep(reason):
      log("\(gatewayId): \(field.rawValue) not written: \(reason)")
      return false
    }
  }

  /// Step 5.
  func writeRemote(_ plan: SyncPlan, summary: inout SyncSummary) {
    // Never before the person has seen the disclosure, whatever a plan says (I10).
    guard plan.state.enabled, plan.state.disclosed else { return }

    for record in plan.remotePuts {
      do {
        try synced.put(SyncedItem(account: record.account, value: try record.encoded()))
        summary.published += 1
      } catch {
        summary.remoteFailures += 1
        log("put \(record.account) failed: \(SyncEngineError.wrap(error, synced: true))")
      }
    }

    for account in plan.remoteDeletes {
      do {
        try synced.delete(account: account)
        summary.deleted += 1
      } catch {
        summary.remoteFailures += 1
        log("delete \(account) failed: \(SyncEngineError.wrap(error, synced: true))")
      }
    }
  }

  func announce(_ events: [SyncEvent]) {
    var notices: [SyncNotice] = []
    var notes: [String] = []

    for event in events {
      switch event {
      case let .adopted(gatewayId): notices.append(.adopted(gatewayId: gatewayId))
      case let .removedElsewhere(gatewayId, name): notices.append(.removedElsewhere(gatewayId: gatewayId, name: name))
      case let .needsSignIn(gatewayId): notices.append(.needsSignIn(gatewayId: gatewayId))
      case let .storeEmptied(gatewayIds): notices.append(.storeEmptied(gatewayIds: gatewayIds))
      case let .removedElsewhereKeptHere(gatewayIds): notices.append(.removedElsewhereKeptHere(gatewayIds: gatewayIds))
      default: notes.append(event.description)
      }
    }

    hub.send(notices)
    notesBuffer += notes
  }

  /// Tell the app which gateways' credentials changed, so it republishes the share delivery record.
  func flushCredentialChanges() async {
    let ids = changedCredentials.sorted()
    changedCredentials = []

    guard let handler = credentialsChanged else { return }

    for id in ids {
      await handler(id)
    }
  }

  // MARK: Helpers

  func mintIds(_ count: Int) throws -> [String] {
    try (0..<count).map { _ in
      let bytes = randomBytes(8)
      guard bytes.count == 8 else { throw SyncEngineError.randomUnavailable }
      return "g" + bytes.map { String(format: "%02x", $0) }.joined()
    }
  }

  @discardableResult
  func noteAvailability(_ value: SyncedStoreAvailability) -> SyncedStoreAvailability {
    let next: SyncStatus.Availability = value == .available ? .available : .unavailable

    if next == .unavailable, availability != .unavailable {
      log("iCloud Keychain is unavailable to this process; sync is paused")
      hub.send([.unavailable])
    }

    availability = next
    return value
  }

  func noteClockSkew(_ records: [SyncedGatewayRecord], now: Double) {
    let highest = records.compactMap(\.highestT).max()
    skew = highest.map { $0 - now }.flatMap { $0 > 60_000 ? $0 : nil }
  }

  func fail(_ error: any Error, _ what: String) -> SyncOutcome {
    let wrapped = SyncEngineError.wrap(error)
    log("could not \(what): \(wrapped)")
    return .failed(wrapped)
  }

  /// Re-read the state and the registry and show them.
  func refreshStatus(outcome: SyncOutcome? = nil, reconciledAt: Double? = nil) async {
    let read = try? await database.read { db in
      (
        try db.kvValue(forKey: SyncState.storageKey),
        GatewayRegistry.decode(try db.kvValue(forKey: StoreKeys.gateways)).inOrder.map(\.id)
      )
    }

    guard let (stateText, ids) = read else { return }

    let state = SyncState.decode(stateText)
    let update = SyncStatus.Update(
      enabled: state?.enabled ?? true,
      disclosed: state?.disclosed ?? false,
      unsupportedState: state?.unsupportedVersion != nil,
      gateways: SyncStatus.gateways(ids: ids, state: state),
      availability: availability == .unknown ? nil : availability,
      outcome: outcome,
      reconciledAt: reconciledAt,
      clockSkew: outcome == nil ? nil : .some(skew),
      developerNotes: notesBuffer
    )
    notesBuffer = []

    let status = self.status
    await MainActor.run { status.apply(update) }
  }

  var notesBuffer: [String] = []
  var skew: Double?
  var changedCredentials = Set<String>()
}
