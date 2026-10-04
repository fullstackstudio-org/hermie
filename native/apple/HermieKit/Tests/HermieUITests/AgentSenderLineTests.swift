import Foundation
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieUI

/// A turn an agent sent for a person: the line under its bubble, and its place among the bubbles.
@MainActor
@Suite struct AgentSenderLineTests {
  private let agent = AuthorVia(kind: "mcp", client: "Example Agent")

  @Test func theLineReadsNameViaClientBeforeTheTime() {
    #expect(
      UserBubbleView.metaLine(sender: "Robin", via: agent, clock: "21:42")
        == "\u{2068}Robin\u{2069} via \u{2068}Example Agent\u{2069} · 21:42")
  }

  @Test func withoutANameItReadsViaClient() {
    #expect(UserBubbleView.metaLine(sender: nil, via: agent, clock: "21:42") == "via \u{2068}Example Agent\u{2069} · 21:42")
    #expect(UserBubbleView.metaLine(sender: "\u{202E}", via: agent, clock: "21:42") == "via \u{2068}Example Agent\u{2069} · 21:42")
  }

  @Test func aTurnWithoutTheMarkerIsAsItWas() {
    #expect(UserBubbleView.metaLine(sender: "Sam", via: nil, clock: "21:42") == "\u{2068}Sam\u{2069} · 21:42")
    #expect(UserBubbleView.metaLine(sender: nil, via: nil, clock: "21:42") == "21:42")
  }

  @Test func theNameAndTheClientAreEachCleanedAndBounded() {
    let hostile = AuthorVia(kind: "mcp", client: "Ex\u{202E}ample\nAgent")
    #expect(
      UserBubbleView.metaLine(sender: "Ro\u{200B}bin", via: hostile, clock: "21:42")
        == "\u{2068}Robin\u{2069} via \u{2068}Example Agent\u{2069} · 21:42")

    let long = AuthorVia(kind: "mcp", client: String(repeating: "a", count: 200))
    let line = UserBubbleView.metaLine(sender: nil, via: long, clock: "21:42")
    let client = line.dropFirst("via \u{2068}".count).prefix { $0 != "\u{2069}" }
    #expect(client.count == UserBubbleView.viaClientLimit + 1, "the limit and an ellipsis")
  }

  @Test func aMarkerWithNothingLeftOfItsClientIsNoMarker() {
    let empty = AuthorVia(kind: "mcp", client: "\u{202E}\u{200B}")

    #expect(UserBubbleView.metaLine(sender: "Robin", via: empty, clock: "21:42") == "\u{2068}Robin\u{2069} · 21:42")
    #expect(UserBubbleView.metaLine(sender: nil, via: empty, clock: "21:42") == "21:42")
  }

  @Test func voiceOverGetsThePlainLabel() {
    #expect(UserBubbleView.senderLabel(name: "Robin", via: agent, isolated: false) == "Robin via Example Agent")
    #expect(UserBubbleView.senderLabel(name: nil, via: agent, isolated: false) == "via Example Agent")
    #expect(UserBubbleView.senderLabel(name: "Robin", via: nil, isolated: false) == "Robin")
    #expect(UserBubbleView.senderLabel(name: nil, via: nil, isolated: false) == nil)
  }

  @Test func anAgentsTurnNeverJoinsThePersonsOwnBubbles() {
    func row(_ id: String, via: AuthorVia?) -> VisibleItem {
      let base = ItemBase(id: id, seq: 0, ts: 1000, origin: .history, version: 1)
      let author = MessageAuthor(id: "oidc:me", name: "Robin", via: via)
      return VisibleItem(item: .user(UserItem(base: base, text: "hello", author: author)), presentation: .full)
    }

    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [row("u1", via: nil), row("u2", via: agent), row("u3", via: agent), row("u4", via: nil)])
    let layout = rows.map { $0.bubble.map { "\($0.opensGroup ? "o" : "-")\($0.closesGroup ? "c" : "-")" } ?? "nil" }

    // Each turn from the agent keeps its own line; the two agent turns group, the person's do not join them.
    #expect(layout == ["oc", "o-", "-c", "oc"])
  }
}
