import Foundation
import Testing

@testable import HermieShared

/// `Fixtures/widget-snapshot-ts-writer.json`: `JSON.stringify(projectWidgetSnapshot(...))`, written
/// by the TypeScript writer in `expo/hermie/src/features/widgets/snapshot.ts`.
private let sampleURL = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .appendingPathComponent("Fixtures/widget-snapshot-ts-writer.json")

/**
 The decoder the Expo widget extension ships today, copied from `HermieWidgetSnapshot.swift`:
 synthesised `Decodable`, every non-optional field required. Whatever the native app writes has to
 decode with this, because an installed widget binary is updated after the app, not with it.
 */
private struct ShippedSnapshot: Decodable {
  let version: Int
  let generatedAt: Double
  let bots: [ShippedBot]
  let folders: [ShippedFolder]?
  let gatewayKey: String?
}

private struct ShippedFolder: Decodable {
  let id: String
  let name: String
  let colour: String?
  let bots: [String]
  let unread: Int
  let needsInput: Int
  let size: Int
}

private struct ShippedBot: Decodable {
  let name: String
  let displayName: String
  let avatarPath: String?
  let initials: String
  let colour: String
  let presence: String
  let lastLine: String
  let lastAt: Double
  let unread: Int
  let needsInput: Bool
  var gatewayKey: String?
}

@Suite("Widget snapshot")
struct WidgetSnapshotTests {
  private func sample() throws -> Data {
    try Data(contentsOf: sampleURL)
  }

  @Test("decodes what the TypeScript writer wrote")
  func decodesTypeScript() throws {
    let snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: try sample())

    #expect(snapshot.isUsable)
    #expect(snapshot.generatedAt == 1_770_000_200_000)
    #expect(snapshot.gatewayKey == "50696704682b12da")
    #expect(snapshot.bots.map(\.name) == ["researcher", "code reviewer", "writer"])
    #expect(snapshot.bots[0].avatarPath == "avatars/researcher.png")
    #expect(snapshot.bots[0].lastAt == 1_770_000_100.5)
    #expect(snapshot.bots[0].presence == "working")
    #expect(snapshot.bots[1].avatarPath == nil)
    #expect(snapshot.folders?.first?.colour == "#14828C")
    #expect(snapshot.folders?.last?.colour == nil)
    let work = try #require(snapshot.folder(id: "fwork1"))

    #expect(snapshot.bots(in: work).map(\.name) == ["researcher", "code reviewer"])
    #expect(snapshot.needsInputCount == 0)
  }

  @Test("encodes back to the same JSON the TypeScript writer produced")
  func encodesLikeTypeScript() throws {
    let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: try sample())
    let ours = try JSONSerialization.jsonObject(with: try decoded.encoded()) as? NSDictionary
    let theirs = try JSONSerialization.jsonObject(with: try sample()) as? NSDictionary

    #expect(ours == theirs)
    #expect(try JSONDecoder().decode(WidgetSnapshot.self, from: try decoded.encoded()) == decoded)
  }

  @Test("what Swift writes decodes with the widget decoder that ships today")
  func shippedDecoderReadsOurs() throws {
    let snapshot = WidgetSnapshot(
      generatedAt: 1_770_000_000_000,
      gatewayKey: "bf796761db84e312",
      bots: [
        WidgetSnapshot.Bot(
          name: "researcher", displayName: "Research", initials: "R", colour: "#2A72DC", presence: "online",
          lastLine: "Done ✓", lastAt: 1_770_000_000, unread: 1, needsInput: true
        )
      ],
      folders: nil
    )
    let shipped = try JSONDecoder().decode(ShippedSnapshot.self, from: try snapshot.encoded())

    #expect(shipped.version == 1)
    #expect(shipped.bots.first?.needsInput == true)
    #expect(shipped.bots.first?.avatarPath == nil)
    #expect(shipped.folders?.isEmpty == true)
    #expect(shipped.gatewayKey == "bf796761db84e312")
  }

  @Test("another version is no snapshot; missing fields default")
  func tolerance() throws {
    #expect(WidgetSnapshot.decodeUsable(Data(#"{"version":2,"generatedAt":0,"bots":[]}"#.utf8)) == nil)
    #expect(WidgetSnapshot.decodeUsable(Data("not json".utf8)) == nil)

    let sparseJSON = #"{"version":1,"bots":[{"name":"writer"}],"extra":1}"#
    let sparse = try #require(WidgetSnapshot.decodeUsable(Data(sparseJSON.utf8)))

    #expect(sparse.bots.first?.displayName == "writer")
    #expect(sparse.bots.first?.unread == 0)
    #expect(sparse.folders == nil)
  }

  @Test("a valid gateway key is stamped on every row and lands in its tap")
  func stamping() throws {
    let snapshot = try #require(WidgetSnapshot.decodeUsable(try sample()))

    #expect(snapshot.bots.allSatisfy { $0.gatewayKey == "50696704682b12da" })
    #expect(snapshot.bots[1].chatURL?.absoluteString == "hermie://chat/code%20reviewer?gateway=50696704682b12da")
    #expect(snapshot.folders?.first?.listURL?.absoluteString == "hermie://folder/fwork1")

    var bad = snapshot

    bad.gatewayKey = "NOT-HEX"
    bad.bots = bad.bots.map { var row = $0; row.gatewayKey = nil; return row }

    #expect(bad.stampingGatewayKey().bots.allSatisfy { $0.gatewayKey == nil })
    #expect(bad.stampingGatewayKey().bots[0].chatURL?.absoluteString == "hermie://chat/researcher")
  }
}
