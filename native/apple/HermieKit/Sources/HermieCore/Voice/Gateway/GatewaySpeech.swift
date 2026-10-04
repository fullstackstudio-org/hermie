import Foundation
import HermieProtocol

/// Where a reply's voice comes from: the device's own synthesiser, or the gateway's text-to-speech
/// chain (Edge, ElevenLabs, OpenAI, … as the gateway is set up).
public enum SpeechSource: String, Sendable, CaseIterable {
  case apple
  case gateway
}

/// A voice the gateway can speak in.
public struct GatewayVoice: Sendable, Equatable, Identifiable {
  /// What the gateway takes as the voice (`voice_id` for ElevenLabs, a voice name for Edge).
  public var id: String
  public var name: String
  /// How the gateway lists it ("Rachel (premade)", "My voice (cloned)").
  public var label: String
  /// A BCP-47 tag, when the gateway says.
  public var language: String?
  /// The gateway has a recorded sample of this voice to play (`preview: true` in ElevenLabs' list).
  /// False when it says nothing: a button is only shown for what the gateway says is there.
  public var hasSample: Bool

  public init(id: String, name: String, label: String? = nil, language: String? = nil, hasSample: Bool = false) {
    self.id = id
    self.name = name
    self.label = label ?? name
    self.language = language
    self.hasSample = hasSample
  }

  /// One entry of a voice list: `voice_id` (or `id`), `name`, `label`, `language`. Nil without an id.
  init?(json: JSONValue) {
    guard let object = json.objectValue else {
      return nil
    }

    let id = (object["voice_id"]?.stringValue ?? object["id"]?.stringValue ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard !id.isEmpty else {
      return nil
    }

    let name = object["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? id
    let label = object["label"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    let language = object["language"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    self.init(id: id, name: name, label: label, language: language, hasSample: object["preview"]?.boolValue == true)
  }

  /// `GET /api/audio/elevenlabs/voices`: `{available, voices: [{voice_id, name, label, preview}]}`. Empty for a
  /// gateway with no ElevenLabs key.
  static func elevenLabsList(_ body: JSONValue?) -> [GatewayVoice] {
    guard body?["available"]?.boolValue != false else {
      return []
    }

    return (body?["voices"]?.arrayValue ?? []).compactMap(GatewayVoice.init(json:))
  }
}

/// How a voice can be heard before it is chosen, as `tts.voice_preview` says: free, or not at all.
public enum GatewayVoicePreview: String, Sendable, Equatable {
  /// A recorded sample per voice (ElevenLabs): `GET /api/audio/elevenlabs/voices/{id}/preview`.
  case sample
  /// The voice speaks a short sentence through `POST /api/audio/speak` (Edge, which costs nothing).
  case speak
}

/// Why the gateway's voice list is empty, as `tts.voices_error` says.
public enum GatewayVoicesError: String, Sendable, Equatable {
  /// The provider's list cannot be read now.
  case unavailable
  /// The gateway is still reading it.
  case loading
}

/**
 What `GET /api/audio/voice-config` says about the gateway's text-to-speech, reduced to what the app
 uses.

 The route is the desktop's CLIENT-DIRECT config: for a provider the client could call itself it hands
 over that provider's address AND API KEY. **The key is never read here.** Only the provider's name and
 the voice it is set to are, so nothing this value holds can leak one, whatever is logged or kept.

 - `tts` is `{"mode": "direct", "provider": …, "voice": …}` for OpenAI, ElevenLabs and DeepInfra, and
   `{"mode": "relay", "reason": …}` for the rest (Edge, local engines, plugins), which the gateway
   serves itself through `/api/audio/speak`. Either way the gateway can speak: TTS is available when
   the answer has a `tts` object at all, and not when the route is missing or failed.
 - A relay verdict names its provider only inside its reason ("provider 'edge' has no client wire").
 - `voice_preview` says whether a voice may be heard before it is chosen, and how: `"sample"` (a
   recording per voice) or `"speak"` (the voice says a sentence; free). Absent, the provider is a paid
   one and the app offers no preview at all.
 - `prosody` is a gateway that takes pace and pitch with a request; `voices_error` (`unavailable` or
   `loading`) says the voice list could not be had, and the app shows it empty with a retry.
 - Two optional fields are for a gateway that can speak in a voice the request names, which the
   gateway as shipped cannot (`TTSSpeakRequest` is just `text`): `voice_selection: true`, and for a
   provider with no voice list of its own, `voices: [{id, name, language}]`. Without
   `voice_selection` the app offers no voice to pick and says nothing of one.
 */
public struct GatewayVoiceConfig: Sendable, Equatable {
  /// The gateway can speak: its text-to-speech is set up, directly or through the relay.
  public var ttsAvailable: Bool
  /// The provider's id as the gateway names it (`elevenlabs`, `openai`, `edge`), when it says.
  public var provider: String?
  /// The voice the gateway speaks in unless told otherwise, when it says (only a direct provider's).
  public var defaultVoice: String?
  /// A request may name the voice.
  public var voiceSelection: Bool
  /// The voices the gateway lists for its provider (not ElevenLabs': `elevenLabsVoices` is its own route).
  public var voices: [GatewayVoice]
  /// How a voice can be heard before it is chosen; nil where it may not be (a paid provider).
  public var voicePreview: GatewayVoicePreview?
  /// The gateway takes pace and pitch with a request.
  public var prosody: Bool
  /// Why the voice list is empty, when the gateway says it could not read it.
  public var voicesError: GatewayVoicesError?

  public init(
    ttsAvailable: Bool, provider: String? = nil, defaultVoice: String? = nil, voiceSelection: Bool = false,
    voices: [GatewayVoice] = [], voicePreview: GatewayVoicePreview? = nil, prosody: Bool = false,
    voicesError: GatewayVoicesError? = nil
  ) {
    self.ttsAvailable = ttsAvailable
    self.provider = provider
    self.defaultVoice = defaultVoice
    self.voiceSelection = voiceSelection
    self.voices = voices
    self.voicePreview = voicePreview
    self.prosody = prosody
    self.voicesError = voicesError
  }

  /// A gateway that cannot be asked, or that cannot speak.
  public static let unavailable = GatewayVoiceConfig(ttsAvailable: false)

  public var isElevenLabs: Bool { provider == "elevenlabs" }

  /// The provider as a person reads it: a brand's own spelling.
  public var providerName: String? {
    provider.map(Self.displayName(of:))
  }

  /// A voice the gateway lets the person choose between: ElevenLabs'. The list is fetched separately.
  public var choosesFromList: Bool { voiceSelection && (isElevenLabs || !voices.isEmpty) }

  /// Parse the route's body. A body that is not a gateway's answer is "unavailable".
  public static func parse(_ body: JSONValue?) -> GatewayVoiceConfig {
    guard let tts = body?["tts"]?.objectValue else {
      return .unavailable
    }

    var provider = tts["provider"]?.stringValue.map { $0.lowercased() }

    if provider == nil, let reason = tts["reason"]?.stringValue {
      provider = relayedProvider(in: reason)
    }

    let voice = tts["voice"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    let voices = (tts["voices"]?.arrayValue ?? []).compactMap(GatewayVoice.init(json:))

    return GatewayVoiceConfig(
      ttsAvailable: true, provider: provider.flatMap { $0.isEmpty ? nil : $0 }, defaultVoice: voice,
      voiceSelection: tts["voice_selection"]?.boolValue == true, voices: voices,
      voicePreview: tts["voice_preview"]?.stringValue.flatMap(GatewayVoicePreview.init(rawValue:)),
      prosody: tts["prosody"]?.boolValue == true,
      voicesError: tts["voices_error"]?.stringValue.flatMap(GatewayVoicesError.init(rawValue:)))
  }

  /// `provider 'edge' has no client wire` → `edge`.
  static func relayedProvider(in reason: String) -> String? {
    guard let range = reason.range(of: #"provider '([^']+)'"#, options: .regularExpression) else {
      return nil
    }

    let quoted = reason[range].dropFirst("provider '".count).dropLast()
    return quoted.isEmpty ? nil : quoted.lowercased()
  }

  static func displayName(of provider: String) -> String {
    switch provider {
    case "elevenlabs": "ElevenLabs"
    case "openai": "OpenAI"
    case "edge": "Edge"
    case "deepinfra": "DeepInfra"
    case "xai": "xAI"
    case "minimax": "MiniMax"
    case "mistral": "Mistral"
    case "gemini": "Gemini"
    case "neutts": "NeuTTS"
    case "kittentts": "KittenTTS"
    case "piper": "Piper"
    default: provider.prefix(1).uppercased() + provider.dropFirst()
    }
  }
}

/// One spoken sentence, as the gateway's `POST /api/audio/speak` returns it: the file's bytes and its type.
public struct GatewayAudioClip: Sendable, Equatable {
  public var data: Data
  /// `audio/mpeg`, `audio/wav`, `audio/ogg`, …
  public var mimeType: String

  public init(data: Data, mimeType: String) {
    self.data = data
    self.mimeType = mimeType
  }

  /// `{ok, data_url: "data:audio/mpeg;base64,…", mime_type}`; nil for anything else.
  static func parse(_ body: JSONValue?) -> GatewayAudioClip? {
    guard let url = body?["data_url"]?.stringValue, url.hasPrefix("data:"), let comma = url.firstIndex(of: ",") else {
      return nil
    }

    let header = url[url.index(url.startIndex, offsetBy: 5)..<comma]
    let type = header.split(separator: ";").first.map(String.init) ?? ""
    let mime = body?["mime_type"]?.stringValue ?? (type.isEmpty ? "audio/mpeg" : type)

    guard header.contains("base64"), let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
      !data.isEmpty
    else {
      return nil
    }

    return GatewayAudioClip(data: data, mimeType: mime)
  }
}

/// What `WS /api/audio/speak-stream` says, in order.
public enum GatewayStreamEvent: Sendable, Equatable {
  /// The PCM that follows: signed 16-bit little-endian samples at this rate.
  case start(sampleRate: Double, channels: Int)
  /// Raw PCM bytes (a frame may end between the two bytes of a sample).
  case pcm(Data)
  /// The whole text has been spoken.
  case end
  /// The provider has no chunked API: use `POST /api/audio/speak`.
  case fallback
  /// The gateway refused the request's voice or prosody and closed: `code` is `invalid_voice`,
  /// `unknown_voice`, `voice_unsupported`, `voice_failed` or `invalid_prosody` (or one a newer gateway adds).
  case error(code: String, message: String)
}

/**
 The gateway's speech routes, behind one seam: `LiveGatewaySpeech` talks to a gateway, a fake in the
 tests. `profile` is the bot's handle (the gateway resolves the TTS chain and its keys per profile);
 nil is the gateway's own default.
 */
public protocol GatewaySpeechTransport: Sendable {
  func voiceConfig(profile: String?) async throws -> GatewayVoiceConfig
  func elevenLabsVoices(profile: String?) async throws -> [GatewayVoice]
  /// `POST /api/audio/speak`: the whole sentence as one clip. `voice` is sent only when it is named.
  func speak(text: String, profile: String?, voice: String?) async throws -> GatewayAudioClip
  /// `GET /api/audio/elevenlabs/voices/{id}/preview`: the recorded sample of one ElevenLabs voice.
  /// Throws `GatewayPreviewError.noSample` where the gateway has none (404).
  func previewSample(voiceID: String, profile: String?) async throws -> GatewayAudioClip
  /// `WS /api/audio/speak-stream`: the text as one piece, its audio as it is made. The stream ends
  /// after `.end`, `.fallback` or `.error`, or throws; cancelling the consumer closes the socket (barge-in).
  func stream(text: String, profile: String?, voice: String?) -> AsyncThrowingStream<GatewayStreamEvent, any Error>
}

/// Why a voice's sample could not be had.
public enum GatewayPreviewError: Error, Equatable, Sendable {
  /// The gateway has no sample of this voice.
  case noSample
}
