import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A socket that says what the test scripted and records what it was sent.
final class ScriptedAudioSocket: WebSocketChannel, @unchecked Sendable {
  private struct State {
    var sent: [String] = []
    var closes = 0
  }

  private let state = Mutex(State())
  let messages: AsyncThrowingStream<WebSocketMessage, any Error>
  private let continuation: AsyncThrowingStream<WebSocketMessage, any Error>.Continuation

  var frames: AsyncThrowingStream<String, any Error> { AsyncThrowingStream { $0.finish() } }
  var sent: [String] { state.withLock { $0.sent } }
  var closes: Int { state.withLock { $0.closes } }

  init() {
    (messages, continuation) = AsyncThrowingStream<WebSocketMessage, any Error>.makeStream()
  }

  func send(text: String) async throws {
    state.withLock { $0.sent.append(text) }
  }

  func close(code: Int, reason: String?) async {
    state.withLock { $0.closes += 1 }
    continuation.finish()
  }

  func receive(_ message: WebSocketMessage) { continuation.yield(message) }
  func end(throwing error: (any Error)? = nil) { continuation.finish(throwing: error) }
}

final class ScriptedSocketTransport: WebSocketTransport, @unchecked Sendable {
  let socket = ScriptedAudioSocket()
  private let requests = Mutex<[(url: String, protocols: [String])]>([])

  var requested: [(url: String, protocols: [String])] { requests.withLock { $0 } }

  func connect(_ request: URLRequest, subprotocols: [String]) async throws -> any WebSocketChannel {
    requests.withLock { $0.append((request.url?.absoluteString ?? "", subprotocols)) }
    return socket
  }
}

/// A credential that mints the ticket of a gated gateway, as the native sign-in does: on the subprotocol list.
struct TicketCredentials: CredentialProvider {
  let mode = GatewayAuthMode.nativePKCE

  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] { [:] }

  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    DialPlan(url: wsURL, protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.tk-123"], headers: extraHeaders)
  }

  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict { .reauth }
  func signOut() async throws {}
}

/// The audio socket as the live speech transport drives it: what it sends, how it reads binary frames, and
/// that cutting in closes it.
@Suite(.timeLimit(.minutes(1))) struct LiveGatewaySpeechStreamTests {
  private func make(
    credentials: any CredentialProvider = SessionTokenCredentials(token: "sekrit")
  ) throws -> (speech: LiveGatewaySpeech, sockets: ScriptedSocketTransport) {
    let sockets = ScriptedSocketTransport()
    let http = try HTTPClient(baseURL: "https://gateway.example.test", credentials: credentials)
    let speech = LiveGatewaySpeech(
      http: http, baseURL: "https://gateway.example.test", credentials: credentials, extraHeaders: [:], sockets: sockets)
    return (speech, sockets)
  }

  private func firstSent(_ sockets: ScriptedSocketTransport) throws -> JSONObject {
    let text = try #require(sockets.socket.sent.first)
    let object = try JSONValue(parsing: text).objectValue
    return try #require(object)
  }

  private func collect(_ stream: AsyncThrowingStream<GatewayStreamEvent, any Error>) async -> (
    events: [GatewayStreamEvent], error: (any Error)?
  ) {
    var events: [GatewayStreamEvent] = []

    do {
      for try await event in stream {
        events.append(event)
      }

      return (events, nil)
    } catch {
      return (events, error)
    }
  }

  @Test func theTextIsSentAsOnePieceAndTheAudioComesBackInBinaryFramesUntilEnd() async throws {
    let (speech, sockets) = try make()
    let pcm = AudioFixtures.pcm(frames: 10)

    let stream = speech.stream(text: "Hello there.", profile: "researcher", voice: "voice-adam")
    let reader = Task { await collect(stream) }

    while sockets.requested.isEmpty || sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    sockets.socket.receive(.text(#"{"type":"start","sample_rate":24000,"channels":1}"#))
    sockets.socket.receive(.binary(pcm))
    sockets.socket.receive(.binary(pcm.prefix(3)))
    sockets.socket.receive(.text(#"{"type":"end"}"#))

    let (events, error) = await reader.value

    #expect(error == nil)
    #expect(events == [.start(sampleRate: 24_000, channels: 1), .pcm(pcm), .pcm(pcm.prefix(3)), .end])

    let url = try #require(sockets.requested.first?.url)
    #expect(url.hasPrefix("wss://gateway.example.test/api/audio/speak-stream?"))
    #expect(url.contains("profile=researcher"))
    #expect(url.contains("token=sekrit"), "an ungated gateway's credential goes on the query")

    let sent = try firstSent(sockets)
    #expect(sent["text"] == .string("Hello there."))
    #expect(sent["done"] == .bool(true))
    #expect(sent["voice"] == .string("voice-adam"))
    #expect(sockets.socket.closes >= 1, "the socket is closed once the sentence is over")
  }

  @Test func noVoiceIsSentWhenNoneIsChosen() async throws {
    let (speech, sockets) = try make()
    let reader = Task { await collect(speech.stream(text: "Hi.", profile: nil, voice: nil)) }

    while sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    sockets.socket.receive(.text(#"{"type":"fallback"}"#))
    let (events, _) = await reader.value
    let sent = try firstSent(sockets)
    let url = sockets.requested.first?.url ?? ""

    #expect(sent["voice"] == nil)
    #expect(events == [.fallback])
    #expect(!url.contains("profile="))
  }

  @Test func aGatedGatewaysTicketGoesOnTheQueryNotTheSubprotocolList() async throws {
    let (speech, sockets) = try make(credentials: TicketCredentials())
    let reader = Task { await collect(speech.stream(text: "Hi.", profile: "writer", voice: nil)) }

    while sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    sockets.socket.receive(.text(#"{"type":"end"}"#))
    _ = await reader.value

    let request = try #require(sockets.requested.first)
    #expect(request.url.contains("ticket=tk-123"))
    #expect(request.url.contains("profile=writer"))
    #expect(request.protocols.isEmpty, "the route answers the upgrade without selecting a subprotocol")
  }

  @Test func aSocketThatEndsWithoutAnEndFrameIsAFailure() async throws {
    let (speech, sockets) = try make()
    let reader = Task { await collect(speech.stream(text: "Hi.", profile: nil, voice: nil)) }

    while sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    sockets.socket.receive(.text(#"{"type":"start","sample_rate":24000,"channels":1}"#))
    sockets.socket.end()
    let (events, error) = await reader.value

    #expect(events == [.start(sampleRate: 24_000, channels: 1)])
    #expect(error as? GatewayError != nil)
  }

  @Test func aSocketThatIsClosedByTheGatewayThrowsItsClose() async throws {
    let (speech, sockets) = try make()
    let reader = Task { await collect(speech.stream(text: "Hi.", profile: nil, voice: nil)) }

    while sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    sockets.socket.end(throwing: WebSocketClosed(code: 4401, reason: "unauthorized"))
    let (_, error) = await reader.value

    #expect((error as? WebSocketClosed)?.code == 4401)
  }

  @Test func cuttingInClosesTheSocket() async throws {
    let (speech, sockets) = try make()
    let reader = Task { await collect(speech.stream(text: "Hi.", profile: nil, voice: nil)) }

    while sockets.socket.sent.isEmpty {
      await Task.yield()
    }

    reader.cancel()
    _ = await reader.value

    for _ in 0..<500 where sockets.socket.closes == 0 {
      try await Task.sleep(for: .milliseconds(5))
    }

    #expect(sockets.socket.closes >= 1)
  }
}
