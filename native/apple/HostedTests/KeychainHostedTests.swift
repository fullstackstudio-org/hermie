import Foundation
import HermieStore
import Security
import Testing

/// `KeychainStore` against the real keychain, hosted in the Hermie app so the
/// process carries the app's keychain access group. Run with
/// `native/apple/scripts/test.sh --keychain`, which creates a throwaway iOS
/// Simulator for the run and deletes it afterwards.
///
/// Safety: every key is `hermie.test.<random>.…` (`SecretStoreContract`
/// refuses anything else before a call is made), every test deletes what it
/// wrote, and no query here can match an item without the run's own random
/// account. The only listing query is the one inside `removeAll(prefix:)`,
/// which reads attributes and never data, and its test is compiled for the iOS
/// Simulator only.
@Suite(.serialized) struct KeychainHostedTests {
  let store = KeychainStore()

  // MARK: - The SecretStore contract

  @Test func roundTrip() throws {
    try SecretStoreContract.checkRoundTrip(store)
  }

  @Test func values() throws {
    try SecretStoreContract.checkValues(store)
  }

  @Test func independentKeys() throws {
    try SecretStoreContract.checkIndependentKeys(store)
  }

  @Test func invalidKeys() {
    SecretStoreContract.checkInvalidKeys(store)
  }

  // MARK: - Proof 1: an item the Expo build wrote is read, and updated in place

  /// Written with the query `expo-secure-store` 15.0.8 builds in
  /// `ios/SecureStoreModule.swift` `set(value:with:options:)`, through
  /// `query(with:options:requireAuthentication:)`, for Hermie's options
  /// (`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, no service, no
  /// group, `requireAuthentication` false). Copied, not shared, on purpose.
  private func expoSecureStoreSet(_ key: String, _ value: String) -> OSStatus {
    var service = "app"  // options.keychainService ?? "app"
    service.append(":no-auth")  // requireAuthentication == false
    let encodedKey = Data(key.utf8)
    var setItemQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey
    ]
    // options.accessGroup is nil: no kSecAttrAccessGroup.
    setItemQuery[kSecValueData as String] = value.data(using: .utf8)
    setItemQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(setItemQuery as CFDictionary, nil)
  }

  @Test func anItemWrittenByExpoSecureStoreIsRead() throws {
    let key = SecretStoreContract.testKey("expo_written-g00")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    #expect(expoSecureStoreSet(key, "written-by-expo") == errSecSuccess)
    #expect(try store.get(key) == "written-by-expo")

    // And a native write updates that item instead of adding a second one,
    // changing its value and nothing else.
    try store.set(key, "written-by-native")
    #expect(try store.get(key) == "written-by-native")
    #expect(try itemCount(account: key) == 1)
    let attributes = try #require(try self.attributes(account: key))
    #expect(
      attributes[kSecAttrAccessible as String] as? String
        == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
  }

  /// The sign-out case: the token exists only under `app:no-auth`, the service
  /// `delete` tries last.
  @Test func deleteRemovesAKeyThatExistsOnlyUnderNoAuth() throws {
    let key = SecretStoreContract.testKey("only_no_auth")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    #expect(expoSecureStoreSet(key, "token") == errSecSuccess)
    #expect(try itemCount(account: key) == 1)
    #expect(try self.attributes(account: key) != nil)

    try store.delete(key)
    #expect(try itemCount(account: key) == 0)
    #expect(try store.get(key) == nil)
  }

  /// A successful add drops a copy under `app:auth`, as `expo-secure-store`
  /// does. The copy is made without an access control, so no prompt is needed
  /// to create or delete it.
  @Test func aSuccessfulAddRemovesAnAuthServiceCopy() throws {
    let key = SecretStoreContract.testKey("auth_copy")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    let encodedKey = Data(key.utf8)
    let authCopy: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app:auth",
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey,
      kSecValueData as String: Data("stale".utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    #expect(SecItemAdd(authCopy as CFDictionary, nil) == errSecSuccess)
    #expect(try itemCount(account: key) == 1)

    try store.set(key, "current")
    #expect(try itemCount(account: key) == 1)
    #expect(try self.attributes(account: key) != nil)  // the one left is app:no-auth
    #expect(try store.get(key) == "current")
  }

  @Test func aLegacyServiceItemIsReadThenReplaced() throws {
    let key = SecretStoreContract.testKey("legacy")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    // `query(with:options:)` without `requireAuthentication`: service `app`.
    let encodedKey = Data(key.utf8)
    let legacy: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app",
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey,
      kSecValueData as String: Data("legacy".utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    #expect(SecItemAdd(legacy as CFDictionary, nil) == errSecSuccess)
    #expect(try store.get(key) == "legacy")

    try store.set(key, "current")
    #expect(try store.get(key) == "current")
    #expect(try itemCount(account: key) == 1)

    try store.delete(key)
    #expect(try itemCount(account: key) == 0)
  }

  // MARK: - Proof 2: an item written here is found by the share extension's reader

  /// `HermieShareKeychain.read()` from
  /// `expo/hermie/modules/hermie-share/share/HermieShareCredentials.swift`
  /// (lines 174-196), copied literally. The one change: the account is a
  /// parameter instead of the fixed `hermie.share.delivery`, so this test never
  /// touches the real record. `KeychainCompatibilitySourceTests` in
  /// `swift test` fails if those source lines change.
  private func shareExtensionRead(account: String) -> Data? {
    let encodedAccount = Data(account.utf8)
    let services = ["app:no-auth", "app:auth", "app"]

    for service in services {
      var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: encodedAccount,
        kSecMatchLimit as String: kSecMatchLimitOne
      ]
      query[kSecReturnData as String] = kCFBooleanTrue

      var item: CFTypeRef?

      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
        return data
      }
    }

    return nil
  }

  @Test func anItemWrittenHereIsFoundByTheShareExtensionReader() throws {
    let key = SecretStoreContract.testKey("share_delivery")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    let record = #"{"version":1,"baseUrl":"https://gateway.example","token":"t","authMode":"session_token"}"#
    try store.set(key, record)
    #expect(shareExtensionRead(account: key) == Data(record.utf8))

    try store.delete(key)
    #expect(shareExtensionRead(account: key) == nil)
  }

  // MARK: - The item's attributes

  /// What actually landed in the keychain: the expo-secure-store shape, in the
  /// app's first (and only) keychain access group.
  @Test func theStoredItemHasTheD12Shape() throws {
    let key = SecretStoreContract.testKey("shape")
    SecretStoreContract.requireTestKey(key)
    defer { try? store.delete(key) }

    try store.set(key, "value")
    let attributes = try #require(try self.attributes(account: key))

    #expect(attributes[kSecAttrService as String] as? String == "app:no-auth")
    #expect(attributes[kSecAttrAccount as String] as? Data == Data(key.utf8))
    #expect(attributes[kSecAttrGeneric as String] as? Data == Data(key.utf8))
    #expect(
      attributes[kSecAttrAccessible as String] as? String
        == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    #expect((attributes[kSecAttrSynchronizable as String] as? Bool ?? false) == false)
    let group = try #require(attributes[kSecAttrAccessGroup as String] as? String)
    // The app's own group: `<team>.dev.hermie.app` in a release build, `.dev.hermie.app.dev` in
    // the Debug build these tests host in (HERMIE_BUNDLE_ID).
    let app = Bundle.main.bundleIdentifier ?? "dev.hermie.app"
    // Unprefixed under ad hoc signing with no team (`$(AppIdentifierPrefix)` is empty).
    #expect(group == app || group.hasSuffix("." + app), "landed in \(group)")
  }

  // MARK: - removeAll(prefix:)

  #if os(iOS) && targetEnvironment(simulator)
    /// Lists Hermie's services, so it runs only in the throwaway simulator. Its
    /// prefix is this run's random namespace, and `SecretKeys.key(_:matchesOwnedPrefix:)`
    /// is the only gate to a delete, so nothing outside the run can match.
    @Test func removeAllDeletesOnlyTheRunPrefix() throws {
      let run = SecretStoreContract.runPrefix()
      let neighbour = SecretStoreContract.runPrefix()
      let keys = [run + "a", run + "b-g00", run + "c"]
      let survivors = [neighbour + "a", String(run.dropLast()) + "x"]
      for key in keys + survivors { SecretStoreContract.requireTestKey(key) }
      defer { for key in keys + survivors { try? store.delete(key) } }

      for key in keys + survivors { try store.set(key, "v") }
      // One of the run's keys only under the legacy service.
      let legacyKey = run + "legacy"
      SecretStoreContract.requireTestKey(legacyKey)
      let encodedKey = Data(legacyKey.utf8)
      let legacy: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app",
        kSecAttrGeneric as String: encodedKey, kSecAttrAccount as String: encodedKey,
        kSecValueData as String: Data("v".utf8)
      ]
      #expect(SecItemAdd(legacy as CFDictionary, nil) == errSecSuccess)
      defer { try? store.delete(legacyKey) }

      #expect(try store.removeAll(prefix: run) == keys.count + 1)
      for key in keys + [legacyKey] { #expect(try store.get(key) == nil) }
      for key in survivors { #expect(try store.get(key) == "v") }
    }
  #endif

  // MARK: - Helpers

  /// How many items, across every service and group, have this exact account.
  private func itemCount(account: String) throws -> Int {
    SecretStoreContract.requireTestKey(account)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: Data(account.utf8),
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return 0 }
    try #require(status == errSecSuccess, "status \(status)")
    return (result as? [[String: Any]])?.count ?? 0
  }

  private func attributes(account: String) throws -> [String: Any]? {
    SecretStoreContract.requireTestKey(account)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app:no-auth",
      kSecAttrAccount as String: Data(account.utf8),
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
