import Foundation
import HermieGateway
import HermieProtocol

/**
 The gateway's speech routes over a real connection: the link's own HTTP client for the three REST
 routes, and its own credentials and socket transport for the audio socket. Only ever this gateway.

 The streamed route is one socket per piece of text: the server's session is per reply, and what this
 app hands over is a sentence or two at a time (`SpokenReplyCutter`), so each piece is
 `{"text": …, "done": true}`, the audio is read as it arrives, and the socket ends with the piece.
 */
public struct LiveGatewaySpeech: GatewaySpeechTransport {
  private let http: HTTPClient
  private let baseURL: String
  private let credentials: any CredentialProvider
  private let extraHeaders: [String: String]
  private let sockets: any WebSocketTransport

  /// How long the REST routes may take: a sentence's synthesis, not a transcript.
  static let speakTimeoutMs = 15_000
  static let configTimeoutMs = 6_000

  public init(
    http: HTTPClient, baseURL: String, credentials: any CredentialProvider, extraHeaders: [String: String],
    sockets: any WebSocketTransport
  ) {
    self.http = http
    self.baseURL = baseURL
    self.credentials = credentials
    self.extraHeaders = extraHeaders
    self.sockets = sockets
  }

  static let configPath = "/api/audio/voice-config"
  static let voicesPath = "/api/audio/elevenlabs/voices"
  static let speakPath = "/api/audio/speak"
  /// The most a sample may weigh: a few seconds of speech, not a recording of a minute.
  static let previewMaxBytes = 4 * 1024 * 1024

  public func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig {
    GatewayVoiceConfig.parse(try await http.get(Self.configPath + Self.query(profile), timeoutMs: Self.configTimeoutMs))
  }

  public func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice] {
    GatewayVoice.elevenLabsList(try await http.get(Self.voicesPath + Self.query(profile), timeoutMs: Self.configTimeoutMs))
  }

  public func previewSample(voiceID: String, profile: String?) async throws -> GatewayAudioClip {
    let answer = try await http.fetchBinary(
      Self.previewPath(voiceID: voiceID) + Self.query(profile), maxBytes: Self.previewMaxBytes,
      timeoutMs: Self.speakTimeoutMs)

    if answer.status == 404 {
      throw GatewayPreviewError.noSample
    }

    guard let data = answer.data, !data.isEmpty else {
      throw GatewayError(
        answer.status == 0 ? .network : .protocol, "The gateway gave no sample of the voice (HTTP \(answer.status)).",
        status: answer.status == 0 ? nil : answer.status)
    }

    let type = answer.contentType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    return GatewayAudioClip(data: data, mimeType: type.hasPrefix("audio/") ? type : "audio/mpeg")
  }

  public func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip {
    var body: JSONObject = ["text": .string(text)]

    if let voice, !voice.isEmpty {
      body["voice"] = .string(voice)
    }

    let answer = try await http.post(Self.speakPath + Self.query(profile), body: .object(body), timeoutMs: Self.speakTimeoutMs)

    guard let clip = GatewayAudioClip.parse(answer) else {
      throw GatewayError(.protocol, "The gateway answered /api/audio/speak without audio.")
    }

    return clip
  }

  public func stream(text: String, profile: String?, voice: String?) -> AsyncThrowingStream<GatewayStreamEvent, any Error> {
    let baseURL = baseURL
    let credentials = credentials
    let extraHeaders = extraHeaders
    let sockets = sockets

    return AsyncThrowingStream { continuation in
      let reader = Task {
        var channel: (any WebSocketChannel)?

        do {
          let opened = try await GatewayAudioSocket.open(
            baseURL: baseURL, profile: profile, credentials: credentials, extraHeaders: extraHeaders, transport: sockets)
          channel = opened

          var request: JSONObject = ["text": .string(text), "done": .bool(true)]

          if let voice, !voice.isEmpty {
            request["voice"] = .string(voice)
          }

          try await opened.send(text: JSONValue.object(request).canonicalString())

          for try await message in opened.messages {
            switch message {
            case .binary(let data):
              continuation.yield(.pcm(data))
            case .text(let text):
              guard let event = Self.event(from: text) else {
                continue
              }

              continuation.yield(event)

              if event.endsStream {
                continuation.finish()
                await opened.close(code: WebSocketClosed.normalClosure, reason: nil)
                return
              }
            }
          }

          // The socket ended with neither: the gateway went away mid-sentence.
          continuation.finish(throwing: GatewayError(.network, "The gateway's speech socket ended early."))
        } catch {
          continuation.finish(throwing: error)
        }

        if let channel {
          await channel.close(code: WebSocketClosed.normalClosure, reason: nil)
        }
      }

      // The consumer went away (barge-in, a timeout): the socket closes, which is the protocol's stop.
      continuation.onTermination = { _ in reader.cancel() }
    }
  }

  /// A text frame: `{"type": "start", "sample_rate": N, "channels": 1}`, `{"type": "end"}`, `{"type": "fallback"}`,
  /// `{"type": "error", "code": …, "message": …}` (the socket closes after the last three).
  static func event(from text: String) -> GatewayStreamEvent? {
    guard let frame = try? JSONValue(parsing: text), let type = frame["type"]?.stringValue else {
      return nil
    }

    switch type {
    case "start":
      let rate = frame["sample_rate"]?.doubleValue ?? 0
      let channels = frame["channels"]?.intValue ?? 1
      return rate > 0 ? .start(sampleRate: rate, channels: max(1, channels)) : nil
    case "end": return .end
    case "fallback": return .fallback
    case "error":
      let code = frame["code"]?.stringValue ?? ""
      return .error(code: code.isEmpty ? "unknown" : code, message: frame["message"]?.stringValue ?? "")
    default: return nil
    }
  }

  /// `/api/audio/elevenlabs/voices/{id}/preview`, the id as one path segment.
  static func previewPath(voiceID: String) -> String {
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
    return voicesPath + "/" + (voiceID.addingPercentEncoding(withAllowedCharacters: allowed) ?? voiceID) + "/preview"
  }

  static func query(_ profile: String?) -> String {
    guard let profile, !profile.isEmpty else {
      return ""
    }

    let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?"))
    return "?profile=" + (profile.addingPercentEncoding(withAllowedCharacters: allowed) ?? profile)
  }
}

extension GatewayStreamEvent {
  /// The gateway has nothing more to say on this socket after it.
  var endsStream: Bool {
    switch self {
    case .end, .fallback, .error: true
    case .start, .pcm: false
    }
  }
}
