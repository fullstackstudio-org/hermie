import Foundation
import Security
import Testing

@testable import HermieStore

/// What `KeychainStore` can be checked for without a keychain: the attributes
/// it asks for, and that the sources it must stay compatible with still say
/// what it was built against. The real keychain runs in the app-hosted tests in
/// `native/apple/HostedTests` (see `native/apple/scripts/test.sh --keychain`).
@Suite struct KeychainStoreQueryTests {
  @Test func itemQueryIsTheExpoSecureStoreShape() throws {
    let query = KeychainStore().itemQuery("hermie.test.shape", service: "app:no-auth")
    let key = Data("hermie.test.shape".utf8)

    #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
    #expect(query[kSecAttrService as String] as? String == "app:no-auth")
    #expect(query[kSecAttrAccount as String] as? Data == key)
    #expect(query[kSecAttrGeneric as String] as? Data == key)
    // No group named: writes land in the first declared group, reads search all.
    #expect(query[kSecAttrAccessGroup as String] == nil)
    #expect(query[kSecAttrSynchronizable as String] == nil)
    #if os(macOS)
      #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
      #expect(query.count == 5)
    #else
      #expect(query.count == 4)
    #endif
  }

  @Test func anInjectedGroupIsNamedOnEveryQuery() {
    let store = KeychainStore(accessGroup: "group.example.test")
    for service in KeychainStore.allServices {
      #expect(store.itemQuery("hermie.test.x", service: service)[kSecAttrAccessGroup as String] as? String
        == "group.example.test")
      #expect(store.baseQuery(service: service)[kSecAttrAccessGroup as String] as? String == "group.example.test")
    }
  }

  @Test func servicesAreExpoSecureStoreServices() {
    #expect(KeychainStore.service == "app:no-auth")
    #expect(KeychainStore.allServices == ["app", "app:auth", "app:no-auth"])
  }

  /// Only data accounts are ours: a string account was written by something
  /// else, and a delete by key could not reach it anyway.
  @Test func onlyDataAccountsAreKeys() {
    #expect(KeychainStore.key(ofDataAccount: Data("hermie.a".utf8)) == "hermie.a")
    #expect(KeychainStore.key(ofDataAccount: "hermie.b") == nil)
    #expect(KeychainStore.key(ofDataAccount: 42) == nil)
    #expect(KeychainStore.key(ofDataAccount: nil) == nil)
  }

  @Test func statusesMapToTypedErrors() {
    #expect(KeychainStore.error(errSecMissingEntitlement, .read) == .missingEntitlement)
    #expect(KeychainStore.error(errSecInteractionNotAllowed, .read) == .interactionNotAllowed)
    #expect(KeychainStore.error(errSecAuthFailed, .add) == .keychain(operation: .add, status: errSecAuthFailed))
  }

  /// A failure under a legacy service must not keep the real `app:no-auth`
  /// item, tried last, alive: every service is tried, then the first failure
  /// is thrown.
  @Test func deleteTriesEveryServiceEvenAfterAFailure() {
    let store = KeychainStore()
    let queries = KeychainStore.allServices.map { store.itemQuery("hermie.test.delete", service: $0) }
    var tried: [String] = []

    #expect(throws: SecretStoreError.keychain(operation: .delete, status: errSecAuthFailed)) {
      _ = try KeychainStore.deleteEach(queries) { query in
        let service = query[kSecAttrService as String] as? String ?? ""
        tried.append(service)
        switch service {
        case "app": return errSecAuthFailed
        case "app:auth": return errSecIO
        default: return errSecSuccess
        }
      }
    }
    #expect(tried == ["app", "app:auth", "app:no-auth"])
  }

  @Test func deleteReportsWhetherAnythingWasRemoved() throws {
    let queries = KeychainStore.allServices.map { KeychainStore().itemQuery("hermie.test.x", service: $0) }
    #expect(try KeychainStore.deleteEach(queries) { _ in errSecItemNotFound } == false)
    #expect(
      try KeychainStore.deleteEach(queries) { query in
        query[kSecAttrService as String] as? String == "app:no-auth" ? errSecSuccess : errSecItemNotFound
      } == true)
  }

  @Test func invalidKeysNeverReachTheKeychain() {
    SecretStoreContract.checkInvalidKeys(KeychainStore())
  }

  @Test(arguments: ["", "hermie.", "hermie.s", "other.", "hermie.a b."])
  func removeAllRefusesPrefixesOutsideHermieBeforeTheKeychain(prefix: String) {
    #expect(throws: SecretStoreError.invalidPrefix) { try KeychainStore().removeAll(prefix: prefix) }
  }

  #if os(macOS)
    /// `swift test` has no keychain group, so this only checks that a read of a
    /// random `hermie.test.` key (nothing real can match it) comes back empty or
    /// as a typed error, never as a value. On macOS 27 the data protection
    /// keychain answers "not found"; other releases, or a CI runner without a
    /// user keychain, may answer "missing entitlement" or "not available", so
    /// every typed error is accepted. Reads only: nothing is written from an
    /// unsigned process on a Mac that may hold live credentials.
    @Test func anUnsignedReadFindsNothing() {
      let key = SecretStoreContract.testKey()
      SecretStoreContract.requireTestKey(key)
      do {
        #expect(try KeychainStore().get(key) == nil)
      } catch {
        #expect(error is SecretStoreError)
        #expect(error as? SecretStoreError != .undecodableValue)
      }
    }
  #endif
}

/// The facts `KeychainStore` was built from, read out of the sources that own
/// them, so a change on the Expo side fails here instead of signing people out.
@Suite struct KeychainCompatibilitySourceTests {
  static let repo = URL(filePath: #filePath)
    .deletingLastPathComponent()  // HermieStoreTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // HermieKit
    .deletingLastPathComponent()  // apple
    .deletingLastPathComponent()  // native
    .deletingLastPathComponent()

  static func source(_ path: String) throws -> String {
    try String(contentsOf: repo.appending(path: path), encoding: .utf8)
  }

  static let expoSecureStore = "node_modules/expo-secure-store/ios/SecureStoreModule.swift"

  /// The options the Expo build passes: accessibility only. No service, no
  /// group, no biometric flag, which is what makes the service `app:no-auth` and
  /// leaves the group to the entitlements.
  @Test func expoBuildPassesOnlyAccessibility() throws {
    let seam = try Self.source("expo/hermie/src/platform/secret-store.ts")
    #expect(seam.contains("keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY"))
    #expect(!seam.contains("keychainService"))
    #expect(!seam.contains("accessGroup"))
    #expect(!seam.contains("requireAuthentication"))
  }

  /// The share extension's reader, unchanged: account as data, the three
  /// services in order, generic password, no group. The hosted test replicates
  /// this query; this keeps the replica honest.
  @Test func shareExtensionReaderQuery() throws {
    let reader = try Self.source("expo/hermie/modules/hermie-share/share/HermieShareCredentials.swift")
    for line in [
      #"private static let account = "hermie.share.delivery""#,
      #"private static let services = ["app:no-auth", "app:auth", "app"]"#,
      "let encodedAccount = Data(account.utf8)",
      "kSecClass as String: kSecClassGenericPassword,",
      "kSecAttrService as String: service,",
      "kSecAttrAccount as String: encodedAccount,",
      "kSecMatchLimit as String: kSecMatchLimitOne",
      "query[kSecReturnData as String] = kCFBooleanTrue"
    ] {
      #expect(reader.contains(line), "HermieShareCredentials.swift no longer contains: \(line)")
    }
    #expect(!reader.contains("kSecAttrAccessGroup"))
    #expect(!reader.contains("kSecAttrGeneric"))
  }

  @Test func keyNamesMatchTheExpoBuild() throws {
    let config = try Self.source("expo/hermie/src/gateway/config.ts")
    let gateway = try SecretKeys.gateway("g00")
    for (slot, key) in [
      ("accessToken", gateway.accessToken), ("refreshToken", gateway.refreshToken),
      ("tokenMeta", gateway.tokenMeta), ("sessionToken", gateway.sessionToken),
      ("extraHeaders", gateway.extraHeaders), ("frontDoor", gateway.frontDoor)
    ] {
      let base = String(key.dropLast("-g00".count))
      #expect(config.contains("\(slot): '\(base)'"), "config.ts SECRET_KEYS.\(slot)")
    }
    #expect(try Self.source("expo/hermie/src/gateway/namespace.ts").contains("SECRET_NAMESPACE_SEPARATOR = '-'"))
    #expect(
      try Self.source("expo/hermie/src/features/share/delivery-credential.ts")
        .contains("SHARE_DELIVERY_KEY = '\(SecretKeys.shareDelivery)'"))
  }

  /// Every entitlements file under `native/`, found rather than listed, so a
  /// new extension cannot be added without passing here, plus the Expo share
  /// extension, whose reader must keep finding what the native app writes.
  static func entitlementsFiles() -> [URL] {
    let skipped: Set<String> = [".build", ".swiftpm", "DerivedData"]
    var found: [URL] = []
    let walker = FileManager.default.enumerator(at: repo.appending(path: "native"), includingPropertiesForKeys: nil)
    while let url = walker?.nextObject() as? URL {
      if skipped.contains(url.lastPathComponent) || url.pathExtension == "xcodeproj" {
        walker?.skipDescendants()
      } else if url.pathExtension == "entitlements" {
        found.append(url)
      }
    }
    return found.sorted { $0.path < $1.path }
      + [repo.appending(path: "expo/hermie/modules/hermie-share/share/HermieShareExtension.entitlements")]
  }

  /// `accessGroup: nil` relies on the shared group being FIRST in every
  /// binary's entitlements, the group the Expo app names first. A binary that
  /// declares no keychain group cannot reach the credentials at all.
  @Test func sharedGroupIsFirstInEveryEntitlementsFile() throws {
    let files = Self.entitlementsFiles()
    var withGroups = 0

    for file in files {
      let data = try Data(contentsOf: file)
      let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
      guard let groups = plist?["keychain-access-groups"] as? [String] else { continue }
      withGroups += 1
      #expect(groups.first == "$(AppIdentifierPrefix)dev.hermie.app", "\(file.path)")
    }

    // The two apps and the Expo share extension, at least.
    #expect(withGroups >= 3)
  }

  /// The library's own query builder, when `npm ci` has installed it.
  @Test(.enabled(if: FileManager.default.fileExists(atPath: repo.appending(path: expoSecureStore).path)))
  func expoSecureStoreQuery() throws {
    let module = try Self.source(Self.expoSecureStore)
    for line in [
      #"var service = options.keychainService ?? "app""#,
      #"service.append(":\(requireAuthentication ? "auth" : "no-auth")")"#,
      "let encodedKey = Data(key.utf8)",
      "kSecClass as String: kSecClassGenericPassword,",
      "kSecAttrGeneric as String: encodedKey,",
      "kSecAttrAccount as String: encodedKey",
      "if let accessGroup = options.accessGroup {",
      "setItemQuery[kSecAttrAccessible as String] = accessibility",
      "case errSecDuplicateItem:",
      "let updateDictionary = [kSecValueData as String: valueData]"
    ] {
      #expect(module.contains(line), "SecureStoreModule.swift no longer contains: \(line)")
    }
  }
}
