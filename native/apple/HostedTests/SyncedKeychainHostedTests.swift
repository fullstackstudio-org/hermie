import Foundation
import HermieStore
import Security
import Testing

/// `ICloudKeychainStore` against the real keychain, hosted in the Hermie app so
/// the process carries the app's keychain access group. Run with
/// `native/apple/scripts/test.sh --keychain`, on a throwaway iOS Simulator. A
/// simulator stores synchronizable items but is not signed in to iCloud, so
/// nothing written here travels anywhere.
///
/// Safety: the target is built for the iOS Simulator only. Every store here
/// comes from `store(...)`, which refuses any service but a random
/// `hermie.test.` one, or the device-only service for the isolation proofs;
/// never the production service (`ICloudKeychainStoreUnsignedTests` in
/// `swift test` checks this file's source for that). Every account is
/// `hermie.test.<random>.…`, checked before use, and every test deletes what
/// it wrote.
@Suite(.serialized) struct SyncedKeychainHostedTests {
  let deviceOnly = KeychainStore()

  /// The one place a real synced store is built. `service` nil gives a fresh
  /// `hermie.test.<random>` service.
  static func store(service: String? = nil, accessGroup: String? = nil) -> some SyncedItemStore {
    let service = service ?? String(SecretStoreContract.runPrefix().dropLast())
    precondition(
      (service.hasPrefix(SecretStoreContract.testPrefix) && service.count > SecretStoreContract.testPrefix.count + 8)
        || service == deviceOnlyService,
      "hosted synced-store tests use a throwaway service"
    )
    return ICloudKeychainStore(service: service, accessGroup: accessGroup)
  }

  /// `KeychainStore`'s service, spelled out: `KeychainStore.service` is
  /// internal to the package.
  static let deviceOnlyService = "app:no-auth"

  // MARK: - The SyncedItemStore contract

  @Test func roundTrip() throws {
    try SyncedItemStoreContract.checkRoundTrip(Self.store())
  }

  @Test func values() throws {
    try SyncedItemStoreContract.checkValues(Self.store())
  }

  @Test func independentAccounts() throws {
    try SyncedItemStoreContract.checkIndependentAccounts(Self.store())
  }

  @Test func invalidAccounts() {
    SyncedItemStoreContract.checkInvalidAccounts(Self.store())
  }

  @Test func theStoreIsAvailableInTheSignedApp() {
    #expect(Self.store().availability() == .available)
  }

  // MARK: - The item's attributes

  /// What actually landed in the keychain: synchronizable, after first
  /// unlock, account and generic as data, in the app's keychain group.
  @Test func aStoredItemIsSynchronizableAndAfterFirstUnlock() throws {
    let service = String(SecretStoreContract.runPrefix().dropLast())
    let store = Self.store(service: service)
    let account = SecretStoreContract.testKey("gw")
    SecretStoreContract.requireTestKey(account)
    defer { try? store.delete(account: account) }

    try store.put(SyncedItem(account: account, value: "record"))
    let attributes = try #require(try Self.syncedAttributes(service: service, account: account))

    #expect(attributes[kSecAttrService as String] as? String == service)
    #expect(attributes[kSecAttrAccount as String] as? Data == Data(account.utf8))
    #expect(attributes[kSecAttrGeneric as String] as? Data == Data(account.utf8))
    #expect(attributes[kSecAttrSynchronizable as String] as? Bool == true)
    #expect(
      attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
    let group = try #require(attributes[kSecAttrAccessGroup as String] as? String)
    #expect(group.hasSuffix("dev.hermie.app"), "landed in \(group)")

    // Replacing the value keeps every attribute.
    try store.put(SyncedItem(account: account, value: "record 2"))
    let updated = try #require(try Self.syncedAttributes(service: service, account: account))
    #expect(updated[kSecAttrSynchronizable as String] as? Bool == true)
    #expect(updated[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
    #expect(try store.all().map(\.value) == ["record 2"])
  }

  /// An item some other writer left with another accessibility gets the
  /// synced set's on the next put, and is not duplicated.
  @Test func aPutRestoresTheShapeOfAnExistingItem() throws {
    let service = String(SecretStoreContract.runPrefix().dropLast())
    let store = Self.store(service: service)
    let account = SecretStoreContract.testKey("gw")
    SecretStoreContract.requireTestKey(account)
    defer { try? store.delete(account: account) }

    let foreign: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(account.utf8),
      kSecAttrSynchronizable as String: true,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
      kSecValueData as String: Data("old".utf8)
    ]
    #expect(SecItemAdd(foreign as CFDictionary, nil) == errSecSuccess)

    try store.put(SyncedItem(account: account, value: "new"))
    let attributes = try #require(try Self.syncedAttributes(service: service, account: account))
    #expect(
      attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
    #expect(attributes[kSecAttrGeneric as String] as? Data == Data(account.utf8))
    #expect(try store.all() == [SyncedItem(account: account, value: "new")])
  }

  // MARK: - The two sets never meet

  /// A synced item under its own service: the device-only store neither reads
  /// it, deletes it, nor removes it with `removeAll(prefix:)`.
  @Test func theDeviceOnlyStoreNeverReachesASyncedItem() throws {
    try checkDeviceOnlyStoreNeverReaches(syncedService: nil)
  }

  /// This store lists nothing the device-only store wrote, and its deletes
  /// leave it alone.
  @Test func theSyncedStoreNeverReachesADeviceOnlyItem() throws {
    try checkSyncedStoreNeverReaches(syncedService: nil)
  }

  #if targetEnvironment(simulator)
    /// The same two proofs with the synced store on the device-only service
    /// itself, so only the synchronizable flag keeps the sets apart: the
    /// separation does not rest on the service names alone. Throwaway
    /// simulator only; accounts are this run's random `hermie.test.` ones.
    @Test func theFlagAloneKeepsTheSetsApart() throws {
      try checkDeviceOnlyStoreNeverReaches(syncedService: Self.deviceOnlyService)
      try checkSyncedStoreNeverReaches(syncedService: Self.deviceOnlyService)
    }

    /// One account in both sets at once, on one service: two items, each
    /// store sees only its own, and deleting one leaves the other.
    @Test func oneAccountInBothSetsIsTwoItems() throws {
      let synced = Self.store(service: Self.deviceOnlyService)
      let account = SecretStoreContract.testKey("both")
      SecretStoreContract.requireTestKey(account)
      defer {
        try? synced.delete(account: account)
        try? deviceOnly.delete(account)
      }

      try deviceOnly.set(account, "device-only")
      try synced.put(SyncedItem(account: account, value: "synced"))
      #expect(try deviceOnly.get(account) == "device-only")
      #expect(try synced.all().filter { $0.account == account }.map(\.value) == ["synced"])

      try deviceOnly.delete(account)
      #expect(try deviceOnly.get(account) == nil)
      #expect(try synced.all().filter { $0.account == account }.map(\.value) == ["synced"])

      try deviceOnly.set(account, "device-only")
      try synced.delete(account: account)
      #expect(try synced.all().filter { $0.account == account }.isEmpty)
      #expect(try deviceOnly.get(account) == "device-only")
    }
  #endif

  private func checkDeviceOnlyStoreNeverReaches(syncedService: String?) throws {
    let synced = Self.store(service: syncedService)
    let run = SecretStoreContract.runPrefix()
    let account = run + "synced"
    SecretStoreContract.requireTestKey(account)
    defer { try? synced.delete(account: account) }

    try synced.put(SyncedItem(account: account, value: "synced"))

    #expect(try deviceOnly.get(account) == nil)
    try deviceOnly.delete(account)
    #if os(iOS) && targetEnvironment(simulator)
      // Lists Hermie's services: throwaway simulator only, and the prefix is
      // this run's random namespace.
      #expect(try deviceOnly.removeAll(prefix: run) == 0)
    #endif
    #expect(try synced.all().filter { $0.account == account }.map(\.value) == ["synced"])
  }

  private func checkSyncedStoreNeverReaches(syncedService: String?) throws {
    let synced = Self.store(service: syncedService)
    let account = SecretStoreContract.testKey("device_only")
    SecretStoreContract.requireTestKey(account)
    defer { try? deviceOnly.delete(account) }

    try deviceOnly.set(account, "device-only")

    #expect(try synced.all().filter { $0.account.hasPrefix(SecretStoreContract.testPrefix) }.isEmpty)
    try synced.delete(account: account)
    try synced.put(SyncedItem(account: account, value: "synced"))
    try synced.delete(account: account)
    #expect(try deviceOnly.get(account) == "device-only")
  }

  // MARK: - Unavailable

  /// A keychain group the app does not declare: the keychain refuses with
  /// `errSecMissingEntitlement`, which the store reports as unavailable, and no
  /// call throws.
  @Test func anUndeclaredGroupIsUnavailableAndNothingThrows() throws {
    let store = Self.store(accessGroup: "ZZZZZZZZZZ.dev.hermie.not-declared")
    let account = SecretStoreContract.testKey("gw")
    SecretStoreContract.requireTestKey(account)
    defer { try? store.delete(account: account) }

    #expect(store.availability() == .unavailable)
    #expect(try store.all() == [])
    try store.put(SyncedItem(account: account, value: "v"))
    try store.delete(account: account)
  }

  // MARK: - Helpers

  /// The attributes of this run's synced item, read with an explicit
  /// synchronizable query on its own service.
  private static func syncedAttributes(service: String, account: String) throws -> [String: Any]? {
    SecretStoreContract.requireTestKey(account)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(account.utf8),
      kSecAttrSynchronizable as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnAttributes as String: true
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    try #require(status == errSecSuccess, "status \(status)")
    return result as? [String: Any]
  }
}
