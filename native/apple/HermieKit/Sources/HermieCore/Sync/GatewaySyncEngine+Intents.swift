import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore

/**
 What the person does that sync must know of. Each intent is committed to the sync state before
 its destructive step (instruction 7, review A2), moves the engine's intent counter when it starts
 and when it ends (so a reconcile running meanwhile throws its plan away, and one starting meanwhile
 waits for it), and asks for a reconcile afterwards.

 These are the ONLY paths for what they do, whether sync is on, off, or not yet disclosed:
 settings, the onboarding and the session layer never add a gateway, change its address or auth
 kind, remove it, sign out of it or clear one of its credentials by writing the registry or the
 keychain themselves. The engine binds each gateway's credentials to the origin they were entered
 for; an address changed behind its back reads as a move to another origin, and the credentials of
 the old one are deleted (I13). A sign-in flow writes its tokens only for a gateway that
 `addGateway` has already added.
 */
extension GatewaySyncEngine {
  // MARK: Adding and adopting

  /// The add wizard completed: the registry entry, its config and the person's "added here" in
  /// one transaction, then the credentials. If the credentials cannot be written, the entry is
  /// taken out again. Refuses an address that names no gateway (review A7).
  @discardableResult
  public func addGateway(_ new: NewGateway) async throws -> String {
    beginIntent()
    defer { endIntent() }

    let key = GatewayKey.of(new.address)

    guard GatewayRegistry.isGatewayId(new.id), !key.isEmpty,
      let keys = try? GatewaySecretKeys(gatewayID: new.id)
    else {
      throw SyncEngineError.invalidArgument
    }

    let trimmed = new.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let record = GatewayRecord(
      id: new.id,
      name: trimmed.isEmpty ? GatewayRegistry.defaultName(for: new.address) : trimmed,
      address: new.address,
      authKind: new.authKind,
      signedInUser: new.user,
      addedAt: new.addedAt ?? clock.now()
    )
    let local = LocalGateway(
      id: record.id, name: record.name, address: record.address, authKind: record.authKind.rawValue,
      provider: new.provider, user: record.signedInUser, addedAt: record.addedAt)
    // When it was added here, by this device's clock, recorded whatever the sync state: a removal
    // on all devices made after it wins over it when sync comes on (the merge decides).
    let addedHereAt = clock.now()

    try await commitIntent(keepingForeignState: true) { db, state, _ in
      let registry = try Self.registry(in: db)

      guard registry.gateway(id: record.id) == nil else {
        throw SyncEngineError.invalidArgument
      }

      try db.kvSet(try registry.adding(record).encoded(), forKey: StoreKeys.gateways)
      let config = SyncMaterializer.config(nil, writing: local, fields: Set(SyncField.allCases))
      try db.kvSet(try SyncMaterializer.configText(config), forKey: SyncMaterializer.configKey(record.id))
      try db.kvSet(GatewayAddress.origin(of: record.address), forKey: SyncMaterializer.credentialOriginKey(record.id))

      if state.unsupportedVersion == nil {
        state.markAddedHere(gatewayId: record.id, key: key, at: addedHereAt)
      }
    }

    do {
      try GatewaySecrets.save(
        storage: SecretStorageAdapter(store: secrets), keys: keys, baseURL: new.address,
        customHeaders: new.customHeaders, frontDoor: new.frontDoor, tokens: new.tokens, sessionToken: new.sessionToken)
    } catch {
      // Taken out again. Whatever the failed save left in the keychain goes too; the journal
      // names it until it is gone, so a crash here cannot leave it behind.
      try? await commitIntent(keepingForeignState: true) { db, state, journal in
        let registry = try Self.registry(in: db)
        try db.kvSet(try registry.removing(id: record.id).encoded(), forKey: StoreKeys.gateways)
        try GatewayRegistryStore.purge(gatewayId: record.id, in: db)
        state.entries[record.id] = nil
        journal.purge.insert(record.id)
      }
      if (try? deleteDeviceItems(of: record.id)) != nil {
        try? await updateJournal { $0.purge.remove(record.id) }
      }
      throw fail(error, "store the new gateway's credentials").error
    }

    changedCredentials.insert(record.id)
    await flushCredentialChanges()
    trigger(.localChange)
    await refreshStatus()
    return record.id
  }

  /// What "Found in iCloud Keychain" lists: live records whose origin is not here and that were
  /// not removed from this device. Allowed before the disclosure; reads only.
  public func adoptable() async throws -> [AdoptableGateway] {
    guard synced.availability() == .available else {
      throw SyncEngineError.storeUnavailable
    }

    let items: [SyncedItem]

    do {
      items = try synced.all()
    } catch {
      throw SyncEngineError.wrap(error, synced: true)
    }

    guard synced.availability() == .available else {
      throw SyncEngineError.storeUnavailable
    }

    let (registry, stateText) = try await database.read { db in
      (GatewayRegistry.decode(try db.kvValue(forKey: StoreKeys.gateways)), try db.kvValue(forKey: SyncState.storageKey))
    }
    let localKeys = Set(registry.gateways.map { GatewayKey.of($0.address) })
    let hidden = SyncState.decode(stateText)?.hidden ?? []
    let records = items.compactMap { SyncedGatewayRecord.decode(account: $0.account, value: $0.value) }

    return GatewaySync.adoptable(records)
      .filter { !localKeys.contains($0.key) && !hidden.contains($0.key) }
      .compactMap { record in
        guard let address = record.address else { return nil }
        return AdoptableGateway(
          key: record.key,
          name: record.name ?? GatewayRegistry.defaultName(for: address),
          address: address,
          authKind: record.authKind ?? GatewayAuthMode.nativePKCE.rawValue,
          providerLabel: record.provider.map { $0.label ?? $0.name },
          hasSessionToken: record.sessionToken != nil,
          hasFrontDoor: record.frontDoor != nil,
          hasHeaders: record.headers != nil,
          addedAt: record.addedAt
        )
      }
  }

  /// "Use These Gateways" on a new device: the disclosure is seen, the offered records the person
  /// did not pick are hidden here, and a reconcile adopts the rest. The outcome is that reconcile's:
  /// `.upToDate` when a reconcile already queued (the disclosure triggers one) adopted them first.
  @discardableResult
  public func adopt(_ chosen: [AdoptableGateway]) async throws -> SyncOutcome {
    beginIntent()

    do {
      let offered = try await adoptable()
      let keep = Set(chosen.map(\.key))
      let hide = offered.map(\.key).filter { !keep.contains($0) }

      try await commitIntent { _, state, _ in
        state.disclosed = true
        state.hidden.formUnion(hide)
      }
    } catch {
      endIntent()
      throw error
    }

    // Finished before the reconcile, which waits for every intent in flight.
    endIntent()
    return await reconcileNow(.onboarding)
  }

  // MARK: Removing

  /**
   Remove a gateway (I9). The removal and its scope are committed with the registry purge in one
   transaction; the device-only items go after it (the journal lists them until they are gone).
   `.allDevices` only for an attached gateway (`SyncStatus.Gateway.canRemoveFromAllDevices`).
   */
  public func removeGateway(id: String, scope: RemovalScope) async throws {
    beginIntent()
    defer { endIntent() }

    let (registry, stateText) = try await database.read { db in
      (GatewayRegistry.decode(try db.kvValue(forKey: StoreKeys.gateways)), try db.kvValue(forKey: SyncState.storageKey))
    }

    guard let record = registry.gateway(id: id) else {
      throw SyncEngineError.unknownGateway
    }

    if scope == .allDevices {
      guard let state = SyncState.decode(stateText), state.unsupportedVersion == nil, state.enabled,
        state.disclosed, let entry = state.entries[id], entry.detached == nil
      else {
        throw SyncEngineError.notAttached
      }
    }

    await lifecycle.willPurge(gatewayId: id)

    let key = GatewayKey.of(record.address)
    // When the person removed it, by this device's clock: a later add elsewhere wins over it.
    let removedAt = clock.now()

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      let registry = try Self.registry(in: db)

      guard registry.gateway(id: id) != nil else { return }

      if state.unsupportedVersion == nil {
        state.markRemoved(gatewayId: id, key: key, scope: scope, at: removedAt)
      }

      try db.kvSet(try registry.removing(id: id).encoded(), forKey: StoreKeys.gateways)
      try GatewayRegistryStore.purge(gatewayId: id, in: db)
      journal.purge.insert(id)
    }

    changedCredentials.insert(id)
    try await intentStep(.removeCommitted)
    try deleteDeviceItems(of: id)
    try await updateJournal { $0.purge.remove(id) }

    await flushCredentialChanges()
    trigger(.localChange)
    await refreshStatus()
  }

  /// "Delete Everything from iCloud Keychain" (I9): every item is deleted, the remembered removals
  /// are forgotten (review A6), and every gateway here stays, device-only: each attached one is
  /// marked `absent`, so this device's next reconcile publishes none of them again. Every other
  /// device keeps its gateways too. A gateway added here later is synced as usual. The journal
  /// holds the request (the items there now, by keyed print) until they are gone: when the store
  /// fails partway, the call throws and the next reconcile deletes the rest of THOSE items before
  /// it reads anything, never one written since. With the store unavailable nothing is done.
  public func deleteEverythingFromICloud() async throws {
    beginIntent()
    defer { endIntent() }

    // What is there now, each item with a keyed print: only these go, now or after a crash.
    guard synced.availability() == .available else {
      throw SyncEngineError.storeUnavailable
    }

    let request: [String: String]

    do {
      let printer = try journalPrinter()
      var items: [String: String] = [:]
      for item in try synced.all() where SyncedGatewayRecord.key(forAccount: item.account) != nil {
        items[item.account] = SyncJournal.print(item.value, key: item.account, printer: printer)
      }
      request = items
    } catch {
      throw fail(SyncEngineError.wrap(error, synced: true), "list iCloud Keychain").error
    }

    try await commitIntent { _, state, journal in
      state.tombstones = [:]
      for id in state.entries.keys where state.entries[id]?.detached == nil {
        state.entries[id]?.detached = .absent
      }
      journal.deleteEverything = request
    }

    do {
      for account in request.keys.sorted() {
        try synced.delete(account: account)
        log("deleted \(account)")
      }
    } catch {
      await refreshStatus()
      throw fail(SyncEngineError.wrap(error, synced: true), "delete everything from iCloud Keychain").error
    }

    try await updateJournal { $0.deleteEverything = [:] }
    await refreshStatus()
  }

  // MARK: Signing in and out, and credentials

  /**
   Sign out of a gateway: `signedOut` is committed first (with the items to delete, in the
   journal), then the six credentials go, so the engine never puts a shared credential back.
   `.allDevices` (a session token) also commits the clear, which the merge publishes while signed
   out here; the other devices drop their copy.
   */
  public func signOut(id: String, scope: RemovalScope) async throws {
    beginIntent()
    defer { endIntent() }

    let record = try await gateway(id)
    let key = GatewayKey.of(record.address)
    let doomed = try journalEntries(try SecretKeys.gateway(id).credentials)

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      try Self.requireGateway(id, in: db)
      journal.keys.merge(doomed) { _, new in new }
      guard state.unsupportedVersion == nil else { return }
      state.setSignedOut(true, gatewayId: id, key: key)
      if scope == .allDevices {
        state.markClearing(.sessionToken, gatewayId: id, key: key)
      }
    }

    changedCredentials.insert(id)
    try await intentStep(.signOutCommitted)
    try await deleteJournaled(doomed, "delete the credentials")
    await flushCredentialChanges()
    trigger(.signInChange)
    await refreshStatus()
  }

  /**
   Signed in again here: an address move cut short is finished, the engine may put the shared
   credentials back, a deletion an earlier sign-out left pending is dropped, and so is a "Sign Out
   on All Devices" not yet published. A sign-in flow calls this BEFORE it stores the new tokens
   (through `tokenStore(of:)`), or uses `storeTokens(_:of:)`, which does both in order.
   */
  public func signedIn(id: String) async throws {
    beginIntent()
    defer { endIntent() }

    // A move cut short is finished first: its clean-up must not reach what this sign-in stores.
    try await finishMove(of: id)
    let record = try await gateway(id)
    let key = GatewayKey.of(record.address)
    let credentials = try SecretKeys.gateway(id).credentials

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      try Self.requireGateway(id, in: db)
      for item in credentials { journal.keys[item] = nil }
      guard state.unsupportedVersion == nil else { return }
      state.setSignedOut(false, gatewayId: id, key: key)
      state.entries[id]?.clearing.remove(.sessionToken)
    }

    trigger(.signInChange)
    await refreshStatus()
  }

  /**
   The person entered a shareable credential here (a front door, headers, a session token): a
   deletion an earlier clear or sign-out left pending for it is dropped, and so is a clear of that
   field not yet published, which would otherwise go out over the new value. `storeCredential`
   does this and then stores; nothing else writes a credential.
   */
  func credentialEntered(_ field: SyncField, of id: String) async throws {
    guard let slot = SyncMaterializer.Slot(field) else {
      throw SyncEngineError.invalidArgument
    }

    beginIntent()
    defer { endIntent() }

    try await finishMove(of: id)

    let item = slot.key(try SecretKeys.gateway(id))

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      try Self.requireGateway(id, in: db)
      journal.keys[item] = nil
      guard state.unsupportedVersion == nil else { return }
      state.entries[id]?.clearing.remove(field)
    }

    trigger(.localChange)
    await refreshStatus()
  }

  /// Remove a shareable credential on purpose, on every device: the front door, the headers or
  /// the session token. The clear is committed before the item is deleted (review A2).
  public func clear(_ field: SyncField, of id: String) async throws {
    guard let slot = SyncMaterializer.Slot(field) else {
      throw SyncEngineError.invalidArgument
    }

    beginIntent()
    defer { endIntent() }

    let record = try await gateway(id)
    let key = GatewayKey.of(record.address)
    let doomed = try journalEntries([slot.key(try SecretKeys.gateway(id))])

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      try Self.requireGateway(id, in: db)
      journal.keys.merge(doomed) { _, new in new }
      guard state.unsupportedVersion == nil else { return }
      state.markClearing(field, gatewayId: id, key: key)
    }

    changedCredentials.insert(id)
    try await intentStep(.clearCommitted)
    try await deleteJournaled(doomed, "delete the credential")
    await flushCredentialChanges()
    trigger(.localChange)
    await refreshStatus()
  }

  /// Change how a gateway signs in. Leaving `session_token` clears the session token on every
  /// device, committed with the change before the item is deleted (review A2).
  public func changeAuthKind(of id: String, to kind: GatewayAuthKind) async throws {
    beginIntent()
    defer { endIntent() }

    let record = try await gateway(id)
    let key = GatewayKey.of(record.address)
    let leavingToken = record.authKind == .sessionToken && kind != .sessionToken
    let doomed = leavingToken ? try journalEntries([try SecretKeys.gateway(id).sessionToken]) : [:]

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      let registry = try Self.registry(in: db)
      guard registry.gateway(id: id) != nil else { throw SyncEngineError.unknownGateway }
      try db.kvSet(
        try registry.updating(id: id) { $0.authKind = kind }.encoded(), forKey: StoreKeys.gateways)

      var config = try SyncMaterializer.config(try db.kvValue(forKey: SyncMaterializer.configKey(id))) ?? [:]
      config[SyncMaterializer.ConfigKey.authMode] = .string(kind.rawValue)
      config[SyncMaterializer.ConfigKey.baseURL] = config[SyncMaterializer.ConfigKey.baseURL] ?? .string(record.address)
      try db.kvSet(try SyncMaterializer.configText(config), forKey: SyncMaterializer.configKey(id))

      if leavingToken {
        journal.keys.merge(doomed) { _, new in new }
        if state.unsupportedVersion == nil {
          state.markClearing(.sessionToken, gatewayId: id, key: key)
        }
      }
    }

    if leavingToken {
      changedCredentials.insert(id)
      try await deleteJournaled(doomed, "delete the session token")
      await flushCredentialChanges()
    }

    trigger(.localChange)
    await refreshStatus()
  }

  /**
   Change a gateway's address. Within its origin this is a field edit. To another origin (I13):
   the new address is committed first, while the gateway's credentials stay bound to the old
   origin (`hermie.sync.credential_origin`); then the old origin's credentials are deleted (a front
   door already stored for the new origin is kept) and the binding moves. A crash or a failure in
   between leaves the binding on the old origin, and the next reconcile's clean-up finishes the
   deletion. The merge then removes the old record everywhere and publishes the gateway as new.
   Refuses an address that names no gateway (A7).
   */
  public func changeAddress(of id: String, to address: String) async throws {
    beginIntent()
    defer { endIntent() }

    guard !GatewayKey.of(address).isEmpty else {
      throw SyncEngineError.invalidArgument
    }

    let newOrigin = GatewayAddress.origin(of: address)
    let newKey = GatewayKey.of(address)
    // When the person moved it, by this device's clock, recorded with the address whatever the
    // sync state: at the new key the move is an add as of now, and a removal there made after it
    // still wins when sync comes on.
    let movedAt = clock.now()

    // From the commit on, until the old origin's credentials are gone, nothing loads them.
    if let current = try? await gateway(id), GatewayAddress.origin(of: current.address) != newOrigin {
      quarantine.insert(id)
    }

    let moving: Bool
    do {
      moving = try await commitIntent(keepingForeignState: true) { db, state, _ -> Bool in
        let registry = try Self.registry(in: db)

        guard let row = registry.gateway(id: id) else {
          throw SyncEngineError.unknownGateway
        }

        try db.kvSet(
          try registry.updating(id: id) { $0.address = address }.encoded(), forKey: StoreKeys.gateways)

        var config = try SyncMaterializer.config(try db.kvValue(forKey: SyncMaterializer.configKey(id))) ?? [:]
        config[SyncMaterializer.ConfigKey.baseURL] = .string(address)
        config[SyncMaterializer.ConfigKey.authMode] =
          config[SyncMaterializer.ConfigKey.authMode] ?? .string(row.authKind.rawValue)
        try db.kvSet(try SyncMaterializer.configText(config), forKey: SyncMaterializer.configKey(id))

        if GatewayKey.of(row.address) != newKey, state.unsupportedVersion == nil {
          state.markMoved(gatewayId: id, toKey: newKey, at: movedAt)
        }

        return GatewayAddress.origin(of: row.address) != newOrigin
      }
    } catch {
      // Nothing moved: the binding is what it was, and so is what the loaders may hand out.
      _ = try? await isQuarantined(id)
      throw error
    }

    if moving {
      changedCredentials.insert(id)
      try await intentStep(.addressCommitted)

      do {
        _ = try deleteOldOriginCredentials(of: id, newOrigin: newOrigin)
        try await database.write { db in
          // Moved on again since: the clean-up binds it to wherever it is now.
          guard let row = try Self.registry(in: db).gateway(id: id),
            GatewayAddress.origin(of: row.address) == newOrigin
          else { return }
          try db.kvSet(newOrigin, forKey: SyncMaterializer.credentialOriginKey(id))
        }
        quarantine.remove(id)
      } catch {
        throw fail(error, "delete the old origin's credentials").error
      }
    }

    await flushCredentialChanges()
    trigger(.localChange)
    await refreshStatus()
  }

  // MARK: Switches

  /// "Sync this gateway".
  public func setGatewaySynced(_ synced: Bool, id: String) async throws {
    beginIntent()
    defer { endIntent() }

    let record = try await gateway(id)
    let key = GatewayKey.of(record.address)

    try await commitIntent { db, state, _ in
      try Self.requireGateway(id, in: db)
      state.setGatewaySynced(synced, gatewayId: id, key: key)
    }

    trigger(.localChange)
    await refreshStatus()
  }

  /// "Sync with iCloud Keychain" on this device. Off keeps everything (I9).
  public func setSyncEnabled(_ enabled: Bool) async throws {
    beginIntent()
    defer { endIntent() }

    try await commitIntent { _, state, _ in
      state.enabled = enabled
    }

    if enabled { trigger(.manual) }
    await refreshStatus()
  }

  /// The person has seen the disclosure (I10): from now on gateways are published.
  public func disclose() async throws {
    beginIntent()
    defer { endIntent() }

    try await commitIntent { _, state, _ in
      state.disclosed = true
    }

    trigger(.manual)
    await refreshStatus()
  }

  /// The settings repair action: publish this gateway again at the next reconcile.
  public func resync(id: String) async throws {
    beginIntent()
    defer { endIntent() }

    try await commitIntent { _, state, _ in
      state.resync(gatewayId: id)
    }

    trigger(.manual)
    await refreshStatus()
  }

  // MARK: Helpers

  /// One read-modify-write of the sync state (a new one when there is none) and the journal,
  /// together with whatever `body` writes, in one transaction. A state from a newer build is
  /// never written over: the call throws, or with `keepingForeignState` `body` runs on a copy
  /// that is not saved.
  @discardableResult
  func commitIntent<T: Sendable>(
    keepingForeignState: Bool = false,
    _ body: @escaping @Sendable (SQLiteDatabase, inout SyncState, inout SyncJournal) throws -> T
  ) async throws -> T {
    do {
      return try await database.write { db in
        var state =
          SyncState.decode(try db.kvValue(forKey: SyncState.storageKey))
          ?? SyncState(device: "", enabled: true, disclosed: false)
        let foreign = state.unsupportedVersion != nil

        if foreign, !keepingForeignState {
          throw SyncEngineError.unsupportedState
        }

        let before = SyncJournal.decode(try db.kvValue(forKey: SyncJournal.storageKey))
        var journal = before

        let result = try body(db, &state, &journal)

        if !foreign {
          try db.kvSet(try state.encoded(), forKey: SyncState.storageKey)
        }

        if journal != before {
          try Self.writeJournal(journal, in: db)
        }

        return result
      }
    } catch {
      throw SyncEngineError.wrap(error)
    }
  }

  /// The registry inside a transaction, refusing one this build cannot read whole.
  static func registry(in db: SQLiteDatabase) throws -> GatewayRegistry {
    try checkedRegistry(try db.kvValue(forKey: StoreKeys.gateways))
  }

  /// Change the journal alone.
  func updateJournal(_ change: @escaping @Sendable (inout SyncJournal) -> Void) async throws {
    do {
      try await database.write { db in
        var journal = SyncJournal.decode(try db.kvValue(forKey: SyncJournal.storageKey))
        change(&journal)
        try Self.writeJournal(journal, in: db)
      }
    } catch {
      throw SyncEngineError.wrap(error)
    }
  }

  /// The journal entries for items an intent is about to delete: each item that holds something,
  /// with the keyed print of what it holds now. Read before the intent commits.
  func journalEntries(_ keys: [String]) throws -> [String: String] {
    let printer = try journalPrinter()
    var entries: [String: String] = [:]

    for key in keys {
      if let value = try secrets.get(key) {
        entries[key] = SyncJournal.print(value, key: key, printer: printer)
      }
    }

    return entries
  }

  /// Delete items an intent committed to delete, each only while it holds the value journalled,
  /// then take them off the journal. A failure leaves them there for the next reconcile.
  func deleteJournaled(_ entries: [String: String], _ what: String) async throws {
    guard !entries.isEmpty else { return }

    do {
      let printer = try journalPrinter()
      for (key, print) in entries.sorted(by: { $0.key < $1.key }) {
        _ = try deleteItem(key, ifPrint: print, printer: printer)
      }
    } catch {
      throw fail(error, what).error
    }

    try await updateJournal { journal in
      for (key, print) in entries where journal.keys[key] == print {
        journal.keys[key] = nil
      }
    }
  }

  /// Inside an intent's transaction: the gateway is still in the registry. Without this, a purge
  /// between reading the gateway and committing would leave an entry for a gateway that is gone,
  /// which hides its key here for good.
  static func requireGateway(_ id: String, in db: SQLiteDatabase) throws {
    guard try registry(in: db).gateway(id: id) != nil else {
      throw SyncEngineError.unknownGateway
    }
  }

  func gateway(_ id: String) async throws -> GatewayRecord {
    let registry = try await database.read { db in GatewayRegistry.decode(try db.kvValue(forKey: StoreKeys.gateways)) }

    guard let record = registry.gateway(id: id) else {
      throw SyncEngineError.unknownGateway
    }

    return record
  }

  /// Everything the device-only keychain holds for a gateway that sync may delete (no push key).
  func deleteDeviceItems(of id: String) throws {
    do {
      for key in try Self.deviceItems(of: id) {
        try secrets.delete(key)
      }
    } catch {
      throw fail(error, "delete a removed gateway's credentials").error
    }
  }
}

extension SyncOutcome {
  /// The error of a `.failed` outcome, for rethrowing what `fail` logged.
  var error: SyncEngineError {
    if case let .failed(error) = self { return error }
    return .other("SyncOutcome")
  }
}
