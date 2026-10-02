import Foundation
@_spi(GatewaySync) import HermieGateway
import HermieProtocol
@_spi(GatewaySync) import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A store that counts what is asked of it, to show that something never reads or writes iCloud.
final class CountingStore: SyncedItemStore {
  let inner: InMemorySyncedItemStore
  private let counts = Mutex<[String: Int]>([:])

  init(_ inner: InMemorySyncedItemStore = InMemorySyncedItemStore()) { self.inner = inner }

  func count(_ name: String) -> Int { counts.withLock { $0[name] ?? 0 } }
  private func note(_ name: String) { counts.withLock { $0[name, default: 0] += 1 } }

  func availability() -> SyncedStoreAvailability { note("availability"); return inner.availability() }
  func all() throws -> [SyncedItem] { note("all"); return try inner.all() }
  func put(_ item: SyncedItem) throws { note("put"); try inner.put(item) }
  func delete(account: String) throws { note("delete"); try inner.delete(account: account) }
}

/// The last review round: moved credentials in quarantine, the launch triggers, a resumed
/// "delete everything" and an unverifiable journal.
@Suite(.timeLimit(.minutes(5))) struct SyncEngineLastRoundTests {
  // MARK: 1. Credentials of an origin the gateway left

  /// Dead after the address commit, before the old origin's credentials were deleted: the
  /// loaders hand out nothing of the old origin; the person then signs in for the new address,
  /// and the clean-up does not take the new token.
  @Test func aMoveCutShortLendsNothingAndASignInAfterItKeepsItsToken() async throws {
    var (world, ids) = try await sharedWorld()
    let pkce = TokenSet(accessToken: "access-old", refreshToken: "refresh-old", expiresAt: 1, provider: "p", userID: "u")
    try SecretTokenStore(storage: SecretStorageAdapter(store: world[0].secrets), keys: try GatewaySecretKeys(gatewayID: ids[0]))
      .save(pkce)

    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.addressCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.changeAddress(of: ids[0], to: movedAddress) }
    world[0].restart()
    await world[0].engine.prepare()

    // The old origin's items are still in the keychain, and no loader hands them out.
    #expect(world[0].token(ids[0]) == "tok-1")
    #expect(try world[0].engine.tokenStore(of: ids[0]).load() == nil)
    #expect(throws: SyncEngineError.credentialsQuarantined) {
      try world[0].engine.tokenStore(of: ids[0]).save(pkce)
    }

    // The person signs in for the new address: the move is finished first, then the token stored.
    try await world[0].engine.storeCredential(.sessionToken("tok-moved"), of: ids[0])
    let fresh = TokenSet(accessToken: "access-new", refreshToken: "refresh-new", expiresAt: 2, provider: "p", userID: "u")
    try await world[0].engine.storeTokens(fresh, of: ids[0])
    await world.settle()

    #expect(try await world[0].only().address == movedAddress)
    #expect(world[0].token(ids[0]) == "tok-moved")
    #expect(try world[0].engine.tokenStore(of: ids[0]).load()?.accessToken == "access-new")
    #expect(world[0].frontDoor(ids[0]) == nil)
    let loaded = try await world[0].engine.storedCredentials(of: ids[0])
    #expect(loaded.sessionToken == "tok-moved")
    #expect(loaded.customHeaders.isEmpty)
    #expect(try await world[0].kv(SyncMaterializer.credentialOriginKey(ids[0])) == GatewayAddress.origin(of: movedAddress))
  }

  @Test func storedCredentialsOfAGatewayInQuarantineAreEmptyUntilTheMoveIsFinished() async throws {
    var (world, ids) = try await sharedWorld()
    // The keychain refuses deletions: the move cannot be finished yet.
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.addressCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.changeAddress(of: ids[0], to: movedAddress) }
    world[0].restart()
    world[0].secrets.fail(.delete, with: .interactionNotAllowed, sticky: true)

    let loaded = try await world[0].engine.storedCredentials(of: ids[0])
    #expect(loaded.sessionToken == nil)
    #expect(loaded.extraHeaders.isEmpty)
    #expect(loaded.frontDoor == .none)
    #expect(world[0].token(ids[0]) == "tok-1")

    world[0].secrets.heal()
    _ = try await world[0].engine.storedCredentials(of: ids[0])
    #expect(world[0].token(ids[0]) == nil)
  }

  // MARK: 2. The launch triggers

  @MainActor
  @Test func theLaunchReconcilesButNeverTouchesICloudBeforeTheDisclosure() async throws {
    let store = CountingStore()
    let launch = AppLaunch(
      environment: LaunchEnvironment(
        dataDirectory: nil, authenticator: ScriptedAuthenticator(), secrets: InMemorySecretStore(), synced: store))

    await launch.start()
    await launch.sync.waitUntilIdle()
    #expect(store.count("availability") > 0)
    #expect(store.count("all") == 0)
    #expect(store.count("put") + store.count("delete") == 0)

    await launch.becameActive()
    await launch.sync.waitUntilIdle()
    #expect(store.count("all") == 0)
  }

  @MainActor
  @Test func theLaunchWithSyncOffOnlyCleansUpLocally() async throws {
    let store = CountingStore()
    let launch = AppLaunch(
      environment: LaunchEnvironment(
        dataDirectory: nil, authenticator: ScriptedAuthenticator(), secrets: InMemorySecretStore(), synced: store))
    try await launch.sync.disclose()
    try await launch.sync.setSyncEnabled(false)
    await launch.sync.waitUntilIdle()
    let before = (store.count("availability"), store.count("all"))

    await launch.start()
    await launch.sync.waitUntilIdle()
    #expect(store.count("availability") == before.0)
    #expect(store.count("all") == before.1)
    #expect(store.count("put") + store.count("delete") == 0)
  }

  @MainActor
  @Test func theLaunchDoesNotSyncOnAGatewayListItCannotRead() async throws {
    let store = CountingStore()
    let launch = AppLaunch(
      environment: LaunchEnvironment(
        dataDirectory: nil, authenticator: ScriptedAuthenticator(), secrets: InMemorySecretStore(), synced: store))
    try await launch.keyValues.setString("not a list", forKey: StoreKeys.gateways)

    await launch.start()
    await launch.sync.waitUntilIdle()
    #expect(launch.gateways.loadFailed)
    #expect(launch.sync.status.lastOutcome == nil)
    #expect(store.count("availability") == 0)

    await launch.becameActive()
    await launch.sync.waitUntilIdle()
    #expect(launch.sync.status.lastOutcome == nil)
  }

  // MARK: 3. A resumed "delete everything" deletes only what was there

  @Test(arguments: conflictPolicies)
  func aResumedDeleteEverythingLeavesWhatWasWrittenSince(conflict: FakeCloud.Conflict) async throws {
    let (world, ids) = try await sharedWorld(conflict: conflict)
    try await addGateway(world[0], address: otherAddress, name: "Office", token: "tok-office")
    await world.settle()

    world.cloud.failNext(.delete, on: "device0", with: .keychain(operation: .delete, status: -34_018))
    await #expect(throws: SyncEngineError.self) { try await world[0].engine.deleteEverythingFromICloud() }
    #expect(world.cloud.cloudItems().count == 2)

    // Device 1 writes the home gateway again after the request.
    world.advance(1_000)
    try await GatewayRegistryStore(store: world[1].database).rename(id: ids[1], to: "Written since")
    await world[1].reconcile()
    world.cloud.deliverAll()

    await world[0].reconcile()
    world.cloud.deliverAll()
    let left = world.cloud.cloudItems().map(\.account)
    #expect(left == [SyncedGatewayRecord.account(forKey: homeKey)])
    #expect(try await world[0].kv(SyncJournal.storageKey) == nil)
  }

  // MARK: Optional 5. A journal that cannot be checked says so

  @Test func aPendingDeletionThatCannotBeCheckedIsLeftAndNoted() async throws {
    var (world, ids) = try await sharedWorld()
    await world[0].engine.setIntentProbe(crash(after: SyncIntentStep.signOutCommitted))
    await #expect(throws: Crash.self) { try await world[0].engine.signOut(id: ids[0], scope: .thisDevice) }

    try world[0].secrets.delete(SyncPrintKey.storageKey)
    world[0].restart()
    await world[0].reconcile()

    #expect(world[0].token(ids[0]) == "tok-1")
    #expect(await world[0].status.developerNotes.contains("journalUnverifiable"))
  }
}
