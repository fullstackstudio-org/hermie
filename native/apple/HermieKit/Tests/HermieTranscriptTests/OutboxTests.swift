import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The files a bot shares (`contract/outbox/`): the strict reader of one attachment, and where it lands in the
/// transcript. The valid and invalid attachments, the `message.complete` payload and the history row are the
/// contract's own examples (`contract/outbox/examples.json`, normative); the cases beyond them are the ones a
/// hostile sender writes (`packages/transcript/src/outbox.ts` has the same ones).
@Suite struct OutboxTests {
  // MARK: The contract's own examples

  static let examples: JSONValue = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    guard let data = try? Data(contentsOf: url.appendingPathComponent("contract/outbox/examples.json")),
      let json = try? JSONValue(parsing: String(decoding: data, as: UTF8.self))
    else {
      preconditionFailure("contract/outbox/examples.json is not readable")
    }
    return json
  }()

  static var valid: [JSONValue] { Self.examples["attachments"]?["valid"]?.arrayValue ?? [] }
  static var invalid: [JSONValue] { Self.examples["attachments"]?["invalid"]?.arrayValue ?? [] }
  static var audio: JSONObject { Self.valid[0].objectValue ?? [:] }
  static let route = "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe"

  /// The audio example with some fields changed.
  static func mutate(_ over: JSONObject) -> JSONValue {
    var object = audio
    for (key, value) in over { object[key] = value }
    return .object(object)
  }

  @Test func readsTheValidAttachmentsCamelCasedAndKeepsWhatTheySay() throws {
    let audio = try #require(OutboxAttachment.parse(Self.valid[0]))
    #expect(audio.id == "q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe")
    #expect(audio.name == "tts_20261004_225730_989324.mp3")
    #expect(audio.mime == "audio/mpeg")
    #expect(audio.kind == .audio)
    #expect(audio.size == 48213)
    #expect(audio.sha256 == "a3f1c2e4b5d6978812ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90")
    #expect(audio.createdAt == 1791148287.08)
    #expect(audio.url == "/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/tts_20261004_225730_989324.mp3")

    // A name with a space and an `html` type is a file: a download, whatever its name looks like.
    let html = try #require(OutboxAttachment.parse(Self.valid[1]))
    #expect(html.name == "Q3 report.html")
    #expect(html.kind == .file)
    #expect(html.mime == "text/html")
  }

  @Test func dropsEveryInvalidExampleExceptAnUnknownKindWhichIsShownAsAFile() throws {
    for example in Self.invalid {
      let why = example["why"]?.stringValue ?? ""
      let parsed = OutboxAttachment.parse(example["value"] ?? .null)

      if why == "unknown kind" {
        // The contract lets a client show what it does not know as a file: a download the person opens deliberately.
        let kept = try #require(parsed, Comment(rawValue: why))
        #expect(kept.kind == .file)
        #expect(kept.name == "tts_20261004_225730_989324.mp3")
      } else {
        #expect(parsed == nil, Comment(rawValue: why))
      }
    }
  }

  @Test func keepsTheFiveKindsAndReadsAnyOtherStringAsAFile() {
    for kind in ["image", "video", "audio", "pdf", "file"] {
      #expect(OutboxAttachment.parse(Self.mutate(["kind": .string(kind)]))?.kind.rawValue == kind)
    }
    #expect(OutboxAttachment.parse(Self.mutate(["kind": "hologram"]))?.kind == .file)
    #expect(OutboxAttachment.parse(Self.mutate(["kind": "AUDIO"]))?.kind == .file)
    // Not a kind at all, rather than an unknown one.
    #expect(OutboxAttachment.parse(Self.mutate(["kind": 3])) == nil)
    #expect(OutboxAttachment.parse(Self.mutate(["kind": .null])) == nil)
  }

  // MARK: What a hostile sender writes

  static var hostile: [(String, JSONValue)] {
    let name = "tts_20261004_225730_989324.mp3"
    let id = "q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe"
    let url = "\(route)/\(name)"
    return [
      ("not an object", "x"),
      ("null", .null),
      ("a list", .array([.object(audio)])),
      ("a key the contract does not have", mutate(["path": "/etc/passwd"])),
      ("an id of 31 characters", mutate(["id": .string("q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cN")])),
      ("an id outside the alphabet", mutate(["id": .string("q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8c.e")])),
      ("an empty name", mutate(["name": .string("")])),
      ("a name of 181 characters", mutate(["name": .string(String(repeating: "a", count: 181))])),
      ("a name with a slash", mutate(["name": .string("a/b.mp3")])),
      ("a name with a backslash", mutate(["name": .string("a\\b.mp3")])),
      ("a name with a bell", mutate(["name": .string("a\u{7}b.mp3")])),
      ("a name with a newline", mutate(["name": .string("a\nb.mp3")])),
      ("a name with a C1 control", mutate(["name": .string("a\u{85}b.mp3")])),
      ("a name that is a dot segment", mutate(["name": .string("..")])),
      ("a negative size", mutate(["size": -1])),
      ("a size with a fraction", mutate(["size": 1.5])),
      ("a size as text", mutate(["size": "48213"])),
      ("a size beyond the safe integers", mutate(["size": 9_007_199_254_740_992])),
      (
        "a sha256 in capitals",
        mutate(["sha256": "A3F1C2E4B5D6978812AB34CD56EF7890A1B2C3D4E5F60718293A4B5C6D7E8F90"])
      ),
      ("a created_at that is not a number", mutate(["created_at": "yesterday"])),
      ("a mime that is not text", mutate(["mime": 5])),
      ("a url of another host", mutate(["url": .string("https://evil.test\(url)")])),
      (
        "a url with the wrong id",
        mutate(["url": .string("/api/files/outbox/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/\(name)")])
      ),
      ("a url with the wrong name", mutate(["url": .string("\(route)/other.mp3")])),
      ("a url with a query", mutate(["url": .string("\(url)?token=x")])),
      ("a url with a fragment", mutate(["url": .string("\(url)#frag")])),
      ("a url that climbs", mutate(["url": .string("\(route)/../x")])),
      ("a url whose name is encoded wrongly", mutate(["url": .string("\(route)/%E0%A4%A")])),
      (
        "a url that is another route",
        mutate(["url": .string("/api/files/download/\(id)/\(name)")])
      ),
      ("a dot segment written %2e%2e", mutate(["name": .string(".."), "url": .string("\(route)/%2e%2e")])),
      ("a decoding the name does not have", mutate(["name": .string("x.mp3"), "url": .string("\(route)/%2e%2e")])),
      ("a slash written %2F", mutate(["name": .string("a/b.mp3"), "url": .string("\(route)/a%2Fb.mp3")])),
      ("a %2F the name does not say", mutate(["name": .string("a%2Fb.mp3"), "url": .string("\(route)/a%2Fb.mp3")])),
      ("a backslash written %5C", mutate(["name": .string("a\\b.mp3"), "url": .string("\(route)/a%5Cb.mp3")])),
      ("a url that is protocol-relative", mutate(["url": .string("//evil.test\(url)")])),
      ("a raw .. segment before the id", mutate(["url": .string("/api/files/outbox/../\(id)/\(name)")])),
      ("a raw .. segment as the name", mutate(["name": .string("x.mp3"), "url": .string("\(route)/..")])),
      ("a . segment between the id and the name", mutate(["url": .string("\(route)/./\(name)")])),
      ("a canonically equal but different name", mutate(["name": .string("e\u{301}.mp3"), "url": .string("\(route)/%C3%A9.mp3")])),
      // Swift's `Character` compares grapheme clusters by canonical equivalence; the route is compared by code points.
      (
        "a url whose id has a Kelvin sign where the id has a K",
        mutate([
          "id": .string("K3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe"),
          "url": .string("/api/files/outbox/\u{212A}3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/\(name)"),
        ])
      ),
      (
        "a raw ? that carries a combining mark",
        mutate(["name": .string("a?\u{301}b.mp3"), "url": .string("\(route)/a?\u{301}b.mp3")])
      ),
      (
        "a raw # that carries a combining mark",
        mutate(["name": .string("a#\u{301}b.mp3"), "url": .string("\(route)/a#\u{301}b.mp3")])
      ),
    ]
  }

  @Test(arguments: hostile.map(\.0)) func dropsAnAttachmentWith(_ what: String) throws {
    let value = try #require(Self.hostile.first { $0.0 == what }?.1)
    #expect(OutboxAttachment.parse(value) == nil)
  }

  @Test func aNameWithAQuestionMarkOrAHashIsKeptWhenItsUrlEncodesThem() throws {
    for name in ["a?\u{301}b.mp3", "a#\u{301}b.mp3", "K.mp3"] {
      let url = "\(Self.route)/\(OutboxAttachment.encodedName(name))"
      let parsed = try #require(OutboxAttachment.parse(Self.mutate(["name": .string(name), "url": .string(url)])))
      #expect(parsed.name == name)
    }
  }

  @Test func readsANameWithMarkupAsTheTextItIsAndAPercentEncodedNameByWhatItDecodesTo() {
    let name = "<img src=x onerror=alert(1)>.png"
    let encoded = OutboxAttachment.encodedName(name)
    let parsed = OutboxAttachment.parse(
      Self.mutate(["name": .string(name), "kind": "image", "mime": "image/png", "url": .string("\(Self.route)/\(encoded)")]))

    #expect(parsed?.name == name)
    #expect(parsed?.url.contains("%3Cimg") == true)
  }

  @Test func readsANameOfOneHundredAndEightyCodePointsAndNotMore() {
    let long = String(repeating: "é", count: 180)
    let url = "\(Self.route)/\(OutboxAttachment.encodedName(long))"
    #expect(OutboxAttachment.parse(Self.mutate(["name": .string(long), "url": .string(url)]))?.name == long)
  }

  @Test func readsAListInOrderKeepsEachTokenOnceAndTakesNoMoreThanTheCap() {
    let a = Self.valid[0]
    let b = Self.valid[1]
    let kept = OutboxAttachment.parseAll(.array([b, .string("junk"), a, b, a]))
    #expect(kept.map(\.name) == ["Q3 report.html", "tts_20261004_225730_989324.mp3"])

    var many: [JSONValue] = []
    for index in 0..<150 {
      let id = String(format: "%032d", index)
      let object: JSONObject = [
        "id": .string(id), "name": .string("f.txt"), "mime": "text/plain", "kind": "file", "size": 1,
        "sha256": .string(String(repeating: "a", count: 64)), "created_at": 1,
        "url": .string("/api/files/outbox/\(id)/f.txt")
      ]
      many.append(.object(object))
    }
    #expect(OutboxAttachment.parseAll(.array(many)).count == OutboxAttachment.maximumCount)
  }

  @Test func anythingButAListIsNoAttachments() {
    #expect(OutboxAttachment.parseAll(nil).isEmpty)
    #expect(OutboxAttachment.parseAll(.null).isEmpty)
    #expect(OutboxAttachment.parseAll(.array([])).isEmpty)
    #expect(OutboxAttachment.parseAll(.object(Self.audio)).isEmpty)
    #expect(OutboxAttachment.parseAll("x").isEmpty)
  }

  @Test func encodesANameTheWayTheGatewayWritesItsUrl() {
    #expect(OutboxAttachment.encodedName("Q3 report.html") == "Q3%20report.html")
    #expect(OutboxAttachment.encodedName("a(b)'*!.txt") == "a%28b%29%27%2A%21.txt")
    #expect(OutboxAttachment.encodedName("é.png") == "%C3%A9.png")
    #expect(OutboxAttachment.encodedName("keep-._~") == "keep-._~")
  }

  // MARK: The item

  @Test func theItemKeepsWhatItWasGivenThroughItsJSON() throws {
    let attachment = try #require(OutboxAttachment.parse(Self.valid[0]))
    let base = ItemBase(id: "a:1", seq: 1, origin: .live, version: 0)
    let item = AssistantItem(base: base, text: "Here.", streaming: false, interim: false, outbox: [attachment])
    let json = item.jsonValue

    #expect(json["outbox"]?.arrayValue?.first?["createdAt"]?.doubleValue == 1791148287.08)
    #expect(json["outbox"]?.arrayValue?.first?["created_at"] == nil)
    #expect(try AssistantItem(decoding: json) == item)
    // An item without files writes no key at all.
    #expect(AssistantItem(base: base, text: "x", streaming: false, interim: false).jsonValue["outbox"] == nil)
  }

  @Test func aStoredAttachmentThatIsNotValidIsNotTrusted() throws {
    let base = ItemBase(id: "a:1", seq: 1, origin: .live, version: 0)
    var json = AssistantItem(base: base, text: "x", streaming: false, interim: false).jsonValue.objectValue ?? [:]
    json["outbox"] = .array([
      .object([
        "id": .string("../../etc"), "name": .string("a"), "mime": "x", "kind": "file", "size": 1, "sha256": .string(String(repeating: "a", count: 64)),
        "createdAt": 1, "url": .string("/x")
      ])
    ])
    let item = try AssistantItem(decoding: .object(json))
    #expect(item.outbox == nil)
  }

  // MARK: Where it lands

  @Test func aCompletedReplyCarriesItsFiles() throws {
    let payload = try #require(Self.examples["message_complete"]?.objectValue)
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last)
    #expect(reply.text == "Here is the recording.")
    #expect(reply.outbox?.map(\.name) == ["tts_20261004_225730_989324.mp3"])
    #expect(reply.outbox?.first?.kind == .audio)
  }

  @Test func aReplyOfNothingButAFileIsStillAReply() throws {
    var payload = try #require(Self.examples["message_complete"]?.objectValue)
    payload["text"] = ""
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    let replies = state.orderedItems.compactMap(\.asAssistant)
    #expect(replies.count == 1)
    #expect(replies.first?.outbox?.count == 1)
  }

  @Test func aReplyWithNoUsableFilesIsNotMadeUpOfThem() throws {
    var payload = try #require(Self.examples["message_complete"]?.objectValue)
    payload["text"] = ""
    payload["attachments"] = .array(Self.invalid.prefix(1).compactMap { $0["value"] })
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    #expect(state.orderedItems.compactMap(\.asAssistant).isEmpty)
  }

  @Test func aHistoryRowCarriesItsFilesBesideItsText() throws {
    let row = try #require(Self.examples["history_row"]?.objectValue)
    let items = rowsToItems([TranscriptRow(json: row)], .rpc)
    let reply = try #require(items.compactMap(\.asAssistant).first)

    #expect(reply.text == "Here is the recording.")
    #expect(reply.outbox?.first?.id == "q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe")
  }

  @Test func aHistoryRowOfNothingButAFileIsKept() throws {
    var row = try #require(Self.examples["history_row"]?.objectValue)
    row["text"] = ""
    let items = rowsToItems([TranscriptRow(json: row)], .rpc)
    #expect(items.compactMap(\.asAssistant).first?.outbox?.count == 1)
  }

  @Test func aHistoryReloadKeepsTheFilesTheLiveReplyHad() throws {
    // The live reply landed with its files; the history page for the same row (an older gateway, or a
    // projection that did not carry them) must not take them away.
    let payload = try #require(Self.examples["message_complete"]?.objectValue)
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    var row = try #require(Self.examples["history_row"]?.objectValue)
    row["attachments"] = nil
    let merged = reconcile(state, rowsToItems([TranscriptRow(json: row)], .rpc))
    let reply = try #require(merged.orderedItems.compactMap(\.asAssistant).last)

    #expect(reply.outbox?.count == 1)
    #expect(merged.orderedItems.compactMap(\.asAssistant).count == 1)
  }

  @Test func aHistoryReloadWithTheFilesGivesThem() throws {
    let row = try #require(Self.examples["history_row"]?.objectValue)
    let merged = reconcile(createChatState("bot", "stored", "resolved"), rowsToItems([TranscriptRow(json: row)], .rpc))
    #expect(merged.orderedItems.compactMap(\.asAssistant).first?.outbox?.count == 1)
  }

  @Test func theFilesSurviveTheCacheRoundTrip() throws {
    let row = try #require(Self.examples["history_row"]?.objectValue)
    let state = reconcile(createChatState("bot", "stored", "resolved"), rowsToItems([TranscriptRow(json: row)], .rpc))
    let restored = try ChatState(decoding: state.jsonValue)
    #expect(restored.orderedItems.compactMap(\.asAssistant).first?.outbox == state.orderedItems.compactMap(\.asAssistant).first?.outbox)
  }

  @Test func theFilesGoToTheOfflineCacheAndComeBackFromIt() throws {
    let row = try #require(Self.examples["history_row"]?.objectValue)
    let state = reconcile(createChatState("bot", "stored", "resolved"), rowsToItems([TranscriptRow(json: row)], .rpc))
    let wanted = try #require(state.orderedItems.compactMap(\.asAssistant).first?.outbox)

    // What the store keeps is the snapshot's own JSON text, read back by the same decoder.
    let text = snapshotForCache(state, now: 1_000).jsonValue.description
    let snapshot = try CachedTranscript(decoding: JSONValue(parsing: text))
    let restored = stateFromCache("bot", SessionIDs(storedSessionID: "stored", resolvedSessionID: "resolved"), snapshot)

    #expect(restored.orderedItems.compactMap(\.asAssistant).first?.outbox == wanted)
  }

  // MARK: What reads the item

  private func replyOfOnlyAFile() throws -> (ChatState, AssistantItem) {
    var payload = try #require(Self.examples["message_complete"]?.objectValue)
    payload["text"] = ""
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)
    return (state, try #require(state.orderedItems.compactMap(\.asAssistant).first))
  }

  @Test func aReplyOfNothingButAFileIsShownInFullNotCollapsed() throws {
    let (state, _) = try replyOfOnlyAFile()
    let shown = visibleItems(state, VisibilityOptions(level: .normal, showBotToBot: true, showThinking: false))
    #expect(shown.count == 1)
    #expect(shown.first?.presentation == .full)
  }

  @Test func aReplyOfNothingButAFileCountsAsAMessageAndPreviewsAsItsName() throws {
    let (state, reply) = try replyOfOnlyAFile()
    #expect(countsAsMessage(.assistant(reply)))
    #expect(previewFromChat(state)?.text == "tts_20261004_225730_989324.mp3")
  }

  @Test func theExportNamesTheFilesAsAnAttachmentOfTheReadersOwnIsNamed() throws {
    let row = try #require(Self.examples["history_row"]?.objectValue)
    let state = reconcile(createChatState("bot", "stored", "resolved"), rowsToItems([TranscriptRow(json: row)], .rpc))
    let exported = exportTranscript(
      state.orderedItems, TranscriptExportOptions(botName: "Writer", selfName: "Me", formatTime: { _ in "t" }, exportedAt: 0))
    #expect(exported.text.contains("Here is the recording.\n[tts_20261004_225730_989324.mp3]"))
  }

  // MARK: Names

  @Test func aNameIsShownWithoutControlFormatAndSeparatorCharacters() {
    // A right-to-left override makes `report.exe.pdf` read as `report.fdp.exe`.
    #expect(OutboxText.displayName("report.\u{202E}fdp.exe") == "report.fdp.exe")
    #expect(OutboxText.displayName("a\u{200D}b\u{200B}c.txt") == "abc.txt")
    #expect(OutboxText.displayName("a\u{2028}b\u{2029}c") == "abc")
    #expect(OutboxText.displayName("plain é.txt") == "plain é.txt")
    #expect(OutboxText.displayName("\u{202E}\u{200B}") == "file")
  }

  @Test func aSavedNameIsTheShownNameWithoutWhatAFileSystemRefuses() {
    #expect(OutboxText.savedName("report.\u{202E}fdp.exe") == "report.fdp.exe")
    #expect(OutboxText.savedName("a:b|c?d*e<f>g\"h.txt") == "a_b_c_d_e_f_g_h.txt")
    #expect(OutboxText.savedName("a/b\\c.txt") == "a_b_c.txt")
    #expect(OutboxText.savedName("  spaced.txt \n") == "spaced.txt")
    #expect(OutboxText.savedName("Q3 report.html") == "Q3 report.html")
    #expect(OutboxText.savedName("") == "file")
    #expect(OutboxText.savedName("\u{200B}") == "file")
    #expect(OutboxText.savedName("...") == "file")
    #expect(OutboxText.savedName(".bashrc") == "_.bashrc", "a saved copy is never a hidden file")
    #expect(OutboxText.savedName(" .env") == "_.env")
    #expect(OutboxText.savedName("..hidden.txt") == "_..hidden.txt")
  }

  @Test func aSavedNameIsCutAtACharacterBoundaryAndKeepsItsExtension() {
    let long = String(repeating: "é", count: 180) + ".pdf"
    let saved = OutboxText.savedName(long)
    #expect(saved.utf8.count <= OutboxText.savedNameMaximumBytes)
    #expect(saved.hasSuffix(".pdf"))
    #expect(saved.dropLast(4).allSatisfy { $0 == "é" })

    let noExtension = OutboxText.savedName(String(repeating: "日", count: 180))
    #expect(noExtension.utf8.count <= OutboxText.savedNameMaximumBytes)
    #expect(noExtension.allSatisfy { $0 == "日" })
  }
}
