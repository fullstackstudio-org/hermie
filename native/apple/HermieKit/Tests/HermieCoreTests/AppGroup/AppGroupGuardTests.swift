import Foundation
import HermieShared
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A container in a fresh temporary directory, removed when the test ends.
private final class Group {
  let root: URL
  let container: AppGroupContainer

  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-guard-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    container = AppGroupContainer(url: root)
  }

  deinit {
    try? FileManager.default.removeItem(at: root)
  }

  func write(_ text: String, to relative: String) throws {
    let url = root.appendingPathComponent(relative)

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
  }

  func link(_ relative: String, to destination: URL) throws {
    let url = root.appendingPathComponent(relative)

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: url, withDestinationURL: destination)
  }

  func exists(_ relative: String) -> Bool {
    (try? FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(relative).path)) != nil
  }

  func text(_ relative: String) -> String? {
    (try? Data(contentsOf: root.appendingPathComponent(relative))).map { String(decoding: $0, as: UTF8.self) }
  }

  /// A share for `bot` on `gateway` (nil: an entry from before keys were recorded).
  func share(_ id: String, gateway: String?, createdAt: Int = 10) throws {
    let key = gateway.map { #","gatewayKey":"\#($0)""# } ?? ""

    try write(
      #"{"version":1,"id":"\#(id)","bot":"b"\#(key),"note":"hi","createdAt":\#(createdAt),"items":[]}"#,
      to: "share-outbox/\(id)/manifest.json")
  }

  /// A Shortcut request on `gateway`, made `secondsAgo` before `now`.
  func intent(_ id: String, gateway: String?, now: Date, secondsAgo: Double = 1) throws {
    let key = gateway.map { #","gatewayKey":"\#($0)""# } ?? ""
    let created = Int((now.timeIntervalSince1970 - secondsAgo) * 1000)

    try write(
      #"{"version":1,"id":"\#(id)","kind":"send","bot":"b","text":"go","createdAt":\#(created)\#(key)}"#,
      to: "intents/pending/\(id).json")
  }
}

private let gatewayA = "aaaaaaaaaaaaaaaa"
private let gatewayB = "bbbbbbbbbbbbbbbb"
private let gatewayGone = "cccccccccccccccc"
private let twoGateways = GatewayScope(active: gatewayA, known: [gatewayA, gatewayB])
private let failures = IntentQueueFailures(unreadable: "Unreadable", expired: "Expired", gatewayGone: "Gone")

@Suite("App Group guards")
struct AppGroupGuardTests {
  // MARK: The app lock

  @Test("nothing is drained while the app lock is on, and the lock is on until the app says otherwise")
  func locked() async throws {
    let group = try Group()

    try group.share("s1", gateway: gatewayA)
    try group.intent("i1", gateway: gatewayA, now: Date())

    // The default provider is `SystemSurfaceLock`, which nothing in the tests installs: locked.
    let outbox = AppGroupShareOutbox(container: group.container)
    let queue = AppGroupIntentQueue(container: group.container)
    let handed = Mutex(0)

    #expect(SystemSurfaceLock.isLocked)
    #expect(await outbox.drain(gateways: twoGateways) { _ in handed.withLock { $0 += 1 }; return .delivered }.isEmpty)
    await queue.drain(gateways: twoGateways, failures: failures) { intent in
      handed.withLock { $0 += 1 }
      return .reply(id: intent.id, "")
    }

    #expect(handed.withLock { $0 } == 0)
    #expect(group.exists("share-outbox/s1/manifest.json"))
    #expect(group.exists("intents/pending/i1.json"))
    #expect(!group.exists("intents/results/i1.json"))
  }

  // MARK: Gateways

  @Test("a queued item goes to its own gateway, waits for another configured one, and is purged when its gateway is gone")
  func gatewayRouting() async throws {
    let group = try Group()

    try group.share("active", gateway: gatewayA, createdAt: 1)
    try group.share("other", gateway: gatewayB, createdAt: 2)
    try group.share("gone", gateway: gatewayGone, createdAt: 3)
    try group.share("legacy", gateway: nil, createdAt: 4)

    let outbox = AppGroupShareOutbox(container: group.container) { false }
    let handed = Mutex<[String]>([])
    let outcomes = await outbox.drain(gateways: twoGateways) { share in
      handed.withLock { $0.append(share.id) }
      return .delivered
    }

    #expect(handed.withLock { $0 } == ["active"])
    #expect(
      outcomes == ["active": .handled(.delivered), "other": .otherGateway, "gone": .purged, "legacy": .purged])
    #expect(group.exists("share-outbox/other/manifest.json"))
    #expect(!group.exists("share-outbox/gone"))
    #expect(!group.exists("share-outbox/legacy"))
  }

  @Test("the routing table, and no purge before the app knows its gateways")
  func scope() async throws {
    #expect(twoGateways.route(gatewayA) == .deliver)
    #expect(twoGateways.route(gatewayB) == .wait)
    #expect(twoGateways.route(gatewayGone) == .purge)
    #expect(twoGateways.route(nil) == .purge)
    #expect(GatewayScope(active: gatewayA, known: [gatewayA]).route(nil) == .deliver)
    #expect(GatewayScope(active: nil, known: [gatewayA]).route(nil) == .purge)

    let group = try Group()

    try group.share("s1", gateway: gatewayGone)

    let outbox = AppGroupShareOutbox(container: group.container) { false }

    #expect(await outbox.drain(gateways: GatewayScope(active: nil, known: [])) { _ in .delivered }.isEmpty)
    #expect(group.exists("share-outbox/s1/manifest.json"))
  }

  @Test("a Shortcut request runs only on its own gateway; one whose gateway is gone is answered")
  func intentGateways() async throws {
    let group = try Group()
    let now = Date()

    try group.intent("mine", gateway: gatewayA, now: now)
    try group.intent("theirs", gateway: gatewayB, now: now)
    try group.intent("gone", gateway: gatewayGone, now: now)

    let queue = AppGroupIntentQueue(container: group.container) { false }
    let ran = Mutex<[String]>([])

    await queue.drain(now: now, gateways: twoGateways, failures: failures) { intent in
      ran.withLock { $0.append(intent.id) }
      return .reply(id: intent.id, "")
    }

    #expect(ran.withLock { $0 } == ["mine"])
    #expect(group.exists("intents/pending/theirs.json"))
    #expect(group.text("intents/results/gone.json") == #"{"version":1,"id":"gone","ok":false,"error":"Gone"}"#)
  }

  // MARK: The lease

  @Test("a fresh lease keeps the app off an entry the extension is sending; a stale one does not")
  func lease() async throws {
    let group = try Group()
    let now = Date(timeIntervalSince1970: 1_770_000_000)

    try group.share("fresh", gateway: gatewayA, createdAt: 1)
    try group.write(#"{"version":1,"at":1769999990}"#, to: "share-outbox/fresh/lease.json")
    try group.share("stale", gateway: gatewayA, createdAt: 2)
    try group.write(#"{"version":1,"at":1769999000}"#, to: "share-outbox/stale/lease.json")
    try group.share("torn", gateway: gatewayA, createdAt: 3)
    try group.write("{", to: "share-outbox/torn/lease.json")

    let outbox = AppGroupShareOutbox(container: group.container) { false }
    let outcomes = await outbox.drain(gateways: twoGateways, now: now) { _ in .delivered }

    // A lease that cannot be read is taken as fresh: somebody may be sending it.
    #expect(outcomes == ["fresh": .leased, "stale": .handled(.delivered), "torn": .leased])
    #expect(group.exists("share-outbox/fresh/manifest.json"))
    #expect(outbox.pending().first { $0.id == "fresh" }?.lease?.at == 1_769_999_990)
  }

  // MARK: Two drains at once

  @Test("two drains at once hand each share and each request over once")
  func concurrentDrains() async throws {
    let group = try Group()

    for index in 0..<4 {
      try group.share("s\(index)", gateway: gatewayA, createdAt: index)
      try group.intent("i\(index)", gateway: gatewayA, now: Date())
    }

    let outbox = AppGroupShareOutbox(container: group.container) { false }
    let queue = AppGroupIntentQueue(container: group.container) { false }
    let shares = Mutex<[String]>([])
    let intents = Mutex<[String]>([])

    let handle: @Sendable (PendingShare) async -> ShareDrainDecision = { share in
      shares.withLock { $0.append(share.id) }
      try? await Task.sleep(for: .milliseconds(20))
      return .delivered
    }
    let answer: @Sendable (PendingIntent) async -> IntentResult? = { intent in
      intents.withLock { $0.append(intent.id) }
      try? await Task.sleep(for: .milliseconds(20))
      return .reply(id: intent.id, "")
    }

    async let first = outbox.drain(gateways: twoGateways, handle)
    async let second = outbox.drain(gateways: twoGateways, handle)
    async let third: Void = queue.drain(gateways: twoGateways, failures: failures, answer: answer)
    async let fourth: Void = queue.drain(gateways: twoGateways, failures: failures, answer: answer)

    _ = await (first, second, third, fourth)

    #expect(shares.withLock { $0 }.sorted() == ["s0", "s1", "s2", "s3"])
    #expect(intents.withLock { $0 }.sorted() == ["i0", "i1", "i2", "i3"])
  }

  // MARK: Files that are not what they claim

  @Test("only regular files are listed, a linked manifest is unreadable, and a linked or oversized claim is still a claim")
  func links() async throws {
    let group = try Group()
    let secret = group.root.appendingPathComponent("outside-secret.txt")

    try Data("secret".utf8).write(to: secret)

    // A file in the entry that is a link to something else: never listed, never uploaded.
    try group.write(
      #"{"version":1,"id":"linked","bot":"b","gatewayKey":"\#(gatewayA)","note":"","createdAt":1,"items":[{"kind":"file","path":"a.txt"}]}"#,
      to: "share-outbox/linked/manifest.json")
    try group.link("share-outbox/linked/a.txt", to: secret)

    // A manifest that is a link: removed as unreadable, and the file it pointed at is untouched.
    try group.link("share-outbox/manifestlink/manifest.json", to: secret)

    // A claim that is a link, and one larger than any claim: both still claims.
    try group.share("claimlink", gateway: gatewayA, createdAt: 2)
    try group.link("share-outbox/claimlink/claim.json", to: secret)
    try group.share("bigclaim", gateway: gatewayA, createdAt: 3)
    try group.write(String(repeating: " ", count: AppGroupContainer.maxSmallFileBytes + 1), to: "share-outbox/bigclaim/claim.json")

    let outbox = AppGroupShareOutbox(container: group.container) { false }
    let (shares, unreadable) = outbox.scan(now: Date())

    // The linked file was the share's only item and the note is empty: nothing is left to send.
    #expect(unreadable.sorted() == ["linked", "manifestlink"])
    #expect(shares.first { $0.id == "claimlink" }?.claim == ShareClaim(bot: "", at: 0))
    #expect(shares.first { $0.id == "bigclaim" }?.claim == ShareClaim(bot: "", at: 0))

    _ = await outbox.drain(gateways: twoGateways) { _ in .keep }

    #expect(!group.exists("share-outbox/manifestlink"))
    #expect(FileManager.default.fileExists(atPath: secret.path))
  }

  @Test("an oversized or linked request is answered as unreadable, not run")
  func oversizedIntent() async throws {
    let group = try Group()
    let secret = group.root.appendingPathComponent("outside.json")

    try Data(#"{"version":1,"id":"linked","kind":"send","bot":"b","text":"go","createdAt":1}"#.utf8).write(to: secret)
    try group.write(String(repeating: "x", count: PendingIntent.maxFileBytes + 1), to: "intents/pending/huge.json")
    try group.link("intents/pending/linked.json", to: secret)

    let queue = AppGroupIntentQueue(container: group.container) { false }

    #expect(queue.pending() == [.unreadable(id: "huge"), .unreadable(id: "linked")])
  }

  @Test("answers nobody collected are swept")
  func sweep() async throws {
    let group = try Group()

    try group.write("{}", to: "intents/results/old.json")
    try group.write("{}", to: "intents/results/new.json")
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(-3_600)],
      ofItemAtPath: group.root.appendingPathComponent("intents/results/old.json").path)

    await AppGroupIntentQueue(container: group.container) { false }
      .drain(gateways: twoGateways, failures: failures) { _ in nil }

    #expect(!group.exists("intents/results/old.json"))
    #expect(group.exists("intents/results/new.json"))
  }

  // MARK: Purges

  @Test("signing out of a gateway takes its queued items, snapshot, avatars and targets with it")
  func purges() async throws {
    let group = try Group()
    let now = Date()
    let reloads = Mutex(0)
    let writer = WidgetSnapshotWriter(container: group.container) { reloads.withLock { $0 += 1 } }

    try group.share("a", gateway: gatewayA)
    try group.share("b", gateway: gatewayB)
    try group.intent("ia", gateway: gatewayA, now: now)
    try group.intent("ib", gateway: gatewayB, now: now)

    let outbox = AppGroupShareOutbox(container: group.container) { false }
    let queue = AppGroupIntentQueue(container: group.container) { false }
    let targets = ShareTargetsWriter(container: group.container)

    #expect(writer.write(WidgetSnapshot(generatedAt: 1, gatewayKey: gatewayB, bots: []), hidePreviews: false))
    #expect(writer.writeAvatar(Data([1]), forBot: "b"))
    #expect(targets.write(.build(bots: [("b", "s")], copy: .init(sent: "", queued: "", sending: ""), gatewayKey: gatewayB, now: now)))

    #expect(outbox.purge(gatewayKey: gatewayA) == 1)
    #expect(queue.purge(gatewayKey: gatewayA) == 1)
    #expect(!writer.purge(gatewayKey: gatewayA))
    #expect(!targets.purge(gatewayKey: gatewayA))
    #expect(group.exists("share-outbox/b/manifest.json"))
    #expect(group.exists("intents/pending/ib.json"))
    #expect(group.exists("widget-snapshot.json"))

    #expect(writer.purge(gatewayKey: gatewayB))
    #expect(targets.purge(gatewayKey: gatewayB))
    #expect(!group.exists("widget-snapshot.json"))
    #expect(!group.exists("avatars"))
    #expect(!group.exists("share-targets.json"))
    #expect(reloads.withLock { $0 } == 2)

    #expect(outbox.purgeAll() == 1)
    #expect(queue.purgeAll() == 1)
    #expect(outbox.pending().isEmpty && queue.pending().isEmpty)
  }

  // MARK: Previews

  @Test("with previews hidden, no message text reaches the snapshot")
  func hiddenPreviews() throws {
    let group = try Group()
    let writer = WidgetSnapshotWriter(container: group.container) {}
    let bot = WidgetSnapshot.Bot(
      name: "b", displayName: "B", initials: "B", colour: "", presence: "", lastLine: "the secret plan", lastAt: 0,
      unread: 1, needsInput: false)

    #expect(writer.write(WidgetSnapshot(generatedAt: 1, gatewayKey: gatewayA, bots: [bot]), hidePreviews: true))
    #expect(group.text("widget-snapshot.json")?.contains("secret") == false)
    #expect(group.text("widget-snapshot.json")?.contains(#""lastLine":"""#) == true)
  }

  // MARK: The share keychain group

  @Test("the record goes into the share group's store and the copy in the app's group is deleted")
  func shareGroup() throws {
    let shareGroup = InMemorySecretStore()
    let appGroup = InMemorySecretStore()
    let publisher = ShareDeliveryPublisher(store: shareGroup, legacyStore: appGroup)
    let record = ShareDeliveryRecord.build(
      gatewayId: "g1", gatewayKey: gatewayA, baseUrl: "https://gateway.example", authMode: "session_token",
      headers: [:], sessionToken: "t", accessToken: nil, expiresAt: 0)!

    // What an earlier build left in the app's own group.
    try appGroup.set(SecretKeys.shareDelivery, record.encodedString())
    try appGroup.set("hermie.auth.refresh_token-g1", "refresh")

    #expect(publisher.publishedGatewayId() == "g1")
    #expect(publisher.publish(record))
    #expect(try shareGroup.get(SecretKeys.shareDelivery) == record.encodedString())
    #expect(try appGroup.get(SecretKeys.shareDelivery) == nil)
    // Nothing else in the app's group is touched.
    #expect(try appGroup.get("hermie.auth.refresh_token-g1") == "refresh")
    #expect(shareGroup.count == 1)

    try appGroup.set(SecretKeys.shareDelivery, record.encodedString())

    #expect(publisher.drop(gatewayId: "g1"))
    #expect(shareGroup.count == 0)
    #expect(try appGroup.get(SecretKeys.shareDelivery) == nil)
  }

  @Test("a keychain group is used only with its team prefix")
  func groupNames() {
    let suffix = ShareDeliveryPublisher.shareGroupSuffix

    #expect(ShareDeliveryPublisher.group("ABCDE12345.dev.hermie.app.share", suffix: suffix) == "ABCDE12345.dev.hermie.app.share")
    // An unsigned build expands `$(AppIdentifierPrefix)` to nothing.
    #expect(ShareDeliveryPublisher.group("dev.hermie.app.share", suffix: suffix) == nil)
    #expect(ShareDeliveryPublisher.group(".dev.hermie.app.share", suffix: suffix) == nil)
    #expect(ShareDeliveryPublisher.group("ABCDE12345.dev.hermie.app", suffix: suffix) == nil)
    #expect(ShareDeliveryPublisher.group(nil, suffix: suffix) == nil)
    #expect(ShareDeliveryPublisher.live(bundle: Bundle(for: BundleMarker.self)) == nil)
  }
}

private final class BundleMarker {}
