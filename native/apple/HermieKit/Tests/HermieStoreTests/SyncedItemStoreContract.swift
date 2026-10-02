import Foundation
import HermieStore
import Testing

/// The behaviour every `SyncedItemStore` has, written once and run against
/// `InMemorySyncedItemStore` here and against the real `ICloudKeychainStore`
/// in the app hosted keychain tests (`native/apple/HostedTests`), which compile
/// this file too.
///
/// Every account it touches is a throwaway `hermie.test.<run>.` account from
/// `SecretStoreContract`, checked by `requireTestKey` before any call, and it
/// only ever looks at its own accounts in a listing, so it holds whatever else
/// the store contains.
enum SyncedItemStoreContract {
  /// The run's items among everything the store lists.
  static func items(_ store: some SyncedItemStore, prefix: String) throws -> [SyncedItem] {
    try store.all().filter { $0.account.hasPrefix(prefix) }
  }

  /// Absent, put, replace, delete, delete again.
  static func checkRoundTrip(_ store: some SyncedItemStore) throws {
    let prefix = SecretStoreContract.runPrefix()
    let account = prefix + "gw"
    SecretStoreContract.requireTestKey(account)
    defer { try? store.delete(account: account) }

    #expect(store.availability() == .available)
    #expect(try items(store, prefix: prefix).isEmpty)

    try store.put(SyncedItem(account: account, value: "first"))
    #expect(try items(store, prefix: prefix) == [SyncedItem(account: account, value: "first")])

    try store.put(SyncedItem(account: account, value: "second"))
    #expect(try items(store, prefix: prefix) == [SyncedItem(account: account, value: "second")])

    try store.delete(account: account)
    #expect(try items(store, prefix: prefix).isEmpty)
    // Deleting what is not there is not an error.
    try store.delete(account: account)
    #expect(try items(store, prefix: prefix).isEmpty)
  }

  /// Values come back byte for byte, whatever they hold.
  static func checkValues(_ store: some SyncedItemStore) throws {
    let prefix = SecretStoreContract.runPrefix()
    let account = prefix + "gw"
    SecretStoreContract.requireTestKey(account)
    defer { try? store.delete(account: account) }

    let values = [
      "",
      #"{"v":1,"key":"9f3ab0c2d4e5f601","addedAt":1789000000000}"#,
      "zoë, 日本語, \u{1F512}, tab\tnewline\n",
      String(repeating: "x", count: 8 * 1024)
    ]
    for value in values {
      try store.put(SyncedItem(account: account, value: value))
      #expect(try items(store, prefix: prefix).map(\.value) == [value])
    }
  }

  /// Several accounts, one a prefix of another, listed in account order and
  /// deleted one at a time.
  static func checkIndependentAccounts(_ store: some SyncedItemStore) throws {
    let prefix = SecretStoreContract.runPrefix()
    let accounts = [prefix + "gw.b", prefix + "gw", prefix + "gw.a"]
    for account in accounts { SecretStoreContract.requireTestKey(account) }
    defer { for account in accounts { try? store.delete(account: account) } }

    for account in accounts { try store.put(SyncedItem(account: account, value: "v-" + account)) }
    #expect(try items(store, prefix: prefix).map(\.account) == accounts.sorted())
    #expect(try items(store, prefix: prefix).allSatisfy { $0.value == "v-" + $0.account })

    try store.delete(account: prefix + "gw")
    #expect(try items(store, prefix: prefix).map(\.account) == [prefix + "gw.a", prefix + "gw.b"])
  }

  /// Accounts that need escaping are refused before the store is touched,
  /// with an error that does not echo them.
  static func checkInvalidAccounts(_ store: some SyncedItemStore) {
    for account in SecretStoreContract.invalidKeys {
      #expect(throws: SecretStoreError.invalidKey) { try store.put(SyncedItem(account: account, value: "v")) }
      #expect(throws: SecretStoreError.invalidKey) { try store.delete(account: account) }
    }
  }
}
