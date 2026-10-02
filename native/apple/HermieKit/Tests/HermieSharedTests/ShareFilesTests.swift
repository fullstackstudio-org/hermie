import Foundation
import Testing

@testable import HermieShared

@Suite("Share and intent files")
struct ShareFilesTests {
  @Test("a manifest as the share extension writes it decodes")
  func manifest() throws {
    // The dictionary `HermieShareOutbox.write` serialises with JSONSerialization.
    let written: [String: Any] = [
      "version": 1,
      "id": "0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f",
      "note": "Look at this",
      "createdAt": 1_770_000_000,
      "bot": "researcher",
      "items": [
        ["kind": "image", "path": "IMG_0001.jpg", "filename": "IMG_0001.jpg", "size": 1_024, "mimeType": "image/jpeg"],
        ["kind": "url", "text": "https://example.test/a"]
      ]
    ]
    let data = try JSONSerialization.data(withJSONObject: written)
    let manifest = try JSONDecoder().decode(ShareManifest.self, from: data)

    #expect(manifest.bot == "researcher")
    #expect(manifest.items.map(\.kind) == [.image, .url])
    #expect(manifest.items[0].size == 1_024)
    #expect(manifest.items[1].text == "https://example.test/a")
    #expect(Identifiers.isSafeShareId(manifest.id))
  }

  @Test("claims, targets and intent files round trip in the TypeScript shapes")
  func otherFiles() throws {
    let claimJSON = #"{"version":1,"bot":"writer","at":1770000000}"#
    let claim = try JSONDecoder().decode(ShareClaim.self, from: Data(claimJSON.utf8))

    #expect(claim == ShareClaim(bot: "writer", at: 1_770_000_000))

    let targetsJSON = """
      {"version":1,"generatedAt":1770000000000,"gatewayKey":"bf796761db84e312",
       "copy":{"sent":"Sent to {bot}","queued":"Queued","sending":"Sending…"},
       "targets":[{"bot":"researcher","session":"s-123"}]}
      """
    let targets = try JSONDecoder().decode(ShareTargets.self, from: Data(targetsJSON.utf8))

    #expect(targets.targets == [ShareTargets.Target(bot: "researcher", session: "s-123")])
    #expect(targets.copy.sent.contains(ShareTargets.botPlaceholder))

    // `intentReply` and `intentFailure` in queue.ts.
    let replyJSON = #"{"version":1,"id":"r1","ok":true,"reply":"Hi"}"#
    let reply = try JSONDecoder().decode(IntentResult.self, from: Data(replyJSON.utf8))

    #expect(reply == .reply(id: "r1", "Hi"))

    let pending = PendingIntent(id: "r1", kind: .ask, bot: "researcher", text: "Hello?", createdAt: 1_770_000_000_000)
    let decoded = try JSONDecoder().decode(PendingIntent.self, from: try JSONEncoder().encode(pending))

    #expect(decoded == pending)
    #expect(PendingIntent.budget == .seconds(45))
  }

  @Test("the id alphabets match the TypeScript checks")
  func identifiers() {
    #expect(Identifiers.isSafeShareId("a.b-c_d"))
    #expect(!Identifiers.isSafeShareId(".hidden"))
    #expect(!Identifiers.isSafeShareId(String(repeating: "a", count: 65)))
    #expect(Identifiers.isSafeShareId(String(repeating: "a", count: 64)))
    #expect(!Identifiers.isSafeShareId("a b"))
    #expect(Identifiers.isSafeFolderId("fm4k2a1"))
    #expect(!Identifiers.isSafeFolderId("a.b"))
    #expect(!Identifiers.isSafeFolderId(""))
    #expect(Identifiers.isGatewayKey("bf796761db84e312"))
    #expect(!Identifiers.isGatewayKey("bf796761db84e31g"))
  }
}
