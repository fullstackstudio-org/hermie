import Foundation
import Security
import Synchronization

/// The synced set in iCloud Keychain (decision I1 of the iCloud addendum,
/// `.claude/plans/native-rewrite-icloud.md`, "Synced keychain item").
///
/// ## The item shape
///
/// - class: generic password;
/// - service: `hermie.sync.v1` (`productionService`; injectable so the hosted
///   tests can use a throwaway one, and only ever a default);
/// - account AND generic attribute: the account's UTF-8 bytes, as data, as the
///   device-only set spells its keys;
/// - synchronizable: `true`, named on EVERY query (list, read, add, update,
///   delete), never `kSecAttrSynchronizableAny`;
/// - accessibility: after first unlock (not "this device only", which the
///   keychain refuses for a synchronizable item), set on add and on update;
/// - value data: the value's UTF-8 bytes;
/// - access group: none named by default, so a write lands in the binary's
///   first `keychain-access-groups` entry (`$(AppIdentifierPrefix)dev.hermie.app`,
///   the group iOS and macOS builds of one team share), as for the device-only
///   set.
///
/// ## Why the two sets cannot meet
///
/// `KeychainStore` never names `kSecAttrSynchronizable`, and a query without it
/// matches device-only items only; it also only ever names its own three
/// services. This store names `true` and `hermie.sync.v1` on every query. So
/// neither store reads, lists or deletes an item of the other, and
/// `KeychainStore.removeAll(prefix:)` cannot reach a synced item. The hosted
/// tests prove both directions on a simulator, including with the two stores
/// on the same service and the same account.
///
/// ## Matching
///
/// An item is identified by class, service, account, the synchronizable flag,
/// the access group when one is named, and on macOS the data protection
/// keychain: the attributes that make up a generic password's identity. The
/// generic attribute is written but never matched on, so an item that some
/// other writer left without it is still updated or deleted instead of
/// blocking the account.
///
/// ## Access groups
///
/// With `accessGroup` nil (the apps' case) writes land in the binary's first
/// keychain group, but reads, updates and deletes search EVERY group the
/// binary declares, as the keychain does for a query without a group. Both
/// apps declare exactly one group, `$(AppIdentifierPrefix)dev.hermie.app`
/// (`KeychainCompatibilitySourceTests` checks that it comes first), so there
/// is only one place an item can be. A binary that declares several, or adds
/// a second group later, must pass the group writes land in:
/// then every query, `all()` included, names it and nothing else is seen.
/// Without that, an account present in two groups is listed once, from the
/// group first in name order, which need not be the one writes land in.
///
/// ## When the keychain refuses the process
///
/// `errSecMissingEntitlement` from any call means the process has no keychain
/// access group (or not the one named). Then `all()` is empty, and `put` and
/// `delete` do nothing: no call throws for that reason, and the sync switch is
/// disabled by the caller. The refusal is remembered: once any call has seen
/// it, `availability()` answers `unavailable` from then on, whatever a later
/// read says, so a put that was silently dropped cannot sit behind an
/// `available`.
///
/// On macOS the data protection keychain needs a signed binary with an
/// application identifier, and an unsigned process is not always told so (on
/// macOS 27 a read answers "not found"). So on macOS the store first looks at
/// the process's own entitlements, without touching the keychain: with neither
/// `keychain-access-groups` nor `com.apple.application-identifier` it is
/// unavailable and never calls the keychain at all. That is the case of
/// `swift test`, CI and any `CODE_SIGNING_ALLOWED=NO` build, which therefore
/// cannot write a synchronizable item (one written on a Mac signed in to iCloud
/// Keychain would be uploaded to that Apple Account).
///
/// ## Errors
///
/// `SecretStoreError`, whose descriptions name neither an account nor a value.
/// An account that breaks `SyncedItem.isValidAccount(_:)` throws `invalidKey`
/// before the keychain is touched. Nothing here logs.
public struct ICloudKeychainStore: SyncedItemStore {
  /// The service of every synced item in production. A default and nothing
  /// more: every query names `service`, which a test sets to its own.
  public static let productionService = "hermie.sync.v1"

  /// The service named on every query.
  public let service: String

  /// The access group named on every query, or nil to let the system use the
  /// binary's entitlements (the default, as for `KeychainStore`).
  public let accessGroup: String?

  let keychain: any SyncedKeychain
  let isEntitled: @Sendable () -> Bool
  /// Set once any call sees `errSecMissingEntitlement`; shared by copies.
  let refusal = Refusal()

  public init(service: String = Self.productionService, accessGroup: String? = nil) {
    self.init(service: service, accessGroup: accessGroup, keychain: SystemKeychain()) {
      Self.processHasKeychainEntitlement
    }
  }

  /// With the keychain calls and the entitlement check passed in, so the
  /// unit tests can see every query without a keychain.
  init(
    service: String,
    accessGroup: String?,
    keychain: any SyncedKeychain,
    isEntitled: @escaping @Sendable () -> Bool
  ) {
    precondition(!service.isEmpty, "a synced store needs a service")
    self.service = service
    self.accessGroup = accessGroup
    self.keychain = keychain
    self.isEntitled = isEntitled
  }

  // MARK: - SyncedItemStore

  public func availability() -> SyncedStoreAvailability {
    guard isEntitled(), !refusal.wasRefused else { return .unavailable }
    var query = baseQuery()
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnAttributes as String] = true
    let status = observe(keychain.copyMatching(query).status)
    return status == errSecMissingEntitlement ? .unavailable : .available
  }

  public func all() throws -> [SyncedItem] {
    guard isEntitled() else { return [] }
    var query = baseQuery()
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnAttributes as String] = true
    query[kSecReturnData as String] = true

    let (listStatus, result) = keychain.copyMatching(query)
    let status = observe(listStatus)
    switch status {
    case errSecSuccess:
      return Self.items(from: result)
    case errSecItemNotFound, errSecMissingEntitlement:
      return []
    default:
      throw KeychainStore.error(status, .list)
    }
  }

  public func put(_ item: SyncedItem) throws {
    try Self.validate(item.account)
    guard isEntitled() else { return }
    try put(item, addAttempts: 2)
  }

  public func delete(account: String) throws {
    try Self.validate(account)
    guard isEntitled() else { return }
    let status = observe(keychain.delete(itemQuery(account)))
    switch status {
    case errSecSuccess, errSecItemNotFound, errSecMissingEntitlement:
      return
    default:
      throw KeychainStore.error(status, .delete)
    }
  }

  // MARK: - Writing

  /// Add, or update on a duplicate. An update that finds nothing means the
  /// item was deleted between the two calls, so the add is tried again, once.
  private func put(_ item: SyncedItem, addAttempts: Int) throws {
    let account = Data(item.account.utf8)
    let value = Data(item.value.utf8)

    var add = itemQuery(item.account)
    add[kSecAttrGeneric as String] = account
    add[kSecValueData as String] = value
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

    let status = observe(keychain.add(add))
    switch status {
    case errSecSuccess, errSecMissingEntitlement:
      return
    case errSecDuplicateItem:
      let attributes: [String: Any] = [
        kSecValueData as String: value,
        kSecAttrGeneric as String: account,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
      ]
      let updateStatus = observe(keychain.update(itemQuery(item.account), attributes))
      switch updateStatus {
      case errSecSuccess, errSecMissingEntitlement:
        return
      case errSecItemNotFound where addAttempts > 1:
        try put(item, addAttempts: addAttempts - 1)
      default:
        throw KeychainStore.error(updateStatus, .update)
      }
    default:
      throw KeychainStore.error(status, .add)
    }
  }

  /// Remembers a refusal, and passes the status on.
  private func observe(_ status: OSStatus) -> OSStatus {
    if status == errSecMissingEntitlement { refusal.record() }
    return status
  }

  // MARK: - Queries

  /// Class, service, synchronizable, the access group when one is named, and
  /// on macOS the data protection keychain. Every query starts here.
  func baseQuery() -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: true
    ]
    if let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    #if os(macOS)
      query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }

  /// The attributes that identify one item.
  func itemQuery(_ account: String) -> [String: Any] {
    var query = baseQuery()
    query[kSecAttrAccount as String] = Data(account.utf8)
    return query
  }

  /// The items in a list result, ordered by account. An item whose account is
  /// not data (written by something else), not a valid account, or whose
  /// value is not UTF-8 text is left out: it is not this store's to report,
  /// and one odd item must not stop the rest from syncing. When one account
  /// appears in two access groups (only possible for a binary that declares
  /// several), the item of the first group in name order is reported.
  static func items(from result: CFTypeRef?) -> [SyncedItem] {
    let found = (result as? [[String: Any]] ?? []).compactMap { attributes -> (SyncedItem, String)? in
      guard let account = KeychainStore.key(ofDataAccount: attributes[kSecAttrAccount as String]),
        SyncedItem.isValidAccount(account),
        let data = attributes[kSecValueData as String] as? Data,
        let value = String(data: data, encoding: .utf8)
      else { return nil }
      return (SyncedItem(account: account, value: value), attributes[kSecAttrAccessGroup as String] as? String ?? "")
    }

    var seen = Set<String>()
    return found
      .sorted { ($0.0.account, $0.1) < ($1.0.account, $1.1) }
      .compactMap { item, _ in seen.insert(item.account).inserted ? item : nil }
  }

  private static func validate(_ account: String) throws {
    guard SyncedItem.isValidAccount(account) else { throw SecretStoreError.invalidKey }
  }

  // MARK: - The process's entitlements

  /// Whether this process may use the data protection keychain at all. On
  /// macOS: it is signed with a keychain access group or an application
  /// identifier. Read once from the process's own code signature; the keychain
  /// is not touched. Elsewhere (iOS, the iOS Simulator, an iPad app on a Mac)
  /// every process that runs is signed, and a missing group shows up as
  /// `errSecMissingEntitlement`, so this is true.
  static let processHasKeychainEntitlement: Bool = {
    #if os(macOS)
      guard let task = SecTaskCreateFromSelf(nil) else { return false }
      func value(_ entitlement: String) -> CFTypeRef? {
        SecTaskCopyValueForEntitlement(task, entitlement as CFString, nil)
      }
      if let groups = value("keychain-access-groups") as? [String], !groups.isEmpty { return true }
      if let identifier = value("com.apple.application-identifier") as? String, !identifier.isEmpty { return true }
      return false
    #else
      return true
    #endif
  }()
}

/// Whether the keychain has refused this store with `errSecMissingEntitlement`.
/// A class so every copy of the store shares it.
final class Refusal: Sendable {
  private let refused = Mutex(false)

  var wasRefused: Bool { refused.withLock { $0 } }

  func record() { refused.withLock { $0 = true } }
}

/// The four keychain calls the synced store makes, so a unit test can record
/// every query and answer with any status, with no keychain involved.
protocol SyncedKeychain: Sendable {
  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: CFTypeRef?)
  func add(_ attributes: [String: Any]) -> OSStatus
  func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
  func delete(_ query: [String: Any]) -> OSStatus
}

/// The real keychain.
struct SystemKeychain: SyncedKeychain {
  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: CFTypeRef?) {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    return (status, result)
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    SecItemAdd(attributes as CFDictionary, nil)
  }

  func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}
