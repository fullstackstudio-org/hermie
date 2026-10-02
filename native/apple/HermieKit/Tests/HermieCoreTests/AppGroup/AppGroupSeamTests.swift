import Foundation
import HermieShared
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A container in a fresh temporary directory, removed when the test ends.
private final class Container {
  let root: URL
  let group: AppGroupContainer

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-group-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    group = AppGroupContainer(url: root)
  }

  deinit {
    try? FileManager.default.removeItem(at: root)
  }

  func write(_ text: String, to relative: String) throws {
    let url = root.appendingPathComponent(relative)

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
  }

  func exists(_ relative: String) -> Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
  }

  func text(_ relative: String) -> String? {
    (try? Data(contentsOf: root.appendingPathComponent(relative))).map { String(decoding: $0, as: UTF8.self) }
  }
}

private let snapshot = WidgetSnapshot(
  generatedAt: 1_770_000_000_000,
  gatewayKey: "50696704682b12da",
  bots: [
    WidgetSnapshot.Bot(
      name: "researcher", displayName: "Research", avatarPath: AppGroupContainer.avatarPath(forBot: "researcher"),
      initials: "R", colour: "#2A72DC", presence: "online", lastLine: "Done", lastAt: 1_770_000_000, unread: 1,
      needsInput: true
    )
  ],
  folders: []
)

@Suite("App Group seams")
struct AppGroupSeamTests {
  @Test("HermieShared and HermieStore name the same container and files")
  func sameNames() {
    #expect(SharedContainer.appGroup == AppGroupContainer.identifier)
    #expect(SharedContainer.widgetSnapshotFile == AppGroupContainer.widgetSnapshotFile)
    #expect(SharedContainer.shareTargetsFile == AppGroupContainer.shareTargetsFile)
    #expect(SharedContainer.shareOutboxDirectory == AppGroupContainer.shareOutboxDirectory)
    #expect(SharedContainer.shareManifestFile == AppGroupContainer.shareManifestFile)
    #expect(SharedContainer.shareClaimFile == AppGroupContainer.shareClaimFile)
    #expect(SharedContainer.intentsDirectory == AppGroupContainer.intentsDirectory)
    #expect(SharedContainer.intentsPendingDirectory == AppGroupContainer.intentsPendingDirectory)
    #expect(SharedContainer.intentsResultsDirectory == AppGroupContainer.intentsResultsDirectory)
  }

  // MARK: Widget snapshot

  @Test("the snapshot is written as the widgets read it, and only a change reloads them")
  func widgetSnapshot() throws {
    let container = try Container()
    let reloads = Mutex(0)
    let writer = WidgetSnapshotWriter(container: container.group) { reloads.withLock { $0 += 1 } }

    #expect(writer.write(snapshot))
    #expect(reloads.withLock { $0 } == 1)
    #expect(container.text("widget-snapshot.json") == String(decoding: try snapshot.encoded(), as: UTF8.self))

    let read = try #require(
      WidgetSnapshot.decodeUsable(try Data(contentsOf: container.group.widgetSnapshotURL)))

    #expect(read.bots.first?.chatURL?.absoluteString == "hermie://chat/researcher?gateway=50696704682b12da")

    // The same bytes again: nothing written, nothing reloaded.
    #expect(writer.write(snapshot))
    #expect(reloads.withLock { $0 } == 1)

    var changed = snapshot

    changed.generatedAt += 1

    #expect(writer.write(changed))
    #expect(reloads.withLock { $0 } == 2)
  }

  @Test("the writer's bytes are the TypeScript writer's bytes")
  func widgetSnapshotBytes() throws {
    let container = try Container()
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("HermieSharedTests/Fixtures/widget-snapshot-ts-writer.json")
    let pretty = try Data(contentsOf: fixture)
    let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: pretty)
    let writer = WidgetSnapshotWriter(container: container.group) {}

    #expect(writer.write(decoded))

    let written = try #require(container.text("widget-snapshot.json"))

    // `JSON.stringify(JSON.parse(fixture))`, which is what the Expo app wrote for this snapshot.
    let stringified = try JSONSerialization.jsonObject(with: pretty) as? NSDictionary
    let ours = try JSONSerialization.jsonObject(with: Data(written.utf8)) as? NSDictionary

    #expect(ours == stringified)
    #expect(written.hasPrefix(#"{"version":1,"generatedAt":1770000200000,"gatewayKey":"50696704682b12da","bots":[{"name":"researcher","displayName":"researcher","avatarPath":"avatars/researcher.png","initials":"R""#))
    #expect(!written.contains(" :") && !written.contains("\n") && !written.contains("\\/"))
  }

  @Test("avatars are written beside the snapshot and pruned to the roster")
  func avatars() throws {
    let container = try Container()
    let writer = WidgetSnapshotWriter(container: container.group) {}

    #expect(writer.writeAvatar(Data([1, 2, 3]), forBot: "researcher"))
    #expect(writer.writeAvatar(Data([4]), forBot: "code reviewer"))
    #expect(!writer.writeAvatar(Data(), forBot: "empty"))
    #expect(container.exists("avatars/researcher.png"))
    #expect(container.exists("avatars/code%20reviewer.png"))
    #expect(writer.pruneAvatars(keeping: ["code reviewer"]) == 1)
    #expect(!container.exists("avatars/researcher.png"))
    #expect(container.exists("avatars/code%20reviewer.png"))
  }

  // MARK: Share outbox

  @Test("the outbox hands over readable shares oldest first and removes only what was done")
  func shareOutbox() async throws {
    let container = try Container()
    let outbox = AppGroupShareOutbox(container: container.group)

    try container.write(
      #"{"version":1,"id":"newer","bot":"researcher","note":"hello","createdAt":20,"items":[{"kind":"file","path":"a.pdf","filename":"a.pdf","size":3}]}"#,
      to: "share-outbox/newer/manifest.json")
    try container.write("pdf", to: "share-outbox/newer/a.pdf")
    try container.write(
      #"{"version":1,"id":"older","note":"","createdAt":10,"items":[{"kind":"url","text":"https://example.org"}]}"#,
      to: "share-outbox/older/manifest.json")
    try container.write(#"{"version":1,"bot":"writer","at":11}"#, to: "share-outbox/older/claim.json")
    try container.write(
      #"{"version":1,"id":"kept","note":"later","createdAt":30,"items":[]}"#, to: "share-outbox/kept/manifest.json")
    // Still being written by the extension: a directory with no manifest yet.
    try container.write("partial", to: "share-outbox/writing/photo.jpg")
    // A newer build's entry: skipped, not deleted.
    try container.write(#"{"version":9,"id":"future","note":"x"}"#, to: "share-outbox/future/manifest.json")

    let pending = outbox.pending()

    #expect(pending.map(\.id) == ["older", "newer", "kept"])
    #expect(pending[0].claim == ShareClaim(bot: "writer", at: 11))
    #expect(pending[1].claim == nil)
    #expect(
      pending[1].items == [
        .file(
          kind: .file, url: container.group.shareOutboxURL.appendingPathComponent("newer/a.pdf"),
          filename: "a.pdf", size: 3, mimeType: PendingShare.fallbackMimeType)
      ])

    let seen = Mutex<[String]>([])
    let decisions = await outbox.drain { share in
      seen.withLock { $0.append(share.id) }

      switch share.id {
      case "older": return .keep  // claimed: the person is asked first
      case "newer": return .delivered
      default: return .discard
      }
    }

    #expect(seen.withLock { $0 } == ["older", "newer", "kept"])
    #expect(decisions == ["older": .keep, "newer": .delivered, "kept": .discard])
    #expect(container.exists("share-outbox/older/claim.json"))
    #expect(!container.exists("share-outbox/newer"))
    #expect(!container.exists("share-outbox/kept"))
    #expect(container.exists("share-outbox/writing/photo.jpg"))
    #expect(container.exists("share-outbox/future/manifest.json"))
    #expect(!outbox.remove(id: ".."))
    #expect(!outbox.remove(id: "missing"))
    #expect(outbox.remove(id: "older"))
  }

  @Test("an empty outbox, or none at all, hands over nothing")
  func emptyOutbox() async throws {
    let container = try Container()
    let outbox = AppGroupShareOutbox(container: container.group)

    #expect(outbox.pending().isEmpty)
    #expect(await outbox.drain { _ in .delivered }.isEmpty)
  }

  @Test("share targets are written where the extension reads them")
  func shareTargets() throws {
    let container = try Container()
    let targets = ShareTargets.build(
      bots: [("researcher", "s1")],
      copy: .init(sent: "Verstuurd naar {bot}", queued: "Later", sending: "Bezig…"),
      gatewayKey: "50696704682b12da",
      now: Date(timeIntervalSince1970: 1_770_000_000)
    )

    #expect(ShareTargetsWriter(container: container.group).write(targets))
    #expect(ShareTargets.parse(try Data(contentsOf: container.group.shareTargetsURL)) == targets)
  }

  // MARK: Intent queue

  @Test("the queue answers every request: run, expired or unreadable, and leaves the ones not ready")
  func intentQueue() async throws {
    let container = try Container()
    let queue = AppGroupIntentQueue(container: container.group)
    let now = Date(timeIntervalSince1970: 1_770_000_100)

    try container.write(
      #"{"version":1,"id":"ask1","kind":"ask","bot":"researcher","text":"hi","createdAt":1770000090000}"#,
      to: "intents/pending/ask1.json")
    try container.write(
      #"{"version":1,"id":"send1","kind":"send","bot":"writer","text":"go","createdAt":1770000080000}"#,
      to: "intents/pending/send1.json")
    try container.write(
      #"{"version":1,"id":"wait1","kind":"send","bot":"slow","text":"later","createdAt":1770000095000}"#,
      to: "intents/pending/wait1.json")
    try container.write(
      #"{"version":1,"id":"old1","kind":"ask","bot":"researcher","text":"hi","createdAt":1770000000000}"#,
      to: "intents/pending/old1.json")
    try container.write(#"{"version":7,"id":"new1"}"#, to: "intents/pending/new1.json")
    // The id inside must be the file's name.
    try container.write(
      #"{"version":1,"id":"other","kind":"ask","bot":"b","text":"t","createdAt":1}"#, to: "intents/pending/liar.json")
    // Still being written: empty, skipped.
    try container.write("", to: "intents/pending/half.json")

    #expect(
      queue.pending().map(\.id) == ["old1", "send1", "ask1", "wait1", "liar", "new1"])

    let asked = Mutex<[String]>([])

    await queue.drain(
      now: now,
      failures: IntentQueueFailures(unreadable: "Cannot read", expired: "Too late")
    ) { intent in
      asked.withLock { $0.append(intent.id) }

      switch intent.kind {
      case .ask: return .reply(id: intent.id, "Hello")
      case .send: return intent.bot == "slow" ? nil : .reply(id: intent.id, "")
      }
    }

    #expect(asked.withLock { $0 } == ["send1", "ask1", "wait1"])
    #expect(container.text("intents/results/ask1.json") == #"{"version":1,"id":"ask1","ok":true,"reply":"Hello"}"#)
    #expect(container.text("intents/results/send1.json") == #"{"version":1,"id":"send1","ok":true,"reply":""}"#)
    #expect(container.text("intents/results/old1.json") == #"{"version":1,"id":"old1","ok":false,"error":"Too late"}"#)
    #expect(
      container.text("intents/results/new1.json") == #"{"version":1,"id":"new1","ok":false,"error":"Cannot read"}"#)
    #expect(
      container.text("intents/results/liar.json") == #"{"version":1,"id":"liar","ok":false,"error":"Cannot read"}"#)
    #expect(!container.exists("intents/results/wait1.json"))
    #expect(container.exists("intents/pending/wait1.json"))
    #expect(container.exists("intents/pending/half.json"))

    for done in ["ask1", "send1", "old1", "new1", "liar"] {
      #expect(!container.exists("intents/pending/\(done).json"), "\(done)")
    }

    // Nothing to answer for a request that is not there, or a name that is not one.
    #expect(!queue.complete(id: "ask1", with: .reply(id: "ask1", "again")))
    #expect(!queue.complete(id: "../x", with: .reply(id: "x", "")))
  }

  // MARK: Delivery record

  @Test("the delivery record is published, refreshed and dropped per gateway")
  func deliveryRecord() throws {
    let store = InMemorySecretStore()
    let publisher = ShareDeliveryPublisher(store: store)
    let record = { (gateway: String, token: String) in
      ShareDeliveryRecord.build(
        gatewayId: gateway, gatewayKey: "50696704682b12da", baseUrl: "https://gateway.example",
        authMode: "native_pkce", headers: ["x-front": "door"], sessionToken: nil, accessToken: token,
        expiresAt: 1_770_000_000)!
    }

    #expect(publisher.publishedGatewayId() == nil)
    #expect(publisher.publish(record("g1", "t1")))
    #expect(try store.get(SecretKeys.shareDelivery) == record("g1", "t1").encodedString())
    #expect(publisher.publishedGatewayId() == "g1")

    // A rotation on another gateway does not take the active one's record away.
    #expect(!publisher.refresh(record("g2", "t2")))
    #expect(ShareDeliveryRecord.parse(try store.get(SecretKeys.shareDelivery))?.token == "t1")

    // A rotation on the published gateway replaces it.
    #expect(publisher.refresh(record("g1", "t3")))
    #expect(ShareDeliveryRecord.parse(try store.get(SecretKeys.shareDelivery))?.token == "t3")

    // Signing out of another gateway leaves it; signing out of this one removes it.
    #expect(!publisher.drop(gatewayId: "g2"))
    #expect(publisher.drop(gatewayId: "g1"))
    #expect(try store.get(SecretKeys.shareDelivery) == nil)

    // After a sign-out, a rotation publishes again.
    #expect(publisher.refresh(record("g2", "t4")))
    #expect(publisher.publishedGatewayId() == "g2")

    // Nothing active: the record goes.
    #expect(publisher.publish(nil))
    #expect(store.count == 0)
  }

  @Test("a store that refuses is reported, never thrown")
  func refusingStore() {
    let publisher = ShareDeliveryPublisher(store: RefusingStore())

    #expect(!publisher.publish(nil))
    #expect(publisher.publishedGatewayId() == nil)
    #expect(!publisher.drop(gatewayId: "g1"))
  }

  // MARK: Spotlight

  @Test("Spotlight rows are the chat links, with the handle as a keyword")
  func spotlight() {
    let entries = BotSpotlightIndex.entries(for: snapshot.bots + [
      WidgetSnapshot.Bot(
        name: "code reviewer", displayName: "", initials: "C", colour: "", presence: "", lastLine: "", lastAt: 0,
        unread: 0, needsInput: false)
    ])

    #expect(
      entries == [
        .init(
          identifier: "hermie://chat/researcher", title: "Research", subtitle: "Done",
          keywords: ["researcher", "Research"]),
        .init(
          identifier: "hermie://chat/code%20reviewer", title: "code reviewer", subtitle: "",
          keywords: ["code reviewer", "code reviewer"])
      ])
    #expect(entries.allSatisfy { DeepLink($0.identifier) != nil })
  }
}

private struct RefusingStore: SecretStore {
  func get(_ key: String) throws -> String? { throw SecretStoreError.interactionNotAllowed }
  func set(_ key: String, _ value: String) throws { throw SecretStoreError.interactionNotAllowed }
  func delete(_ key: String) throws { throw SecretStoreError.interactionNotAllowed }
}
