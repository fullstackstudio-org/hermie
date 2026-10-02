import Foundation

/// The synced set: the small group of keychain items that iCloud Keychain
/// carries to the person's other devices (decisions I1 and I5 of the iCloud
/// addendum, `.claude/plans/native-rewrite-icloud.md`).
///
/// It is a different set from the device-only credentials in `SecretStore`
/// (decision D12), and the two never meet: `ICloudKeychainStore` names
/// `kSecAttrSynchronizable = true` and its own service on every query, while
/// `KeychainStore` names neither, so the keychain keeps the items apart. Only
/// the gateway sync engine reads this store; runtime code (credentials, the
/// token coordinator, the extensions) never does.
///
/// The production implementation is `ICloudKeychainStore`;
/// `InMemorySyncedItemStore` is one device's replica of a `FakeCloud`, for
/// tests and previews.
///
/// Calls are synchronous, as `SecretStore`'s are: a keychain call is a short
/// IPC round trip, and the engine calls from its own actor.
public protocol SyncedItemStore: Sendable {
  /// Whether this process can use the synced set at all. `unavailable` when
  /// the keychain refuses the process for lack of a keychain access group (an
  /// unsigned build, `swift test`): the switch for sync is then disabled.
  ///
  /// `available` does not mean that anything travels: whether iCloud Keychain
  /// is on, or the device is signed in to an Apple Account, cannot be seen from
  /// an app. Items are then simply kept on the device.
  func availability() -> SyncedStoreAvailability

  /// Every item in the set, ordered by account. Empty when the store is
  /// unavailable. An empty answer is never a reason to delete anything: the
  /// keychain may be unavailable, or iCloud may not have delivered yet.
  func all() throws -> [SyncedItem]

  /// Adds the item, or replaces the value of the item with that account.
  /// Does nothing when the store is unavailable, without an error; the store
  /// then reports `unavailable` from that call on.
  ///
  /// So returning normally does not prove the item was stored: a put counts as
  /// published only once a later `all()` on this store shows it. Even then,
  /// whether and when it reaches another device cannot be known (see
  /// `FakeCloud`, "What it does not model").
  func put(_ item: SyncedItem) throws

  /// Deletes the item with that account. Succeeds when there is none, and does
  /// nothing when the store is unavailable.
  func delete(account: String) throws
}

/// What `SyncedItemStore.availability()` reports.
public enum SyncedStoreAvailability: Sendable, Equatable {
  case available
  case unavailable
}

/// One item of the synced set: an account (`gw.<gatewayKey>` in production)
/// and its value (a record's canonical JSON). The store neither reads nor
/// checks the value.
///
/// Its descriptions show lengths only, never the account or the value, so an
/// item that reaches a log, a test failure or a crash report leaks nothing.
public struct SyncedItem: Sendable, Equatable {
  public let account: String
  public let value: String

  public init(account: String, value: String) {
    self.account = account
    self.value = value
  }

  /// An account a synced store accepts: the key rule of the device-only set
  /// (`SecretKeys.isValidKey(_:)`, `^[\w.-]+$` in ASCII), so `gw.<16 hex>` and
  /// a test's `hermie.test.<run>.<name>` both pass and nothing that needs
  /// escaping does. Anything else throws `SecretStoreError.invalidKey` before
  /// the keychain is touched.
  public static func isValidAccount(_ account: String) -> Bool {
    SecretKeys.isValidKey(account)
  }
}

extension SyncedItem: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "SyncedItem(account: \(account.utf8.count) bytes, value: \(value.utf8.count) bytes)"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(self, children: ["accountBytes": account.utf8.count, "valueBytes": value.utf8.count])
  }
}
