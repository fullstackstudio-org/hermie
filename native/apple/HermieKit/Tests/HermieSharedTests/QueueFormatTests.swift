import Foundation
import Testing

@testable import HermieShared

/// `JSON.stringify` of `Fixtures/widget-snapshot-ts-writer.json`: the exact bytes the Expo app's
/// TypeScript writer puts into `widget-snapshot.json`.
let typeScriptSnapshotBytes =
  ##"{"version":1,"generatedAt":1770000200000,"gatewayKey":"50696704682b12da","bots":[{"name":"researcher","displayName":"researcher","avatarPath":"avatars/researcher.png","initials":"R","colour":"#2A72DC","presence":"working","lastLine":"","lastAt":1770000100.5,"unread":2,"needsInput":false},{"name":"code reviewer","displayName":"code reviewer","initials":"C","colour":"#2A72DC","presence":"online","lastLine":"","lastAt":1769999000,"unread":1,"needsInput":false},{"name":"writer","displayName":"writer","initials":"W","colour":"#8244CE","presence":"online","lastLine":"","lastAt":1700,"unread":0,"needsInput":false}],"folders":[{"id":"fwork1","name":"Work","colour":"#14828C","bots":["researcher","code reviewer"],"unread":3,"needsInput":0,"size":2},{"id":"fplain","name":"Plain","bots":["writer"],"unread":0,"needsInput":0,"size":1}]}"##

@Suite("Extension file formats")
struct QueueFormatTests {
  @Test("a snapshot read from the TypeScript writer's bytes encodes back to the same bytes")
  func snapshotByteRoundTrip() throws {
    let snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(typeScriptSnapshotBytes.utf8))

    #expect(String(decoding: try snapshot.encoded(), as: UTF8.self) == typeScriptSnapshotBytes)
  }

  @Test("the shared container's names are the Expo modules' names")
  func containerNames() {
    #expect(SharedContainer.appGroup == "group.dev.hermie.app")
    #expect(SharedContainer.widgetSnapshotFile == "widget-snapshot.json")
    #expect(SharedContainer.shareTargetsFile == "share-targets.json")
    #expect(SharedContainer.shareOutboxDirectory == "share-outbox")
    #expect(SharedContainer.intentsDirectory == "intents")

    let root = URL(fileURLWithPath: "/tmp/group")

    #expect(SharedContainer.resolve("avatars/a%20b.png", in: root)?.path == "/tmp/group/avatars/a%20b.png")
    #expect(SharedContainer.resolve("../outside.png", in: root) == nil)
    #expect(SharedContainer.resolve("avatars/../../x", in: root) == nil)
    #expect(SharedContainer.resolve("/etc/hosts", in: root) == nil)
    #expect(SharedContainer.resolve(nil, in: root) == nil)
  }

  @Test("a pending share resolves its files, keeps the claim apart and builds the message")
  func pendingShare() throws {
    let manifest = #"""
      {"version":1,"id":"abc123","bot":"researcher","note":"  look  ","createdAt":1770000000,
       "items":[{"kind":"file","path":"report.pdf","filename":"report.pdf","size":12,"mimeType":"application/pdf"},
                {"kind":"image","path":"gone.png","filename":"gone.png","size":3},
                {"kind":"url","text":" https://example.org/a "},
                {"kind":"text","text":"second"},
                {"kind":"video","path":"x.mov"}]}
      """#
    let url = URL(fileURLWithPath: "/tmp/outbox/abc123/report.pdf")
    let share = try #require(
      PendingShare.parse(id: "abc123", manifest: Data(manifest.utf8), claim: nil, files: ["report.pdf": url])
    )

    #expect(share.bot == "researcher")
    #expect(share.claim == nil)
    #expect(
      share.items == [
        .file(kind: .file, url: url, filename: "report.pdf", size: 12, mimeType: "application/pdf"),
        .words(kind: .url, text: "https://example.org/a"),
        .words(kind: .text, text: "second")
      ])
    #expect(share.messageText == "look\n\nhttps://example.org/a\n\nsecond")
    #expect(share.files.count == 1)

    // The directory name and the manifest's id must agree.
    #expect(PendingShare.parse(id: "other", manifest: Data(manifest.utf8), claim: nil, files: [:]) == nil)

    // A claim is a claim even when it cannot be read.
    let claimed = PendingShare.parse(id: "abc123", manifest: Data(manifest.utf8), claim: Data(), files: [:])

    #expect(claimed?.claim == ShareClaim(bot: "", at: 0))
    #expect(
      PendingShare.parse(
        id: "abc123", manifest: Data(manifest.utf8), claim: Data(#"{"version":1,"bot":"writer","at":5}"#.utf8),
        files: [:]
      )?.claim == ShareClaim(bot: "writer", at: 5))
  }

  @Test("a share with nothing left is no share, and shares sort oldest first")
  func emptyShareAndOrder() {
    let onlyGone = #"{"version":1,"id":"a1","note":" ","createdAt":1,"items":[{"kind":"file","path":"gone.bin"}]}"#

    #expect(PendingShare.parse(id: "a1", manifest: Data(onlyGone.utf8), claim: nil, files: [:]) == nil)

    let shares = [
      PendingShare(id: "b", bot: nil, note: "x", createdAt: 2, items: [], claim: nil),
      PendingShare(id: "c", bot: nil, note: "x", createdAt: 1, items: [], claim: nil),
      PendingShare(id: "a", bot: nil, note: "x", createdAt: 2, items: [], claim: nil)
    ]

    #expect(PendingShare.sorted(shares).map(\.id) == ["c", "a", "b"])
  }

  @Test("share targets: built like buildShareTargets, written like JSON.stringify, read tolerantly")
  func shareTargets() throws {
    let copy = ShareTargets.Copy(sent: "Sent to {bot}", queued: "Later", sending: "Sending…")
    let targets = ShareTargets.build(
      bots: [("researcher", "s1"), ("researcher", "s2"), ("", "s3"), ("writer", ""), ("coder", "s4")],
      copy: copy,
      gatewayKey: "50696704682b12da",
      now: Date(timeIntervalSince1970: 1_770_000_000.9)
    )

    #expect(targets.targets == [.init(bot: "researcher", session: "s1"), .init(bot: "coder", session: "s4")])
    #expect(targets.generatedAt == 1_770_000_000)
    #expect(targets.session(for: "coder") == "s4")
    #expect(targets.session(for: "writer") == nil)
    #expect(
      String(decoding: targets.encoded(), as: UTF8.self)
        == #"{"version":1,"generatedAt":1770000000,"gatewayKey":"50696704682b12da","copy":{"sent":"Sent to {bot}","queued":"Later","sending":"Sending…"},"targets":[{"bot":"researcher","session":"s1"},{"bot":"coder","session":"s4"}]}"#
    )
    #expect(ShareTargets.parse(targets.encoded()) == targets)

    let many = ShareTargets.build(
      bots: (0..<30).map { ("bot\($0)", "s\($0)") }, copy: copy, gatewayKey: "", now: Date())

    #expect(many.targets.count == ShareTargets.limit)
    #expect(many.gatewayKey == nil)

    let sparse = try #require(
      ShareTargets.parse(Data(#"{"version":1,"targets":[{"bot":"a"},{"bot":"b","session":"s"},7]}"#.utf8)))

    #expect(sparse.targets == [.init(bot: "b", session: "s")])
    #expect(sparse.copy == .init(sent: "", queued: "", sending: ""))
    #expect(ShareTargets.parse(Data(#"{"version":2,"targets":[]}"#.utf8)) == nil)
  }

  @Test("pending intents parse like parsePendingIntent and expire after the budget")
  func pendingIntents() throws {
    let json = #"{"version":1,"id":"req1","kind":"ask","bot":"researcher","text":"hi","createdAt":1770000000000}"#
    let intent = try #require(PendingIntent.parse(Data(json.utf8)))

    #expect(intent == PendingIntent(id: "req1", kind: .ask, bot: "researcher", text: "hi", createdAt: 1_770_000_000_000))
    #expect(PendingIntent.parse(intent.encoded()) == intent)
    #expect(!intent.isExpired(now: Date(timeIntervalSince1970: 1_770_000_045)))
    #expect(intent.isExpired(now: Date(timeIntervalSince1970: 1_770_000_045.001)))

    for bad in [
      #"{"version":2,"id":"req1","kind":"ask","bot":"b","text":"hi"}"#,
      #"{"version":1,"id":"../x","kind":"ask","bot":"b","text":"hi"}"#,
      #"{"version":1,"id":"req1","kind":"shout","bot":"b","text":"hi"}"#,
      #"{"version":1,"id":"req1","kind":"send","bot":"","text":"hi"}"#,
      #"{"version":1,"id":"req1","kind":"send","bot":"b","text":"  "}"#,
      "not json"
    ] {
      #expect(PendingIntent.parse(Data(bad.utf8)) == nil, "\(bad)")
    }

    #expect(
      String(decoding: IntentResult.reply(id: "req1", "Done").encoded(), as: UTF8.self)
        == #"{"version":1,"id":"req1","ok":true,"reply":"Done"}"#)
    #expect(
      String(decoding: IntentResult.failure(id: "req1", "No").encoded(), as: UTF8.self)
        == #"{"version":1,"id":"req1","ok":false,"error":"No"}"#)
  }

  @Test("the delivery record is built, written and read like delivery-credential.ts")
  func deliveryRecord() throws {
    let record = try #require(
      ShareDeliveryRecord.build(
        gatewayId: "g1", gatewayKey: "50696704682b12da", baseUrl: "https://gateway.example", authMode: "session_token",
        headers: ["x-front": "door"], sessionToken: "tok", accessToken: nil, expiresAt: 99
      ))

    #expect(record.authHeader == .sessionToken)
    #expect(record.expiresAt == 0)
    #expect(
      record.encodedString()
        == #"{"version":1,"gatewayId":"g1","gatewayKey":"50696704682b12da","baseUrl":"https://gateway.example","authMode":"session_token","authHeader":"x-hermes-session-token","token":"tok","expiresAt":0,"headers":{"x-front":"door"}}"#
    )
    #expect(ShareDeliveryRecord.parse(record.encodedString()) == record)

    let pkce = try #require(
      ShareDeliveryRecord.build(
        gatewayId: "g2", gatewayKey: "", baseUrl: "https://gateway.example", authMode: "native_pkce", headers: [:],
        sessionToken: nil, accessToken: "bearer", expiresAt: 1_770_000_000
      ))

    #expect(pkce.authHeader == .authorization)
    #expect(pkce.isExpired(now: Date(timeIntervalSince1970: 1_769_999_940)))
    #expect(!pkce.isExpired(now: Date(timeIntervalSince1970: 1_769_999_939)))
    #expect(!record.isExpired(now: .distantFuture))

    // No credential, the cookie flow, or no address: nothing to publish.
    #expect(
      ShareDeliveryRecord.build(
        gatewayId: "g", gatewayKey: "", baseUrl: "https://a", authMode: "session_token", headers: [:],
        sessionToken: "", accessToken: nil, expiresAt: 0) == nil)
    #expect(
      ShareDeliveryRecord.build(
        gatewayId: "g", gatewayKey: "", baseUrl: "https://a", authMode: "cookie", headers: [:],
        sessionToken: "t", accessToken: "t", expiresAt: 0) == nil)
    #expect(
      ShareDeliveryRecord.build(
        gatewayId: "g", gatewayKey: "", baseUrl: "", authMode: "session_token", headers: [:],
        sessionToken: "t", accessToken: nil, expiresAt: 0) == nil)

    // What the Expo app wrote reads the same; odd fields are repaired, other versions refused.
    let expo =
      #"{"version":1,"gatewayId":"g3","gatewayKey":"k","baseUrl":"http://h","authMode":"native_pkce","authHeader":"weird","token":"t","expiresAt":"soon","headers":{"a":"b","n":1}}"#
    let parsed = try #require(ShareDeliveryRecord.parse(expo))

    #expect(parsed.authHeader == .authorization)
    #expect(parsed.expiresAt == 0)
    #expect(parsed.headers == ["a": "b"])
    #expect(ShareDeliveryRecord.parse(#"{"version":2,"authMode":"native_pkce"}"#) == nil)
    #expect(ShareDeliveryRecord.parse(#"{"version":1,"authMode":"cookie"}"#) == nil)
    #expect(ShareDeliveryRecord.parse(nil) == nil)
  }
}
