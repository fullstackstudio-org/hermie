import Foundation
import Testing

@testable import HermieGateway

/// The audio socket's dial, and the message stream a channel that has only text frames still offers.
@Suite(.timeLimit(.minutes(1))) struct AudioSocketTests {
  @Test func aTicketOfferedAsASubprotocolMovesToTheQuery() {
    let plan = DialPlan(
      url: "wss://gateway.example.test/api/audio/speak-stream?profile=writer",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.tk-abc"], headers: ["x-front-door": "yes"])

    let moved = GatewayAudioSocket.movingTicketToQuery(plan)

    #expect(moved.url == "wss://gateway.example.test/api/audio/speak-stream?profile=writer&ticket=tk-abc")
    #expect(moved.protocols.isEmpty)
    #expect(moved.headers == ["x-front-door": "yes"], "a front door's header is not a credential to move")
  }

  @Test func aTicketWithCharactersThatNeedEscapingIsEscaped() {
    let plan = DialPlan(url: "wss://g.example.test/x", protocols: ["hermes-gateway-ticket.a b&c"])

    #expect(GatewayAudioSocket.movingTicketToQuery(plan).url == "wss://g.example.test/x?ticket=a%20b%26c")
  }

  @Test func aPlanWithNoTicketIsLeftAsItIs() {
    let plan = DialPlan(url: "wss://g.example.test/x?token=t", protocols: [], headers: [:])

    #expect(GatewayAudioSocket.movingTicketToQuery(plan) == plan)
  }

  @Test func theAudioRouteIsUnderTheGatewaysOwnPrefix() throws {
    #expect(
      try GatewayAddress.webSocketURL(for: "https://example.test/prefix/", path: GatewayAudioSocket.path)
        == "wss://example.test/prefix/api/audio/speak-stream")
    #expect(try GatewayAddress.webSocketURL(for: "http://localhost:9000") == "ws://localhost:9000/api/ws")
  }

  @Test func aChannelWithOnlyTextFramesOffersThemAsTextMessages() async throws {
    let channel = TextOnlyChannel(["{\"a\":1}", "two"])
    var seen: [WebSocketMessage] = []

    for try await message in channel.messages {
      seen.append(message)
    }

    #expect(seen == [.text("{\"a\":1}"), .text("two")])
  }

  @Test func theCloseOfSuchAChannelIsThrownThroughTheMessages() async {
    let channel = TextOnlyChannel(["one"], endingWith: WebSocketClosed(code: 4401, reason: "no"))

    do {
      for try await _ in channel.messages {}
      Issue.record("The stream should have thrown.")
    } catch {
      #expect((error as? WebSocketClosed)?.code == 4401)
    }
  }
}

private final class TextOnlyChannel: WebSocketChannel {
  let frames: AsyncThrowingStream<String, any Error>

  init(_ texts: [String], endingWith error: WebSocketClosed? = nil) {
    frames = AsyncThrowingStream { continuation in
      for text in texts {
        continuation.yield(text)
      }

      continuation.finish(throwing: error)
    }
  }

  func send(text: String) async throws {}
  func close(code: Int, reason: String?) async {}
}
