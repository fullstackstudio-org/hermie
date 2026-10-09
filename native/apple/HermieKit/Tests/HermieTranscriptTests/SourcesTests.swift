import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The pages a reply used (`contract/sources/`): the strict reader of one entry, the list, where it lands in
/// the transcript, and what a view shows of one (the domain, the monogram). The entries below are the
/// contract's own examples (`examples.json`, normative) written out; `theContractsOwnExamples` reads the file.
/// The golden corpus (`contract/transcript/golden/sources.json`) holds the readers to the TypeScript one.
@Suite struct SourcesTests {
  // MARK: The contract's examples, written out

  static let valid: [JSONValue] = [
    ["url": "https://example.org/guide/install", "title": "Installing the gateway", "via": "read"],
    ["url": "https://docs.example.com/a?b=c#d", "title": "", "via": "found"],
    ["url": "http://example.net", "title": "Example Net", "via": "found"],
    ["url": "https://[2001:db8::1]:8443/page", "title": "An address with a port", "via": "read"],
    ["url": "https://xn--bcher-kva.example/K\u{FC}che?q=\u{FC}", "title": "A host stored as punycode, the path as returned", "via": "found"]
  ]

  static let invalid: [(why: String, value: JSONValue)] = [
    ("scheme is not http or https", ["url": "ftp://example.org/file", "title": "x", "via": "read"]),
    ("javascript URL", ["url": "javascript:alert(1)", "title": "x", "via": "found"]),
    ("user info in the URL", ["url": "https://user:secret@example.org/", "title": "x", "via": "read"]),
    ("no host", ["url": "https:///path", "title": "x", "via": "read"]),
    ("whitespace in the URL", ["url": "https://example.org/a b", "title": "x", "via": "read"]),
    ("unknown via", ["url": "https://example.org/", "title": "x", "via": "cited"]),
    ("title over 160 characters", ["url": "https://example.org/", "title": .string(String(repeating: "x", count: 161)), "via": "read"]),
    ("missing title", ["url": "https://example.org/", "via": "read"]),
    ("unknown key", ["url": "https://example.org/", "title": "x", "via": "read", "favicon": "https://example.org/favicon.ico"])
  ]

  static let messageComplete: JSONObject = [
    "text": "The gateway is installed with one command; see the guide.",
    "status": "complete",
    "row_id": 812,
    "sources": [
      ["url": "https://example.org/guide/install", "title": "Installing the gateway", "via": "read"],
      ["url": "https://docs.example.com/a?b=c#d", "title": "", "via": "found"]
    ]
  ]

  static let historyRow: JSONObject = [
    "role": "assistant",
    "text": "The gateway is installed with one command; see the guide.",
    "row_id": 812,
    "display_metadata": [
      "sources": [
        ["url": "https://example.org/guide/install", "title": "Installing the gateway", "via": "read"],
        ["url": "https://docs.example.com/a?b=c#d", "title": "", "via": "found"]
      ]
    ]
  ]

  // MARK: One entry

  @Test func readsEveryValidExample() throws {
    for entry in Self.valid {
      #expect(ReplySource.parse(entry) != nil, "\(entry)")
    }

    let first = try #require(ReplySource.parse(Self.valid[0]))
    #expect(first.url == "https://example.org/guide/install")
    #expect(first.title == "Installing the gateway")
    #expect(first.via == .read)
    #expect(try #require(ReplySource.parse(Self.valid[1])).title == "")
  }

  @Test func dropsEveryInvalidExample() {
    for (why, value) in Self.invalid {
      #expect(ReplySource.parse(value) == nil, "\(why)")
    }
  }

  @Test(arguments: [
    "https://example.org/a\tb", "https://example.org/a\u{A0}b", "https://exam ple.org/", "https:// example.org/",
    "https://example.org/\u{2028}", "https://example.org/\u{FEFF}", " https://example.org/", "https://example.org/ ",
    "https://example.org\n", "HTTPS:/example.org", "https:example.org", "http://", "https://@example.org/",
    "https://a@b/", "https://example.org@evil.example/", "https://?q=1", "https://#frag", "https:///", "//example.org/",
    "example.org", "", "mailto:a@b.c", "data:text/html,x", "file:///etc/hosts", "https//example.org", "wss://example.org/"
  ]) func dropsAnAddressThatIsNotAWebAddress(_ url: String) {
    #expect(
      ReplySource.parse(["url": .string(url), "title": "x", "via": "found"]) == nil, "\(url.debugDescription)")
  }

  @Test(arguments: [
    "https://example.org", "http://example.org/Path", "https://example.org/a@b", "https://example.org?x=@",
    "https://example.org#a@b", "https://xn--bcher-kva.example/K\u{FC}che?q=\u{FC}", "https://[::1]/",
    "http://1.2.3.4:8080/x?y#z", "https://example.org:65535/", "https://a-b.c-d.example/", "https://localhost"
  ]) func keepsAnAddressTheSchemaAllows(_ url: String) {
    #expect(ReplySource.parse(["url": .string(url), "title": "x", "via": "found"]) != nil, "\(url)")
  }

  @Test(arguments: [
    // The gateway stores the scheme and the host in lower case ASCII.
    "HTTP://example.org/", "Https://example.org/", "https://Example.org/", "https://EXAMPLE.ORG/Path",
    "https://b\u{FC}cher.example/", "https://\u{FF45}xample.org/",
    // A port is one to five digits and at most 65535.
    "https://example.org:65536/", "https://example.org:999999/", "https://example.org:/", "https://example.org:80a/",
    // A host is labels of letters, digits and hyphens between single dots.
    "https://.example.org/", "https://example..org/", "https://example.org./", "https://exa_mple.org/",
    "https://[]/", "https://[::g]/", "https://[::1/", "https://[::1]x/",
    // Nothing invisible, nothing that ends the string with a line break.
    "https://example.org/a\u{200B}b", "https://example.org/\u{00AD}", "https://example.org/a\u{2066}b",
    "https://example.org/\n", "https://example.org\n", "https://example.org/a\u{85}b", "https://example.org/a\u{7F}",
    "https://example.org/\u{E0001}"
  ]) func dropsAnAddressTheSchemaRefuses(_ url: String) {
    #expect(
      ReplySource.parse(["url": .string(url), "title": "x", "via": "found"]) == nil, "\(url.debugDescription)")
  }

  @Test func countsTheLengthsInCharactersNotUnits() {
    let atTheCap = "https://example.org/" + String(repeating: "a", count: ReplySource.maximumURLLength - 20)
    #expect(ReplySource.parse(["url": .string(atTheCap), "title": "x", "via": "read"]) != nil)
    #expect(ReplySource.parse(["url": .string(atTheCap + "a"), "title": "x", "via": "read"]) == nil)

    // 160 emoji are 160 characters (320 UTF-16 units); 161 are over.
    let title = String(repeating: "😀", count: ReplySource.maximumTitleLength)
    #expect(ReplySource.parse(["url": "https://example.org/", "title": .string(title), "via": "read"]) != nil)
    #expect(ReplySource.parse(["url": "https://example.org/", "title": .string(title + "😀"), "via": "read"]) == nil)
  }

  @Test func anEntryThatIsNotAnObjectOrHasTheWrongTypesIsDropped() {
    for value: JSONValue in [
      "https://example.org/", 1, true, .null, [],
      ["url": 1, "title": "x", "via": "read"],
      ["url": "https://example.org/", "title": 1, "via": "read"],
      ["url": "https://example.org/", "title": .null, "via": "read"],
      ["url": "https://example.org/", "title": "x", "via": 1],
      ["url": "https://example.org/", "title": "x", "via": "READ"]
    ] {
      #expect(ReplySource.parse(value) == nil, "\(value)")
    }
  }

  // MARK: The list

  @Test func readsAListInOrderKeepsEachAddressOnceAndTakesNoMoreThanTheCap() {
    let entries = (0..<40).map { number -> JSONValue in
      ["url": .string("https://example.org/\(number % 30)"), "title": .string("t\(number)"), "via": "found"]
    }
    let list = ReplySource.parseAll(.array(entries))

    #expect(list.count == ReplySource.maximumCount)
    #expect(list.map(\.url).first == "https://example.org/0")
    #expect(Set(list.map(\.url)).count == list.count)
    // The first of a repeated address stays.
    #expect(list.first { $0.url == "https://example.org/0" }?.title == "t0")
  }

  @Test func dropsTheInvalidEntriesAndKeepsTheRest() {
    let list = ReplySource.parseAll(.array(Self.invalid.map(\.value) + Self.valid))
    #expect(list.map(\.url) == Self.valid.compactMap { $0["url"]?.stringValue })
  }

  @Test func anythingButAListOfValidEntriesIsNoSources() {
    #expect(ReplySource.parseAll(nil).isEmpty)
    #expect(ReplySource.parseAll(.null).isEmpty)
    #expect(ReplySource.parseAll(.array([])).isEmpty)
    #expect(ReplySource.parseAll("https://example.org/").isEmpty)
    #expect(ReplySource.parseAll(.object(["url": "https://example.org/"])).isEmpty)
    #expect(ReplySource.parseAll(.array(Self.invalid.map(\.value))).isEmpty)
  }

  @Test func theListIsReadFromMetadataThatIsAnObjectOrItsJSONText() throws {
    let metadata = try #require(Self.historyRow["display_metadata"])
    #expect(ReplySource.parseAll(fromMetadata: metadata).count == 2)
    #expect(ReplySource.parseAll(fromMetadata: .string(try metadata.canonicalString())).count == 2)
    #expect(ReplySource.parseAll(fromMetadata: .string("not json")).isEmpty)
    #expect(ReplySource.parseAll(fromMetadata: .string("[1]")).isEmpty)
    #expect(ReplySource.parseAll(fromMetadata: ["author": ["via": "x"]]).isEmpty)
    #expect(ReplySource.parseAll(fromMetadata: nil).isEmpty)
  }

  // MARK: The item

  @Test func theItemKeepsWhatItWasGivenThroughItsJSON() throws {
    let sources = ReplySource.parseAll(.array(Self.valid))
    let base = ItemBase(id: "a:1", seq: 1, origin: .live, version: 0)
    let item = AssistantItem(base: base, text: "See.", streaming: false, interim: false, sources: sources)

    #expect(item.jsonValue["sources"]?.arrayValue?.count == 5)
    #expect(try AssistantItem(decoding: item.jsonValue) == item)
    #expect(AssistantItem(base: base, text: "x", streaming: false, interim: false).jsonValue["sources"] == nil)
  }

  @Test func aStoredSourceThatIsNotValidIsNotTrusted() throws {
    let base = ItemBase(id: "a:1", seq: 1, origin: .live, version: 0)
    var json = AssistantItem(base: base, text: "x", streaming: false, interim: false).jsonValue.objectValue ?? [:]
    json["sources"] = .array([["url": "javascript:alert(1)", "title": "x", "via": "read"]])
    let item = try AssistantItem(decoding: .object(json))
    #expect(item.sources == nil)
  }

  // MARK: Where it lands

  @Test func aCompletedReplyCarriesItsSources() throws {
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(Self.messageComplete)]), 2_000)

    let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last)
    #expect(reply.text == "The gateway is installed with one command; see the guide.")
    #expect(reply.sources?.map(\.via) == [.read, .found])
    #expect(reply.sources?.first?.domain == "example.org")
  }

  @Test func aReplyWithoutSourcesHasNone() throws {
    var payload = Self.messageComplete
    payload["sources"] = nil
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last)
    #expect(reply.sources == nil)
  }

  @Test func sourcesAloneDoNotMakeAReply() throws {
    var payload = Self.messageComplete
    payload["text"] = ""
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    #expect(state.orderedItems.compactMap(\.asAssistant).isEmpty)
  }

  @Test func aFrameWithKeysTheEngineDoesNotKnowStillLands() throws {
    var payload = Self.messageComplete
    payload["a_key_from_a_newer_gateway"] = ["nested": [1, 2, 3]]
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last)
    #expect(reply.text == "The gateway is installed with one command; see the guide.")
    #expect(reply.sources?.count == 2)
  }

  /// Whether a gateway that sends `sources`, or one that sends them in a shape this build does not read, can
  /// break a decode. The same cases hold for the build before the key existed (0.2.15, `9aabb906`): they were
  /// run there and pass, so an app that has not shipped this reader ignores the key.
  @Test(arguments: [
    JSONValue.null, "x", 7, [], ["a": 1],
    [["url": "javascript:alert(1)", "title": 1, "via": 2, "extra": [1]]],
    [["url": "https://example.org/guide/install", "title": "Installing the gateway", "via": "read"]]
  ]) func aCompletionIgnoresASourcesKeyOfAnyShape(_ sources: JSONValue) throws {
    let payload: JSONObject = ["text": "The reply.", "status": "complete", "row_id": 812, "sources": sources]
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(payload)]), 2_000)

    let reply = try #require(state.orderedItems.compactMap(\.asAssistant).last)
    #expect(reply.text == "The reply.")
    #expect(!reply.streaming)
    #expect(try ChatState(decoding: state.jsonValue).orderedItems.count == state.orderedItems.count)
  }

  @Test(arguments: [
    JSONValue.null, "x", 7, [], ["sources": "x"], ["sources": [1, 2]], .string("{\"sources\": [1]}"), .string("[")
  ]) func aHistoryRowIgnoresMetadataOfAnyShape(_ metadata: JSONValue) throws {
    let row: JSONObject = ["role": "assistant", "text": "The reply.", "row_id": 812, "display_metadata": metadata]
    let items = rowsToItems([TranscriptRow(json: row)], .rpc)
    #expect(items.compactMap(\.asAssistant).first?.text == "The reply.")
  }

  @Test func aHistoryRowCarriesItsSourcesBesideItsText() throws {
    let items = rowsToItems([TranscriptRow(json: Self.historyRow)], .rpc)
    let reply = try #require(items.compactMap(\.asAssistant).first)

    #expect(reply.text == "The gateway is installed with one command; see the guide.")
    #expect(reply.sources?.count == 2)
    #expect(reply.sources?.last?.title == "")
  }

  @Test func aHistoryReloadKeepsTheSourcesTheLiveReplyHad() throws {
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.complete", "payload": .object(Self.messageComplete)]), 2_000)

    // The projection of an older gateway, or a page that did not carry them, must not take them away.
    var row = Self.historyRow
    row["display_metadata"] = nil
    let merged = reconcile(state, rowsToItems([TranscriptRow(json: row)], .rpc))
    let replies = merged.orderedItems.compactMap(\.asAssistant)

    #expect(replies.count == 1)
    #expect(replies.last?.sources?.count == 2)
  }

  @Test func theSourcesSurviveTheCacheRoundTrip() throws {
    let state = reconcile(
      createChatState("bot", "stored", "resolved"), rowsToItems([TranscriptRow(json: Self.historyRow)], .rpc))
    let wanted = try #require(state.orderedItems.compactMap(\.asAssistant).first?.sources)

    let restored = try ChatState(decoding: state.jsonValue)
    #expect(restored.orderedItems.compactMap(\.asAssistant).first?.sources == wanted)

    let text = snapshotForCache(state, now: 1_000).jsonValue.description
    let snapshot = try CachedTranscript(decoding: JSONValue(parsing: text))
    let fromCache = stateFromCache("bot", SessionIDs(storedSessionID: "stored", resolvedSessionID: "resolved"), snapshot)
    #expect(fromCache.orderedItems.compactMap(\.asAssistant).first?.sources == wanted)
  }

  // MARK: What a view shows

  @Test(arguments: [
    ("https://example.org/guide", "example.org"),
    ("https://www.example.org/guide", "www.example.org"),
    ("http://docs.example.com/a?b=c#d", "docs.example.com"),
    ("https://example.org:8443/x", "example.org"),
    ("https://[2001:db8::1]:8443/page", "[2001:db8::1]"),
    ("https://xn--bcher-kva.example:8443/", "xn--bcher-kva.example"),
    ("https://[::1]/", "[::1]"),
    ("http://example.net", "example.net"),
    ("https://xn--bcher-kva.example/", "xn--bcher-kva.example"),
    ("https://example.org?x=1", "example.org"),
    ("https://example.org#x", "example.org"),
    ("https://example.org/a@b", "example.org")
  ]) func theDomainIsTheHostAsSentWithoutThePort(_ url: String, _ domain: String) {
    #expect(ReplySource.domain(of: url) == domain)
  }

  @Test func aMisleadingTitleDoesNotChangeTheDomain() throws {
    let source = try #require(
      ReplySource.parse(["url": "https://evil.example/login", "title": "accounts.google.com — Sign in", "via": "found"]))
    #expect(source.domain == "evil.example")
    #expect(source.title.contains("google"))
  }

  @Test func theDomainOfAnAddressThatIsNotOneIsEmpty() {
    #expect(ReplySource.domain(of: "javascript:alert(1)").isEmpty)
    #expect(ReplySource.domain(of: "https://user@example.org/").isEmpty)
    #expect(ReplySource.domain(of: "").isEmpty)
  }

  @Test func theMonogramIsTheFirstLetterOrDigitOfTheDomainInUpperCase() {
    #expect(ReplySource.monogram(of: "example.org") == "E")
    #expect(ReplySource.monogram(of: "www.example.org") == "E", "past a leading www.")
    #expect(ReplySource.monogram(of: "3dprint.example") == "3")
    #expect(ReplySource.monogram(of: "[2001:db8::1]") == "2")
    #expect(ReplySource.monogram(of: "ärzte.example") == "Ä")
    #expect(ReplySource.monogram(of: "[::]") == "#")
    #expect(ReplySource.monogram(of: "") == "#")
  }

  @Test func theHueIsStableAndSpreadsDomains() {
    #expect(ReplySource.hue(of: "example.org") == ReplySource.hue(of: "example.org"))
    #expect(ReplySource.hue(of: "example.org") != ReplySource.hue(of: "example.net"))
    #expect(ReplySource.hue(of: "www.example.org") == ReplySource.hue(of: "example.org"), "one site, one colour")

    let hues = (0..<200).map { ReplySource.hue(of: "site\($0).example") }
    #expect(hues.allSatisfy { $0 >= 0 && $0 < 1 })
    #expect(Set(hues).count > 100, "domains are spread over the colour wheel")
    // A value that never changes between launches or devices: a hash of the bytes, not Swift's seeded one.
    #expect(ReplySource.hue(of: "example.org") == 0.9583333333333334)
  }

  // MARK: The contract's own copy

  private static var contractExamples: JSONValue? {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    guard let data = try? Data(contentsOf: url.appendingPathComponent("contract/sources/examples.json")) else {
      return nil
    }
    return try? JSONValue(parsing: String(decoding: data, as: UTF8.self))
  }

  @Test(.enabled(if: SourcesTests.contractExamples != nil, "contract/sources/ is not in this checkout"))
  func theContractsOwnExamples() throws {
    let examples = try #require(Self.contractExamples)
    let entries = try #require(examples["entries"])

    for entry in entries["valid"]?.arrayValue ?? [] {
      #expect(ReplySource.parse(entry) != nil, "\(entry)")
    }

    for entry in entries["invalid"]?.arrayValue ?? [] {
      #expect(ReplySource.parse(entry["value"] ?? .null) == nil, "\(entry["why"]?.stringValue ?? "")")
    }

    let complete = try #require(examples["message_complete"]?.objectValue)
    #expect(ReplySource.parseAll(complete["sources"]).count == (complete["sources"]?.arrayValue?.count ?? -1))

    let row = try #require(examples["history_row"]?.objectValue)
    #expect(ReplySource.parseAll(fromMetadata: row["display_metadata"]).count == 2)
  }
}
