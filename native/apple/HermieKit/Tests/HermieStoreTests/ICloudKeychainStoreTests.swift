import Foundation
import Security
import Synchronization
import Testing

@testable import HermieStore

/// A keychain that records every call and answers with scripted statuses, so
/// `ICloudKeychainStore` can be checked query by query without a keychain.
/// Nothing here reaches `SecItem*`.
final class RecordingKeychain: SyncedKeychain {
  enum Call {
    case copyMatching([String: Any])
    case add([String: Any])
    case update([String: Any], [String: Any])
    case delete([String: Any])

    var query: [String: Any] {
      switch self {
      case let .copyMatching(query), let .add(query), let .update(query, _), let .delete(query): query
      }
    }
  }

  struct Script {
    var copyMatching: [(OSStatus, [[String: Any]]?)] = []
    var add: [OSStatus] = []
    var update: [OSStatus] = []
    var delete: [OSStatus] = []
  }

  // `[String: Any]` is not Sendable; the lock is what makes this safe.
  private nonisolated(unsafe) var calls: [Call] = []
  private nonisolated(unsafe) var script: Script
  private let lock = Mutex(())

  init(_ script: Script = Script()) {
    self.script = script
  }

  var recorded: [Call] { lock.withLock { _ in calls } }

  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, result: CFTypeRef?) {
    lock.withLock { _ in
      calls.append(.copyMatching(query))
      guard !script.copyMatching.isEmpty else { return (errSecItemNotFound, nil) }
      let (status, items) = script.copyMatching.removeFirst()
      return (status, items.map { $0 as CFArray })
    }
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    lock.withLock { _ in
      calls.append(.add(attributes))
      return script.add.isEmpty ? errSecSuccess : script.add.removeFirst()
    }
  }

  func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
    lock.withLock { _ in
      calls.append(.update(query, attributes))
      return script.update.isEmpty ? errSecSuccess : script.update.removeFirst()
    }
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    lock.withLock { _ in
      calls.append(.delete(query))
      return script.delete.isEmpty ? errSecSuccess : script.delete.removeFirst()
    }
  }
}

@Suite struct ICloudKeychainStoreQueryTests {
  static let service = "hermie.test.sync"
  static let account = "gw.9f3ab0c2d4e5f601"

  static func store(
    _ keychain: RecordingKeychain,
    accessGroup: String? = nil,
    entitled: Bool = true
  ) -> ICloudKeychainStore {
    ICloudKeychainStore(service: service, accessGroup: accessGroup, keychain: keychain) { entitled }
  }

  /// Every query the store can make, from every operation and path.
  static func everyCall(accessGroup: String? = nil) throws -> [RecordingKeychain.Call] {
    let keychain = RecordingKeychain(
      .init(
        copyMatching: [(errSecSuccess, []), (errSecSuccess, [])],
        add: [errSecSuccess, errSecDuplicateItem, errSecDuplicateItem, errSecSuccess],
        update: [errSecSuccess, errSecItemNotFound]
      ))
    let store = store(keychain, accessGroup: accessGroup)
    _ = store.availability()
    _ = try store.all()
    try store.put(SyncedItem(account: account, value: "a"))  // add
    try store.put(SyncedItem(account: account, value: "b"))  // add, update
    try store.put(SyncedItem(account: account, value: "c"))  // add, update (vanished), add
    try store.delete(account: account)
    return keychain.recorded
  }

  // MARK: - The item shape on every query

  @Test func everyQueryIsSynchronizableOnTheStoresService() throws {
    let calls = try Self.everyCall()
    #expect(calls.count == 9)

    for call in calls {
      let query = call.query
      #expect(query[kSecClass as String] as? String == kSecClassGenericPassword as String)
      #expect(query[kSecAttrService as String] as? String == Self.service)
      // `true`, never "any": a query without it would match device-only items.
      #expect(query[kSecAttrSynchronizable as String] as? Bool == true)
      #expect(query[kSecAttrSynchronizable as String] as? String != kSecAttrSynchronizableAny as String)
      #expect(query[kSecAttrAccessGroup as String] == nil)
      #if os(macOS)
        #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
      #else
        #expect(query[kSecUseDataProtectionKeychain as String] == nil)
      #endif
    }
  }

  @Test func itemQueriesNameTheAccountAsData() throws {
    for call in try Self.everyCall() {
      switch call {
      case .copyMatching:
        #expect(call.query[kSecAttrAccount as String] == nil)
      case .add, .update, .delete:
        #expect(call.query[kSecAttrAccount as String] as? Data == Data(Self.account.utf8))
        // Written, never matched on.
        if case .add = call {
          #expect(call.query[kSecAttrGeneric as String] as? Data == Data(Self.account.utf8))
        } else {
          #expect(call.query[kSecAttrGeneric as String] == nil)
        }
      }
    }
  }

  @Test func anAddIsAfterFirstUnlockWithTheValueAsData() throws {
    let keychain = RecordingKeychain()
    try Self.store(keychain).put(SyncedItem(account: Self.account, value: "zoë"))

    guard case let .add(attributes) = try #require(keychain.recorded.first) else {
      Issue.record("expected an add")
      return
    }
    #expect(
      attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
    #expect(attributes[kSecValueData as String] as? Data == Data("zoë".utf8))
    #expect(keychain.recorded.count == 1)
  }

  @Test func aDuplicateIsUpdatedInPlaceKeepingTheShape() throws {
    let keychain = RecordingKeychain(.init(add: [errSecDuplicateItem]))
    try Self.store(keychain).put(SyncedItem(account: Self.account, value: "new"))

    #expect(keychain.recorded.count == 2)
    guard case let .update(query, attributes) = try #require(keychain.recorded.last) else {
      Issue.record("expected an update")
      return
    }
    #expect(query[kSecValueData as String] == nil)
    #expect(attributes[kSecValueData as String] as? Data == Data("new".utf8))
    #expect(attributes[kSecAttrGeneric as String] as? Data == Data(Self.account.utf8))
    #expect(
      attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
    #expect(attributes.count == 3)
  }

  @Test func anItemThatVanishesBeforeTheUpdateIsAddedOnceMore() throws {
    let keychain = RecordingKeychain(
      .init(add: [errSecDuplicateItem, errSecDuplicateItem], update: [errSecItemNotFound, errSecItemNotFound]))
    #expect(throws: SecretStoreError.keychain(operation: .update, status: errSecItemNotFound)) {
      try Self.store(keychain).put(SyncedItem(account: Self.account, value: "v"))
    }
    // add, update, add, update: two attempts and no more.
    #expect(keychain.recorded.count == 4)
  }

  @Test func listReturnsAttributesAndData() throws {
    let keychain = RecordingKeychain()
    #expect(try Self.store(keychain).all() == [])

    let query = try #require(keychain.recorded.first).query
    #expect(query[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String)
    #expect(query[kSecReturnAttributes as String] as? Bool == true)
    #expect(query[kSecReturnData as String] as? Bool == true)
  }

  @Test func availabilityReadsAttributesOfOneItemAndNoData() {
    let keychain = RecordingKeychain()
    #expect(Self.store(keychain).availability() == .available)

    let query = keychain.recorded.first?.query ?? [:]
    #expect(query[kSecMatchLimit as String] as? String == kSecMatchLimitOne as String)
    #expect(query[kSecReturnData as String] == nil)
    #expect(keychain.recorded.count == 1)
  }

  @Test func anInjectedGroupIsNamedOnEveryQuery() throws {
    for call in try Self.everyCall(accessGroup: "group.example.test") {
      #expect(call.query[kSecAttrAccessGroup as String] as? String == "group.example.test")
    }
  }

  // MARK: - The service

  /// Production is only ever the default: the hosted tests, and anything else,
  /// name their own, and every query uses the one named.
  @Test func theProductionServiceIsOnlyTheDefault() {
    #expect(ICloudKeychainStore.productionService == "hermie.sync.v1")
    #expect(ICloudKeychainStore().service == "hermie.sync.v1")
    #expect(ICloudKeychainStore().accessGroup == nil)
    #expect(ICloudKeychainStore(service: "hermie.test.other").service == "hermie.test.other")
  }

  /// The synced set and the device-only set never share a service.
  @Test func theProductionServiceIsNotADeviceOnlyService() {
    #expect(!KeychainStore.allServices.contains(ICloudKeychainStore.productionService))
  }

  // MARK: - Listing

  static func listed(_ account: Any, _ value: Any?, group: String? = nil) -> [String: Any] {
    var attributes: [String: Any] = [kSecAttrAccount as String: account]
    if let value { attributes[kSecValueData as String] = value }
    if let group { attributes[kSecAttrAccessGroup as String] = group }
    return attributes
  }

  @Test func listSkipsWhatIsNotOursAndOrdersByAccount() throws {
    let keychain = RecordingKeychain(
      .init(copyMatching: [
        (
          errSecSuccess,
          [
            Self.listed(Data("gw.b".utf8), Data("2".utf8)),
            Self.listed("gw.string-account", Data("x".utf8)),  // a string account: someone else's
            Self.listed(Data("gw.a".utf8), Data("1".utf8)),
            Self.listed(Data("gw bad".utf8), Data("x".utf8)),  // not a valid account
            Self.listed(Data("gw.c".utf8), Data([0xFF, 0xFE])),  // not UTF-8
            Self.listed(Data("gw.d".utf8), nil),  // no value
            Self.listed(Data("gw.e".utf8), Data("5-z".utf8), group: "z.group"),
            Self.listed(Data("gw.e".utf8), Data("5-a".utf8), group: "a.group")
          ]
        )
      ]))
    #expect(
      try Self.store(keychain).all() == [
        SyncedItem(account: "gw.a", value: "1"),
        SyncedItem(account: "gw.b", value: "2"),
        SyncedItem(account: "gw.e", value: "5-a")
      ])
  }

  // MARK: - Unavailable

  /// `errSecMissingEntitlement` from any call: unavailable, empty, writes
  /// ignored, nothing thrown.
  @Test func aMissingEntitlementIsUnavailableAndNeverThrown() throws {
    let refusing = RecordingKeychain(
      .init(
        copyMatching: [(errSecMissingEntitlement, nil), (errSecMissingEntitlement, nil)],
        add: [errSecMissingEntitlement, errSecDuplicateItem],
        update: [errSecMissingEntitlement],
        delete: [errSecMissingEntitlement]
      ))
    let store = Self.store(refusing)

    #expect(store.availability() == .unavailable)
    #expect(try store.all() == [])
    try store.put(SyncedItem(account: Self.account, value: "v"))  // add refused
    try store.put(SyncedItem(account: Self.account, value: "v"))  // update refused
    try store.delete(account: Self.account)
  }

  /// A put the keychain refused returns normally, so the store remembers the
  /// refusal: `availability()` says `unavailable` from then on, even when a
  /// later read would pass, and every copy of the store agrees.
  enum RefusedCall: CaseIterable, Sendable {
    case add, update, delete, list
  }

  @Test(arguments: RefusedCall.allCases)
  func aRefusalIsRemembered(refused: RefusedCall) throws {
    let keychain: RecordingKeychain
    switch refused {
    case .add: keychain = RecordingKeychain(.init(add: [errSecMissingEntitlement]))
    case .update:
      keychain = RecordingKeychain(.init(add: [errSecDuplicateItem], update: [errSecMissingEntitlement]))
    case .delete: keychain = RecordingKeychain(.init(delete: [errSecMissingEntitlement]))
    case .list: keychain = RecordingKeychain(.init(copyMatching: [(errSecMissingEntitlement, nil)]))
    }
    let store = Self.store(keychain)
    let copy = store

    switch refused {
    case .add, .update: try store.put(SyncedItem(account: Self.account, value: "dropped"))
    case .delete: try store.delete(account: Self.account)
    case .list: #expect(try store.all() == [])
    }

    // A probe would now pass (the script answers "not found"), and still:
    let calls = keychain.recorded.count
    #expect(store.availability() == .unavailable)
    #expect(copy.availability() == .unavailable)
    #expect(keychain.recorded.count == calls)  // decided without asking again
  }

  @Test func availabilityStaysAvailableWithoutARefusal() throws {
    let keychain = RecordingKeychain(.init(add: [errSecIO]))
    let store = Self.store(keychain)
    #expect(throws: SecretStoreError.self) { try store.put(SyncedItem(account: Self.account, value: "v")) }
    #expect(store.availability() == .available)
  }

  /// Without an entitlement, nothing reaches the keychain at all: this is
  /// what an unsigned macOS process (`swift test`, CI) gets.
  @Test func anUnentitledProcessNeverCallsTheKeychain() throws {
    let keychain = RecordingKeychain()
    let store = Self.store(keychain, entitled: false)

    #expect(store.availability() == .unavailable)
    #expect(try store.all() == [])
    try store.put(SyncedItem(account: Self.account, value: "v"))
    try store.delete(account: Self.account)
    #expect(keychain.recorded.isEmpty)
  }

  // MARK: - Errors

  @Test func invalidAccountsNeverReachTheKeychain() {
    let keychain = RecordingKeychain()
    SyncedItemStoreContract.checkInvalidAccounts(Self.store(keychain))
    #expect(keychain.recorded.isEmpty)
  }

  @Test func otherStatusesAreTypedErrors() {
    let failing = RecordingKeychain(
      .init(
        copyMatching: [(errSecInteractionNotAllowed, nil)],
        add: [errSecIO, errSecDuplicateItem],
        update: [errSecAuthFailed],
        delete: [errSecIO]
      ))
    let store = Self.store(failing)
    #expect(throws: SecretStoreError.interactionNotAllowed) { try store.all() }
    #expect(throws: SecretStoreError.keychain(operation: .add, status: errSecIO)) {
      try store.put(SyncedItem(account: Self.account, value: "v"))
    }
    #expect(throws: SecretStoreError.keychain(operation: .update, status: errSecAuthFailed)) {
      try store.put(SyncedItem(account: Self.account, value: "v"))
    }
    #expect(throws: SecretStoreError.keychain(operation: .delete, status: errSecIO)) {
      try store.delete(account: Self.account)
    }
  }

  /// No error, and no description of an item or a store, names an account or
  /// a value.
  @Test func nothingDescribesAnAccountOrAValue() throws {
    let account = "gw.secretaccount1"
    let value = "secret-token-value"
    let failing = RecordingKeychain(
      .init(copyMatching: [(errSecIO, nil)], add: [errSecIO], delete: [errSecIO]))
    let store = Self.store(failing)

    var texts: [String] = []
    for call in [
      { _ = try store.all() },
      { try store.put(SyncedItem(account: account, value: value)) },
      { try store.delete(account: account) },
      { try store.put(SyncedItem(account: "bad account", value: value)) }
    ] as [() throws -> Void] {
      do {
        try call()
        Issue.record("expected an error")
      } catch {
        texts += [
          "\(error)", String(reflecting: error), error.localizedDescription
        ]
      }
    }
    let item = SyncedItem(account: account, value: value)
    texts += ["\(item)", String(reflecting: item), "\([item])", "\(Mirror(reflecting: item).children.map(\.value))"]
    texts += ["\(store)"]

    for text in texts {
      #expect(!text.contains(account) && !text.contains("secretaccount"), "\(text)")
      #expect(!text.contains(value) && !text.contains("secret-token"), "\(text)")
      #expect(!text.contains("bad account"), "\(text)")
    }
  }
}

/// The real store in `swift test`, which is unsigned: it must say so, and it
/// must not get as far as the keychain.
@Suite struct ICloudKeychainStoreUnsignedTests {
  #if os(macOS)
    /// `swift test` runs in `swiftpm-testing-helper` or `xctest`, which carry
    /// no keychain access group and no application identifier. The entitlement
    /// check reads the process's own code signature; the keychain is not
    /// touched. Together with `anUnentitledProcessNeverCallsTheKeychain` this
    /// is why no test on a Mac can write a synchronizable item: the real
    /// store's every call returns before `SecItem*` in this process. If a
    /// runner ever gained an entitlement this fails, and still writes nothing.
    @Test func theTestProcessHasNoKeychainEntitlement() {
      #expect(ICloudKeychainStore.processHasKeychainEntitlement == false)
    }

    /// The only call on the real store in `swift test`: it reads the
    /// entitlements, and nothing else.
    @Test func theRealStoreReportsUnavailable() {
      #expect(ICloudKeychainStore(service: "hermie.test.unsigned").availability() == .unavailable)
      #expect(ICloudKeychainStore().availability() == .unavailable)
    }
  #endif

  /// The tests that run on the real keychain (the hosted ones, simulator
  /// only) never use the production service: they name a `hermie.test.`
  /// service of their own, through one helper.
  @Test func hostedTestsNeverUseTheProductionService() throws {
    let hosted = KeychainCompatibilitySourceTests.repo.appending(path: "native/apple/HostedTests")
    let files = try FileManager.default.contentsOfDirectory(at: hosted, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
    #expect(!files.isEmpty)

    var constructions = 0
    for file in files {
      let source = try String(contentsOf: file, encoding: .utf8)
      #expect(!source.contains(ICloudKeychainStore.productionService), "\(file.lastPathComponent)")
      #expect(!source.contains("productionService"), "\(file.lastPathComponent)")
      #expect(!source.contains("ICloudKeychainStore()"), "\(file.lastPathComponent)")
      constructions += source.components(separatedBy: "ICloudKeychainStore(").count - 1
    }
    // Exactly one place builds a real store, and it checks the service.
    #expect(constructions == 1)
  }

  /// A hosted file that can write a synchronizable item refuses to compile
  /// for anything but the simulator: on a device the item would sync.
  @Test func hostedSyncedWritesCompileForTheSimulatorOnly() throws {
    let hosted = KeychainCompatibilitySourceTests.repo.appending(path: "native/apple/HostedTests")
    let files = try FileManager.default.contentsOfDirectory(at: hosted, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
    var guarded = 0
    for file in files {
      let source = try String(contentsOf: file, encoding: .utf8)
      guard source.contains("ICloudKeychainStore(") || source.contains("kSecAttrSynchronizable as String: true")
      else { continue }
      guarded += 1
      let lines = source.components(separatedBy: "\n")
      let firstGuard = lines.firstIndex { $0.hasPrefix("#if !targetEnvironment(simulator)") }
      let firstDeclaration = lines.firstIndex { $0.hasPrefix("@Suite") || $0.hasPrefix("struct") }
      #expect(firstGuard != nil && lines[firstGuard! + 1].contains("#error("), "\(file.lastPathComponent)")
      #expect((firstGuard ?? .max) < (firstDeclaration ?? 0), "\(file.lastPathComponent)")
    }
    #expect(guarded >= 1)
  }

  /// `accessGroup: nil` reads every declared group. Each app declares its own
  /// group and, second, the share extension's, which holds the one delivery
  /// record and nothing else; the share extension declares only that one, so
  /// it can never read the app's secrets.
  @Test func eachBinaryDeclaresOnlyTheGroupsItNeeds() throws {
    var apps = 0
    var shares = 0
    for file in KeychainCompatibilitySourceTests.entitlementsFiles() where file.path.contains("/native/") {
      let data = try Data(contentsOf: file)
      let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
      guard let groups = plist?["keychain-access-groups"] as? [String] else { continue }
      if file.lastPathComponent.hasPrefix("HermieShare-") {
        shares += 1
        #expect(groups == ["$(AppIdentifierPrefix)dev.hermie.app.share"], "\(file.path)")
      } else {
        apps += 1
        #expect(
          groups == ["$(AppIdentifierPrefix)dev.hermie.app", "$(AppIdentifierPrefix)dev.hermie.app.share"],
          "\(file.path)")
      }
    }
    #expect(apps >= 2)
    #expect(shares == 2)
  }
}
