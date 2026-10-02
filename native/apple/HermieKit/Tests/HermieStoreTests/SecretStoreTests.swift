import Foundation
import Testing

@testable import HermieStore

@Suite struct InMemorySecretStoreTests {
  @Test func roundTrip() throws {
    try SecretStoreContract.checkRoundTrip(InMemorySecretStore())
  }

  @Test func values() throws {
    try SecretStoreContract.checkValues(InMemorySecretStore())
  }

  @Test func independentKeys() throws {
    try SecretStoreContract.checkIndependentKeys(InMemorySecretStore())
  }

  @Test func invalidKeys() {
    SecretStoreContract.checkInvalidKeys(InMemorySecretStore())
  }

  @Test func concurrentWritersAndReaders() async throws {
    let store = InMemorySecretStore()
    let prefix = SecretStoreContract.runPrefix()

    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<200 {
        group.addTask {
          let key = prefix + "k\(index % 20)"
          try store.set(key, "v\(index)")
          _ = try store.get(key)
          if index.isMultiple(of: 7) { try store.delete(key) }
        }
      }
      try await group.waitForAll()
    }

    let remaining = store.count
    #expect(remaining <= 20)
    #expect(try store.removeAll(prefix: prefix) == remaining)
    #expect(store.count == 0)
  }

  @Test func removeAllDeletesOnlyThePrefix() throws {
    let run = SecretStoreContract.runPrefix()
    let other = SecretStoreContract.runPrefix()
    let store = InMemorySecretStore([
      run + "a": "1",
      run + "b-g00": "2",
      other + "a": "3",
      String(run.dropLast()) + "x": "4"  // the run id without its dot: not inside the prefix
    ])

    #expect(try store.removeAll(prefix: run) == 2)
    #expect(try store.get(run + "a") == nil)
    #expect(try store.get(run + "b-g00") == nil)
    #expect(try store.get(other + "a") == "3")
    #expect(try store.get(String(run.dropLast()) + "x") == "4")
  }

  @Test(arguments: [
    "", "h", "hermie", "hermie.", "hermie..", "hermie.s", "hermie.auth", "hermie.share.delivery", "other.auth.",
    "Hermie.auth.", "hermie.auth/", " hermie.auth."
  ])
  func removeAllRefusesPrefixesOutsideHermie(prefix: String) {
    let store = InMemorySecretStore(["hermie.auth.access_token-g00": "token"])
    #expect(throws: SecretStoreError.invalidPrefix) { try store.removeAll(prefix: prefix) }
    #expect(store.count == 1)
  }

  @Test func descriptionsShowNoKeyOrValue() {
    let secret = "s3cr3t-token-value"
    let store = InMemorySecretStore(["hermie.test.leak": secret])
    var dumped = ""
    dump(store, to: &dumped)

    for text in [String(describing: store), String(reflecting: store), dumped] {
      #expect(!text.contains(secret))
      #expect(!text.contains("hermie.test.leak"))
    }
  }
}

@Suite struct SecretKeyRuleTests {
  /// The keys Hermie uses, and the expression `expo-secure-store` checks them
  /// with, run through `NSRegularExpression` as a second opinion.
  @Test(arguments: [
    "hermie.auth.access_token-g0123456789abcdef",
    "hermie.share.delivery",
    "hermie.push.manage-g00",
    "a",
    "A_b.c-d",
    "0",
    "...",
    "---"
  ])
  func acceptsWhatExpoAccepts(key: String) {
    #expect(SecretKeys.isValidKey(key))
    #expect(Self.expoAccepts(key))
  }

  @Test(arguments: SecretStoreContract.invalidKeys + ["\u{00A0}", "ａ", "a\u{0301}", "٣"])
  func refusesWhatExpoRefuses(key: String) {
    #expect(!SecretKeys.isValidKey(key))
    #expect(!Self.expoAccepts(key))
  }

  /// `/^[\w.-]+$/.test(key)` from `isValidKey` in expo-secure-store's
  /// `SecureStore.ts`. ICU's `\w` is Unicode-aware where JavaScript's is not, so
  /// the class is spelled out as the ASCII set JavaScript uses, and ICU's `$`
  /// also matches before a final newline where JavaScript's does not, so the
  /// end is `\z`.
  private static func expoAccepts(_ key: String) -> Bool {
    let expression = try! NSRegularExpression(pattern: #"^[A-Za-z0-9_.-]+\z"#)
    let range = NSRange(key.startIndex..., in: key)
    return expression.firstMatch(in: key, range: range) != nil
  }

  @Test func gatewayKeysAreTheExpoNames() throws {
    let gateway = try SecretKeys.gateway("g0123456789abcdef")

    #expect(gateway.accessToken == "hermie.auth.access_token-g0123456789abcdef")
    #expect(gateway.refreshToken == "hermie.auth.refresh_token-g0123456789abcdef")
    #expect(gateway.tokenMeta == "hermie.auth.token_meta-g0123456789abcdef")
    #expect(gateway.sessionToken == "hermie.auth.session_token-g0123456789abcdef")
    #expect(gateway.extraHeaders == "hermie.auth.extra_headers-g0123456789abcdef")
    #expect(gateway.frontDoor == "hermie.auth.front_door-g0123456789abcdef")
    #expect(gateway.pushManage == "hermie.push.manage-g0123456789abcdef")
    #expect(gateway.credentials.count == 6)
    #expect(gateway.all == gateway.credentials + [gateway.pushManage])
    #expect(gateway.all.allSatisfy(SecretKeys.isValidKey))
    #expect(Set(gateway.all).count == gateway.all.count)
    #expect(SecretKeys.shareDelivery == "hermie.share.delivery")
  }

  @Test(arguments: ["", "g-00", "g.00", "g 00", "g/00", "gë"])
  func gatewayIdsThatBreakTheSplitAreRefused(id: String) {
    #expect(throws: SecretStoreError.invalidGatewayId) { try SecretKeys.gateway(id) }
  }

  @Test func ownedPrefixMatchingNeverLeavesHermie() {
    #expect(SecretKeys.key("hermie.auth.access_token-g00", matchesOwnedPrefix: "hermie.auth."))
    #expect(!SecretKeys.key("hermie.share.delivery", matchesOwnedPrefix: "hermie.auth."))
    #expect(!SecretKeys.key("other.auth.x", matchesOwnedPrefix: "hermie.auth."))
    #expect(!SecretKeys.key("hermie.auth.x", matchesOwnedPrefix: "hermie."))
    #expect(!SecretKeys.key("hermie.auth.x", matchesOwnedPrefix: ""))
    // Whole dotted segments only: a prefix must end in a dot.
    #expect(!SecretKeys.key("hermie.share.delivery", matchesOwnedPrefix: "hermie.s"))
    #expect(!SecretKeys.key("hermie.auth.access_token-g00", matchesOwnedPrefix: "hermie.auth"))
    #expect(SecretKeys.key("hermie.share.delivery", matchesOwnedPrefix: "hermie.share."))
    // A key that is not itself valid never matches, whatever a keychain returns.
    #expect(!SecretKeys.key("hermie.auth.a b", matchesOwnedPrefix: "hermie.auth."))
  }
}

@Suite struct SecretStoreErrorTests {
  static let all: [SecretStoreError] = [
    .invalidKey, .invalidPrefix, .invalidGatewayId, .missingEntitlement, .interactionNotAllowed,
    .undecodableValue, .keychain(operation: .add, status: -25299)
  ]

  @Test func everyCaseDescribesItself() {
    for error in Self.all {
      #expect(!error.description.isEmpty)
      #expect(error.localizedDescription == error.description)
      #expect(String(reflecting: error).contains(error.description))
    }
    #expect(SecretStoreError.keychain(operation: .update, status: -25300).description.contains("-25300"))
  }

  /// `set(_:_:)` with its arguments swapped hands the store a token as the key.
  /// The error that follows must not repeat it anywhere.
  @Test func aSwappedSetDoesNotEchoTheToken() {
    let token = "Bearer eyJhbGciOi.payload/with+chars="
    let store = InMemorySecretStore()

    do {
      try store.set(token, "hermie.test.key")
      Issue.record("an invalid key was accepted")
    } catch {
      var dumped = ""
      dump(error, to: &dumped)
      for text in [
        String(describing: error), String(reflecting: error), error.localizedDescription,
        (error as NSError).description, dumped
      ] {
        #expect(!text.contains(token))
        #expect(!text.contains("payload"))
      }
    }
  }
}
