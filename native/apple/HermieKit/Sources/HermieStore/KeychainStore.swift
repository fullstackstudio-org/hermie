import Foundation
import Security

/// Hermie's credentials in the Keychain, in the item shape `expo-secure-store`
/// writes (decision D12 of the native rewrite plan).
///
/// The native app and the Expo build read and write the SAME items: there is no
/// credential migration and no second copy of a token, the Expo share
/// extension's reader (`HermieShareCredentials.swift`) keeps finding the
/// delivery record, and a rollback to an Expo build stays signed in.
///
/// ## The item shape
///
/// Taken from `expo-secure-store` 15 (`ios/SecureStoreModule.swift`,
/// `query(with:options:requireAuthentication:)`, `set`, `update`) with the options
/// Hermie passes (`expo/hermie/src/platform/secret-store.ts`: only
/// `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`):
///
/// - class: generic password;
/// - service: `app:no-auth` (`keychainService` is not passed, so `app`, and
///   `requireAuthentication` is false, so `:no-auth`);
/// - account AND generic attribute: the key's UTF-8 bytes, as data, not a string
///   (a query that spells the account as a string matches nothing);
/// - value data: the value's UTF-8 bytes;
/// - accessibility on add: after first unlock, this device only (Hermie
///   reconnects from the background; credentials never sync or migrate);
/// - access group: none named (see below);
/// - not synchronizable (the default).
///
/// ## Add or update, delete, read
///
/// The same as `expo-secure-store`, so an item the Expo build wrote is updated in
/// place and never duplicated: `set` adds; on success it deletes any copy under
/// the legacy `app` service and the biometric `app:auth` service (so a stale
/// copy cannot win a later read); on `errSecDuplicateItem` it updates the value
/// of the existing `app:no-auth` item, leaving its other attributes alone
/// (accessibility included). If that item vanished between the two calls, the
/// add is tried once more. `delete` removes the key under all three services,
/// always trying every one of them, and succeeds when there was nothing to
/// delete. `get` reads `app:no-auth`, then the legacy `app`.
///
/// One deliberate difference: `get` does not read `app:auth`. Hermie has never
/// written one (it never passes `requireAuthentication`), and reading one would
/// put a biometric prompt in front of a background reconnect.
///
/// ## The access group
///
/// `accessGroup` is nil in the apps, and then no query names a group, exactly
/// as `expo-secure-store` does when no `accessGroup` option is passed: a write
/// lands in the binary's FIRST `keychain-access-groups` entry and a read
/// searches every group the binary declares. Every Hermie binary declares
/// `$(AppIdentifierPrefix)dev.hermie.app` first, so the group is resolved by the
/// system from the signed entitlements at runtime and the team prefix is never
/// spelled in code. Pass a group only for a binary whose first group is a
/// different one; it is then named on every query, reads included.
///
/// ## macOS
///
/// Every query carries `kSecUseDataProtectionKeychain`, so the Mac app uses the
/// same iOS-style keychain as the iPad app on a Mac and the Expo build's
/// "Designed for iPad" binary, and never the file-based login keychain.
///
/// A process without a keychain access group is not necessarily refused: on
/// macOS 27 its read answers "not found" (`nil`), and only some releases answer
/// `missingEntitlement`. So a `nil` from `get` means "no credential readable
/// here", never "the user has no credential": it must never be taken as
/// permission to clean up other state (drop a gateway, clear a share record,
/// unregister push).
///
/// ## Keys
///
/// Every key must satisfy `SecretKeys.isValidKey(_:)` (`^[\w.-]+$`, ASCII), the
/// rule `expo-secure-store` enforces in JavaScript before its native code runs;
/// anything else throws `invalidKey` before the keychain is touched.
public struct KeychainStore: ListableSecretStore {
  /// The service of every item Hermie writes.
  static let service = "app:no-auth"
  /// Written by `expo-secure-store` versions before the auth suffix; read and
  /// deleted, never written.
  static let legacyService = "app"
  /// `requireAuthentication: true`; deleted, never read or written.
  static let biometricService = "app:auth"
  /// Every service a key is deleted under, in `expo-secure-store`'s delete order.
  static let allServices = [legacyService, biometricService, service]

  /// The access group named on every query, or nil to let the system use the
  /// binary's entitlements (the default; see the type's documentation).
  public let accessGroup: String?

  public init(accessGroup: String? = nil) {
    self.accessGroup = accessGroup
  }

  public func get(_ key: String) throws -> String? {
    try Self.validate(key)

    for service in [Self.service, Self.legacyService] {
      var query = itemQuery(key, service: service)
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      query[kSecReturnData as String] = true

      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)

      switch status {
      case errSecSuccess:
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
          throw SecretStoreError.undecodableValue
        }
        return value
      case errSecItemNotFound:
        continue
      default:
        throw Self.error(status, .read)
      }
    }

    return nil
  }

  public func set(_ key: String, _ value: String) throws {
    try Self.validate(key)
    try set(key, Data(value.utf8), addAttempts: 2)
  }

  /// Add, or update on a duplicate. An update that finds nothing means the item
  /// was deleted between the add and the update (another process, the share
  /// extension's owner signing out), so the add is tried again, once.
  private func set(_ key: String, _ data: Data, addAttempts: Int) throws {
    var addQuery = itemQuery(key, service: Self.service)
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(addQuery as CFDictionary, nil)

    switch status {
    case errSecSuccess:
      // As `expo-secure-store` does after a successful add: drop the copies a
      // read could otherwise find first. Their absence is not an error.
      for service in [Self.legacyService, Self.biometricService] {
        SecItemDelete(itemQuery(key, service: service) as CFDictionary)
      }
    case errSecDuplicateItem:
      let attributes: [String: Any] = [kSecValueData as String: data]
      let updateStatus = SecItemUpdate(
        itemQuery(key, service: Self.service) as CFDictionary,
        attributes as CFDictionary
      )
      if updateStatus == errSecItemNotFound, addAttempts > 1 {
        try set(key, data, addAttempts: addAttempts - 1)
        return
      }
      guard updateStatus == errSecSuccess else { throw Self.error(updateStatus, .update) }
    default:
      throw Self.error(status, .add)
    }
  }

  public func delete(_ key: String) throws {
    try Self.validate(key)
    _ = try deleteReportingRemoval(key)
  }

  /// Deletes the key under every service and says whether anything was there.
  ///
  /// Every service is tried even when one fails, so an odd leftover under a
  /// legacy service can never keep the real `app:no-auth` item (tried last, in
  /// `expo-secure-store`'s order) alive: a sign-out that throws has still
  /// removed everything it could. The first real failure is thrown afterwards.
  private func deleteReportingRemoval(_ key: String) throws -> Bool {
    try Self.deleteEach(Self.allServices.map { itemQuery(key, service: $0) }) { query in
      SecItemDelete(query as CFDictionary)
    }
  }

  /// The loop behind `delete`, with the keychain call passed in so a test can
  /// make one service fail.
  static func deleteEach(
    _ queries: [[String: Any]],
    using secItemDelete: ([String: Any]) -> OSStatus
  ) throws -> Bool {
    var removed = false
    var firstError: SecretStoreError?

    for query in queries {
      let status = secItemDelete(query)
      switch status {
      case errSecSuccess:
        removed = true
      case errSecItemNotFound:
        break
      default:
        if firstError == nil { firstError = Self.error(status, .delete) }
      }
    }

    if let firstError { throw firstError }
    return removed
  }

  /// Deletes every item whose key starts with `prefix`, under all three
  /// services, and returns how many keys it actually removed.
  ///
  /// The prefix must start with `hermie.`, name something inside it and end in
  /// a dot (`hermie.auth.`, say), so this can only ever touch Hermie's own
  /// items, a whole dotted segment at a time. The keychain cannot match an
  /// account by prefix, so this lists the attributes (never the data) of the
  /// items under Hermie's services, keeps the DATA accounts (the only kind
  /// `expo-secure-store` and this store write, and the only kind a delete by key
  /// can reach) for which `SecretKeys.key(_:matchesOwnedPrefix:)` holds, and
  /// deletes each by its exact key.
  ///
  /// Gateway ids are a key's SUFFIX, so this does not remove one gateway:
  /// delete `SecretKeys.gateway(id).all` for that.
  @discardableResult
  public func removeAll(prefix: String) throws -> Int {
    var removed = 0
    for key in try keys(prefix: prefix) {
      if try deleteReportingRemoval(key) { removed += 1 }
    }

    return removed
  }

  /// Every key under Hermie's services that starts with `prefix`, sorted, by the
  /// same rule `removeAll(prefix:)` deletes by. Lists attributes only, never data.
  public func keys(prefix: String) throws -> [String] {
    guard SecretKeys.isValidOwnedPrefix(prefix) else { throw SecretStoreError.invalidPrefix }

    var matching = Set<String>()

    for service in Self.allServices {
      var query = baseQuery(service: service)
      query[kSecMatchLimit as String] = kSecMatchLimitAll
      query[kSecReturnAttributes as String] = true

      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)

      switch status {
      case errSecSuccess:
        for attributes in (result as? [[String: Any]]) ?? [] {
          if let key = Self.key(ofDataAccount: attributes[kSecAttrAccount as String]),
            SecretKeys.key(key, matchesOwnedPrefix: prefix) {
            matching.insert(key)
          }
        }
      case errSecItemNotFound:
        continue
      default:
        throw Self.error(status, .list)
      }
    }

    return matching.sorted()
  }

  // MARK: - Queries

  /// The attributes that identify one item, as `expo-secure-store` spells them.
  func itemQuery(_ key: String, service: String) -> [String: Any] {
    let encodedKey = Data(key.utf8)
    var query = baseQuery(service: service)
    query[kSecAttrGeneric as String] = encodedKey
    query[kSecAttrAccount as String] = encodedKey
    return query
  }

  /// Class, service, the access group when one is named, and on macOS the
  /// data protection keychain.
  func baseQuery(service: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service
    ]
    if let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    #if os(macOS)
      query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }

  /// The key behind an account read back from the keychain, when the account
  /// is data, as `expo-secure-store` and this store write it. A string account
  /// was written by something else and is never ours to delete.
  static func key(ofDataAccount account: Any?) -> String? {
    guard let data = account as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private static func validate(_ key: String) throws {
    guard SecretKeys.isValidKey(key) else { throw SecretStoreError.invalidKey }
  }

  static func error(_ status: OSStatus, _ operation: KeychainOperation) -> SecretStoreError {
    switch status {
    case errSecMissingEntitlement: .missingEntitlement
    case errSecInteractionNotAllowed: .interactionNotAllowed
    default: .keychain(operation: operation, status: status)
    }
  }
}
