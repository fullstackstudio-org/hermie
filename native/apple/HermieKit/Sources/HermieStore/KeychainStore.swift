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
/// of the existing `app:no-auth` item, leaving its other attributes alone.
/// `delete` removes the key under all three services and succeeds when there
/// was nothing to delete. `get` reads `app:no-auth`, then the legacy `app`.
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
/// "Designed for iPad" binary, and never the file-based login keychain. A
/// process without a keychain entitlement gets `missingEntitlement` instead of
/// a fallback.
///
/// ## Keys
///
/// Every key must satisfy `SecretKeys.isValidKey(_:)` (`^[\w.-]+$`, ASCII), the
/// rule `expo-secure-store` enforces in JavaScript before its native code runs;
/// anything else throws `invalidKey` before the keychain is touched.
public struct KeychainStore: SecretStore {
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

    var addQuery = itemQuery(key, service: Self.service)
    addQuery[kSecValueData as String] = Data(value.utf8)
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
      let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
      let updateStatus = SecItemUpdate(
        itemQuery(key, service: Self.service) as CFDictionary,
        attributes as CFDictionary
      )
      guard updateStatus == errSecSuccess else { throw Self.error(updateStatus, .update) }
    default:
      throw Self.error(status, .add)
    }
  }

  public func delete(_ key: String) throws {
    try Self.validate(key)

    for service in Self.allServices {
      let status = SecItemDelete(itemQuery(key, service: service) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw Self.error(status, .delete)
      }
    }
  }

  /// Deletes every item whose key starts with `prefix`, under all three
  /// services, and returns how many keys it deleted.
  ///
  /// The prefix must start with `hermie.` and name something inside it
  /// (`hermie.auth.`, say), so this can only ever touch Hermie's own items. The
  /// keychain cannot match an account by prefix, so this lists the attributes
  /// (never the data) of the items under Hermie's services, keeps the accounts
  /// for which `SecretKeys.key(_:matchesOwnedPrefix:)` holds, and deletes each
  /// by its exact key through `delete(_:)`.
  ///
  /// Gateway ids are a key's SUFFIX, so this does not remove one gateway:
  /// delete `SecretKeys.gateway(id).all` for that.
  @discardableResult
  public func removeAll(prefix: String) throws -> Int {
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
          if let key = Self.key(ofAccount: attributes[kSecAttrAccount as String]),
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

    for key in matching.sorted() {
      try delete(key)
    }

    return matching.count
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

  /// An account read back from the keychain: data when `expo-secure-store` or
  /// this store wrote it, a string when something else did.
  static func key(ofAccount account: Any?) -> String? {
    switch account {
    case let data as Data: String(data: data, encoding: .utf8)
    case let string as String: string
    default: nil
    }
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
