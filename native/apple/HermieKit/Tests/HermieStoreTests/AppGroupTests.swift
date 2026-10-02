import Foundation
import Testing

@testable import HermieStore

@Suite("App Group container")
struct AppGroupTests {
  @Test("file locations match the names the Expo modules use")
  func locations() throws {
    let container = AppGroupContainer(url: URL(fileURLWithPath: "/tmp/group"))

    #expect(container.widgetSnapshotURL.path == "/tmp/group/widget-snapshot.json")
    #expect(container.shareTargetsURL.path == "/tmp/group/share-targets.json")
    #expect(container.shareOutboxURL.path == "/tmp/group/share-outbox")
    #expect(container.shareEntryURL(id: "0f2a4c6e")?.path == "/tmp/group/share-outbox/0f2a4c6e")
    #expect(container.pendingIntentURL(id: "abc")?.path == "/tmp/group/intents/pending/abc.json")
    #expect(container.intentResultURL(id: "abc")?.path == "/tmp/group/intents/results/abc.json")
    #expect(AppGroupContainer.avatarPath(forBot: "code reviewer") == "avatars/code%20reviewer.png")
    #expect(AppGroupContainer.avatarPath(forBot: "a/b") == "avatars/a%2Fb.png")
    #expect(AppGroupContainer.avatarPath(forBot: "it's(ok)!*~") == "avatars/it's(ok)!*~.png")
    #expect(container.shareEntryURL(id: "..") == nil)
    #expect(container.shareEntryURL(id: "a/b") == nil)
    #expect(container.pendingIntentURL(id: "") == nil)
  }

  @Test("writes are atomic replacements and reads have a ceiling")
  func readWrite() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let container = AppGroupContainer(url: temporary.url)
    let target = try #require(container.pendingIntentURL(id: "req1"))

    #expect(try container.read(target) == nil)

    try container.write(Data("first".utf8), to: target)
    try container.write(Data("second".utf8), to: target)

    #expect(try container.read(target) == Data("second".utf8))
    #expect(container.contents(of: container.intentsPendingURL) == ["req1.json"])

    try container.write(Data(count: 2_048), to: container.shareTargetsURL)

    #expect(throws: AppGroupError.tooLarge(path: "share-targets.json", bytes: 2_048, limit: 1_024)) {
      _ = try container.read(container.shareTargetsURL, maxBytes: 1_024)
    }

    try container.writeJSON(["a": "b/c"], to: container.widgetSnapshotURL)

    #expect(try container.readJSON([String: String].self, from: container.widgetSnapshotURL) == ["a": "b/c"])
    let raw = try #require(try container.read(container.widgetSnapshotURL))

    #expect(String(decoding: raw, as: UTF8.self) == #"{"a":"b/c"}"#)
  }

  @Test("paths read out of a file cannot climb out of the container")
  func resolve() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let container = AppGroupContainer(url: temporary.url.appendingPathComponent("group"))

    try FileManager.default.createDirectory(at: container.url, withIntermediateDirectories: true)

    #expect(container.resolve(relativePath: "avatars/researcher.png") != nil)
    #expect(container.resolve(relativePath: "../outside.png") == nil)
    #expect(container.resolve(relativePath: "avatars/../../outside.png") == nil)
    #expect(container.resolve(relativePath: "/etc/hosts") == nil)
    #expect(container.resolve(relativePath: "") == nil)

    try FileManager.default.createSymbolicLink(
      at: container.url.appendingPathComponent("link"),
      withDestinationURL: temporary.url
    )

    #expect(container.resolve(relativePath: "link/escape.png") == nil)
  }

  @Test("removal is refused outside the container")
  func remove() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let container = AppGroupContainer(url: temporary.url.appendingPathComponent("group"))
    let outside = temporary.url.appendingPathComponent("keep.txt")
    let entry = try #require(container.shareEntryURL(id: "abc"))

    try Data("x".utf8).write(to: outside)
    try container.write(Data("{}".utf8), to: entry.appendingPathComponent("manifest.json"))

    #expect(!container.remove(outside))
    #expect(FileManager.default.fileExists(atPath: outside.path))
    #expect(container.remove(entry))
    #expect(!FileManager.default.fileExists(atPath: entry.path))
  }
}
