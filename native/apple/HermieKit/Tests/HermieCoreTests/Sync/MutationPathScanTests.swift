import Foundation
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

/**
 The sync engine's intents are the only paths that add, move or remove a gateway, sign out of it
 or write or delete its credentials: a direct write is silently undone by the next sync (the
 merge restores what it did not hear of), has no "added here", or bypasses the origin binding.
 The writers themselves are `@_spi(GatewaySync)` (`GatewayRegistryStore.add/remove/update/purge`,
 `GatewaySecrets.load/save/clearCredentials`, `SecretTokenStore.init`); this scan is the second
 line, for what the SPI cannot catch (an alias, a raw `kvSet` of the list, a raw keychain write). A
 new caller either goes through the engine, or is added to `allowed` below with its reason.
 */
@Suite struct MutationPathScanTests {
  struct Rule: Sendable {
    let name: String
    let pattern: String
  }

  static let rules = [
    Rule(name: "credentials saved or cleared", pattern: #"GatewaySecrets\.(clearCredentials|save|load)\("#),
    Rule(name: "a credential provider signed out", pattern: #"\.signOut\(\)"#),
    Rule(name: "a registry store built", pattern: #"GatewayRegistryStore\("#),
    Rule(
      name: "the registry written",
      pattern: #"\b(store|registry|registryStore|GatewayRegistryStore)\.(add\(|remove\(id:|update\s*[\(\{]|purge\()"#),
    Rule(
      name: "the registry key written directly",
      pattern: #"(kvSet|kvRemove|setString|removeValue|kvInsertIfAbsent|\.set)\(.*StoreKeys\.gateways"#),
    Rule(
      name: "a gateway credential written directly",
      pattern: #"\.(set|delete)\(.*\.(accessToken|refreshToken|tokenMeta|sessionToken|extraHeaders|frontDoor)\b"#),
    Rule(name: "a token store built", pattern: #"SecretTokenStore\("#)
  ]

  /// Where the operations are defined, and the engine itself.
  static let owners = [
    "HermieCore/Sync/",
    "HermieStore/GatewayRegistry.swift",
    "HermieGateway/GatewaySecrets.swift",
    "HermieGateway/NativePKCECredentials.swift",
    "HermieGateway/Credentials.swift",
    "HermieGateway/CredentialProvider.swift"
  ]

  /// Path (under `Sources/`) and rule name → why it may.
  static let allowed: [String: [String: String]] = [
    "HermieCore/AppLaunch/AppLaunch.swift": [
      "a registry store built":
        "the store GatewayDirectory reads, activates and renames with; it removes through the engine"
    ],
    "HermieCore/AppLaunch/LaunchTestHooks.swift": [
      "a registry store built": "DEBUG builds only: UI-test seeding before the launch reads the list",
      "the registry written": "DEBUG builds only: UI-test seeding before the launch reads the list"
    ]
  ]

  static var sources: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // Sync
      .deletingLastPathComponent()  // HermieCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // HermieKit
      .appendingPathComponent("Sources", isDirectory: true)
  }

  /// Every rule hit outside the owners, as `path:line: rule`, comments left out.
  static func findings(in root: URL) throws -> (files: Int, hits: [(path: String, line: Int, rule: String)]) {
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
    var files = 0
    var hits: [(String, Int, String)] = []
    let expressions = try rules.map { ($0.name, try NSRegularExpression(pattern: $0.pattern)) }

    while let url = enumerator?.nextObject() as? URL {
      guard url.pathExtension == "swift" else { continue }
      let path = String(url.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
      files += 1
      guard !owners.contains(where: { path.hasPrefix($0) }) else { continue }

      let text = try String(contentsOf: url, encoding: .utf8)
      for (index, line) in text.components(separatedBy: "\n").enumerated() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.hasPrefix("//"), !trimmed.hasPrefix("*") else { continue }
        let range = NSRange(line.startIndex..., in: line)
        for (name, expression) in expressions where expression.firstMatch(in: line, range: range) != nil {
          hits.append((path, index + 1, name))
        }
      }
    }

    return (files, hits)
  }

  @Test func nothingOutsideTheEngineAddsMovesRemovesOrSignsOutOnItsOwn() throws {
    let (files, hits) = try Self.findings(in: Self.sources)
    #expect(files > 100, "the scan found \(files) source files; is the path right?")

    let unexplained = hits.filter { Self.allowed[$0.path]?[$0.rule] == nil }
    #expect(unexplained.isEmpty, "\(unexplained.map { "\($0.path):\($0.line): \($0.rule)" })")

    // An allow-list entry that no longer matches anything is stale.
    for (path, rules) in Self.allowed {
      for rule in rules.keys {
        #expect(hits.contains { $0.path == path && $0.rule == rule }, "stale allow-list entry \(path): \(rule)")
      }
    }
  }

  actor FakeRemover: GatewayListSync {
    var calls: [String] = []
    func removeGateway(id: String, scope: RemovalScope) async throws {
      calls.append("\(id):\(scope.rawValue)")
    }
    func trigger(_ reason: SyncReason) async {
      calls.append("trigger:\(reason.rawValue)")
    }
  }

  /// Settings removes through `GatewayDirectory`, which removes through the engine (a fake here).
  @MainActor
  @Test func theGatewayListRemovesThroughTheEngine() async throws {
    let database = try SQLiteStore(.inMemory)
    let registry = GatewayRegistryStore(store: database)
    let id = GatewayRegistry.newGatewayId()
    try await registry.add(GatewayRecord(id: id, name: "Home", address: "https://gateway.test", authKind: .sessionToken, addedAt: 0))
    let remover = FakeRemover()
    let directory = GatewayDirectory(store: registry, changes: KeyValueStore(store: database), remover: remover)

    try await directory.remove(id: id)
    try await directory.remove(id: id, scope: .allDevices)
    await directory.settingsOpened()

    #expect(await remover.calls == ["\(id):thisDevice", "\(id):allDevices", "trigger:settingsOpened"])
    // The fake removed nothing, and the list did not either.
    #expect(try await registry.load().gateway(id: id) != nil)
  }

  @Test func theRulesCatchWhatTheyAreFor() throws {
    let samples = [
      "try GatewaySecrets.clearCredentials(storage: storage, keys: keys)",
      "try await credentials.signOut()",
      "let registry = GatewayRegistryStore(store: store)",
      "try await directory.store.remove(id: id)",
      "try await registry.update { $0 }",
      "try GatewayRegistryStore.purge(gatewayId: id, in: db)",
      "try db.kvSet(text, forKey: StoreKeys.gateways)",
      "try secrets.set(try SecretKeys.gateway(id).sessionToken, token)",
      "try secrets.delete(keys.frontDoor)",
      "let tokens = SecretTokenStore(storage: storage, keys: keys)"
    ]
    for sample in ["try await store.remove(gatewayId: id)", "try secrets.set(SecretKeys.shareDelivery, record)"] {
      let range = NSRange(sample.startIndex..., in: sample)
      let caught = try Self.rules.contains { try NSRegularExpression(pattern: $0.pattern).firstMatch(in: sample, range: range) != nil }
      #expect(!caught, "\(sample)")
    }
    for sample in samples {
      let range = NSRange(sample.startIndex..., in: sample)
      let caught = try Self.rules.contains { try NSRegularExpression(pattern: $0.pattern).firstMatch(in: sample, range: range) != nil }
      #expect(caught, "\(sample)")
    }
  }
}
