import Foundation
import HermieStore
import Testing

/// The behaviour every `SecretStore` has, written once and run against
/// `InMemorySecretStore` here and against the real `KeychainStore` in the app
/// hosted keychain tests (`native/apple/HostedTests`), which compile this file
/// too.
///
/// Every key it touches is a throwaway: `hermie.test.` plus a random run id.
/// `requireTestKey` stops the run before a call is made with anything else, so
/// no contract check can reach a real credential whatever store it is given.
enum SecretStoreContract {
  static let testPrefix = "hermie.test."

  /// A fresh namespace for one test, `hermie.test.<32 hex>.`.
  static func runPrefix() -> String {
    testPrefix + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "") + "."
  }

  /// A fresh key inside a fresh namespace.
  static func testKey(_ name: String = "secret") -> String {
    runPrefix() + name
  }

  static func requireTestKey(_ key: String) {
    precondition(
      key.hasPrefix(testPrefix) && key.count > testPrefix.count + 8,
      "contract checks only ever touch hermie.test.<run> keys"
    )
  }

  /// Missing is nil; set, overwrite, delete, and delete again.
  static func checkRoundTrip(_ store: some SecretStore, key: String = testKey()) throws {
    requireTestKey(key)
    defer { try? store.delete(key) }

    #expect(try store.get(key) == nil)
    try store.set(key, "first")
    #expect(try store.get(key) == "first")
    try store.set(key, "second")
    #expect(try store.get(key) == "second")
    try store.delete(key)
    #expect(try store.get(key) == nil)
    // Deleting what is not there is not an error.
    try store.delete(key)
    #expect(try store.get(key) == nil)
  }

  /// Values come back byte for byte, whatever they hold.
  static func checkValues(_ store: some SecretStore, key: String = testKey()) throws {
    requireTestKey(key)
    defer { try? store.delete(key) }

    let values = [
      "",
      " ",
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
      #"{"origin":"https://gateway.example","headers":{"cf-access-client-id":"x"}}"#,
      "zoë, 日本語, \u{1F512}, tab\tnewline\n",
      String(repeating: "x", count: 8 * 1024)
    ]
    for value in values {
      try store.set(key, value)
      #expect(try store.get(key) == value)
    }
  }

  /// Two keys never see each other, including one that is a prefix of another.
  static func checkIndependentKeys(_ store: some SecretStore) throws {
    let prefix = runPrefix()
    let short = prefix + "token"
    let long = prefix + "token-g00ff"
    requireTestKey(short)
    requireTestKey(long)
    defer {
      try? store.delete(short)
      try? store.delete(long)
    }

    try store.set(short, "short")
    try store.set(long, "long")
    #expect(try store.get(short) == "short")
    #expect(try store.get(long) == "long")
    try store.delete(short)
    #expect(try store.get(short) == nil)
    #expect(try store.get(long) == "long")
  }

  /// Keys `expo-secure-store` would refuse are refused before the store is
  /// touched, by every operation, with an error that does not echo them.
  static func checkInvalidKeys(_ store: some SecretStore) {
    for key in invalidKeys {
      #expect(throws: SecretStoreError.invalidKey) { try store.get(key) }
      #expect(throws: SecretStoreError.invalidKey) { try store.set(key, "value") }
      #expect(throws: SecretStoreError.invalidKey) { try store.delete(key) }
    }
  }

  static let invalidKeys = [
    "",
    " ",
    "hermie.test. space",
    "hermie.test/slash",
    "hermie.test@gateway",
    "hermie.test:colon",
    "hermie.test+plus",
    "hermie.tëst",
    "hermie.test.\u{1F512}",
    "hermie.test\n"
  ]
}
