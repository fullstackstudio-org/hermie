import HermieProtocol
import Testing

@testable import HermieTranscript

/// The agent marker on a row's author (`contract/gateway/mcp.md`), beside the golden replay of
/// `contract/transcript/golden/author.json`: what the engine keeps, what it drops, and where the
/// label is worded.
struct AuthorViaTests {
  private func userRow(author: JSONValue?, replayedBy: JSONValue? = nil, text: String = "hello") -> TranscriptRow {
    var metadata: JSONObject = [:]
    metadata["author"] = author
    metadata["replayed_by"] = replayedBy
    return TranscriptRow(json: ["role": "user", "content": .string(text), "display_metadata": .object(metadata)])
  }

  private func firstUser(_ rows: [TranscriptRow]) throws -> UserItem {
    let items = rowsToItems(rows, .rest)
    return try #require(items.compactMap(\.asUser).first)
  }

  @Test func theMarkerRidesBesideThePerson() throws {
    let item = try firstUser([
      userRow(author: ["id": "oidc:a", "name": "Robin", "via": ["kind": "mcp", "client": "Claude Code", "extra": 1]])
    ])

    #expect(item.author?.id == "oidc:a")
    #expect(item.author?.name == "Robin")
    #expect(item.author?.via == AuthorVia(kind: "mcp", client: "Claude Code"))
    #expect(item.replayedBy == nil)
  }

  @Test func aMalformedMarkerIsDroppedAndThePersonStays() throws {
    for via: JSONValue in ["mcp", ["kind": "mcp"], ["kind": "", "client": "X"], ["kind": "mcp", "client": " \u{200B}\n "], .null] {
      let item = try firstUser([userRow(author: ["id": "oidc:a", "name": "Robin", "via": via])])

      #expect(item.author == MessageAuthor(id: "oidc:a", name: "Robin"), "via \(via)")
    }
  }

  @Test func theRetryPresserIsReadTheSameWay() throws {
    let item = try firstUser([
      userRow(
        author: ["id": "oidc:a", "name": "Robin"],
        replayedBy: ["id": "oidc:b", "name": "Sam", "via": ["kind": "mcp", "client": "Claude Code"]]
      )
    ])

    #expect(item.author?.via == nil)
    #expect(item.replayedBy?.id == "oidc:b")
    #expect(item.replayedBy?.via?.client == "Claude Code")
  }

  @Test func theMarkerSurvivesTheCacheRoundTrip() throws {
    var item = try firstUser([
      userRow(author: ["id": "oidc:a", "name": "Robin", "via": ["kind": "mcp", "client": "Claude Code"]])
    ])
    item.replayedBy = MessageAuthor(id: "oidc:b", via: AuthorVia(kind: "mcp", client: "Other"))

    let decoded = try UserItem(decoding: item.jsonValue)

    #expect(decoded == item)
    #expect(decoded.author?.via?.client == "Claude Code")
    #expect(decoded.replayedBy?.via?.client == "Other")
  }

  @Test func theClientIsOneCleanLine() {
    let dirty: JSONValue = ["kind": "mcp", "client": "  Claude\u{202E} \u{200B}Code\n*Pro*\u{2028}x  "]
    #expect(authorViaOf(dirty)?.client == "Claude Code *Pro* x")

    // 80 code points, never a cut through a pair.
    let long: JSONValue = ["kind": "mcp", "client": .string(String(repeating: "\u{1D49E}", count: 90))]
    #expect(authorViaOf(long)?.client.unicodeScalars.count == authorViaClientLimit)
  }

  @Test func theLabelIsPlainText() {
    let via = AuthorVia(kind: "mcp", client: "My *Agent*")

    #expect(authorLabel(via: via, "_Robin_") == "_Robin_ via My *Agent*")
    #expect(authorLabel(via: via, "  ") == "via My *Agent*")
    #expect(authorLabel(via: nil, "Robin") == "Robin")
    #expect(authorLabel(MessageAuthor(id: "x", via: via), "Robin") == "Robin via My *Agent*")
  }

  @Test func aPreviewAndAnExportLabelAnAgentsTurnInAnyChat() throws {
    let viaRow = userRow(
      author: ["id": "oidc:me", "name": "Robin", "via": ["kind": "mcp", "client": "Claude Code"]], text: "ship it")
    let items = rowsToItems([viaRow], .rest)
    var state = createChatState("bot", "s", "s")
    state = reconcile(state, items)

    // One-to-one chat, the reader's own row: still labelled.
    let options = ChatPreviewOptions(groupChat: false, ownAuthorID: "oidc:me", resolveSenderName: { $0.name ?? "" })
    #expect(previewFromChat(state, options)?.senderName == "Robin via Claude Code")

    // Without a resolver the row stays unattributed.
    #expect(previewFromChat(state, ChatPreviewOptions())?.senderName == nil)

    let exported = exportTranscript(items, TranscriptExportOptions(botName: "Bot", selfName: "You"))
    #expect(exported.text.contains("You via Claude Code"))
    #expect(exported.markdown.contains("**You via Claude Code**"))
  }
}
