import Foundation
import HermieProtocol

/// A voice a bot was given of its own (bot settings › Voice): a source, and the voice in it. A nil voice
/// is the source's own choice: "automatic" for the device, the gateway's configured voice for the gateway.
public struct BotVoice: Sendable, Equatable {
  public var source: SpeechSource
  /// The device voice's identifier, or the gateway voice's id.
  public var voice: String?
  /// For a gateway voice: the provider it was chosen from (`edge`, `elevenlabs`), when it was kept. A choice kept
  /// before this was has none. Which voice it is does not depend on it, so it is left out of `==`.
  public var provider: String?

  public init(source: SpeechSource, voice: String? = nil, provider: String? = nil) {
    self.source = source
    self.voice = voice
    self.provider = provider
  }

  init?(json: JSONValue) {
    guard let source = json["source"]?.stringValue.flatMap(SpeechSource.init(rawValue:)) else {
      return nil
    }

    self.init(
      source: source, voice: json["voice"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      provider: json["provider"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 })
  }

  public static func == (left: BotVoice, right: BotVoice) -> Bool {
    left.source == right.source && left.voice == right.voice
  }

  var json: JSONValue {
    var object: JSONObject = ["source": .string(source.rawValue)]

    if let voice {
      object["voice"] = .string(voice)

      if let provider {
        object["provider"] = .string(provider)
      }
    }

    return .object(object)
  }
}

/// Who speaks one bot's replies, resolved from the settings (`VoiceSettings.speech(bot:gatewayID:)`).
public struct SpeechChoice: Sendable, Equatable {
  public var source: SpeechSource
  /// The device voice's identifier; nil lets the system choose by the reply's language. With the
  /// gateway as the source it is the voice that speaks when the gateway cannot.
  public var appleVoice: String?
  /// The gateway's voice id; nil is the gateway's own.
  public var gatewayVoice: String?
  /// The provider `gatewayVoice` was chosen from, when it was kept: the voice is only sent to a profile that speaks
  /// through the same one.
  public var gatewayProvider: String?

  public init(
    source: SpeechSource = .apple, appleVoice: String? = nil, gatewayVoice: String? = nil, gatewayProvider: String? = nil
  ) {
    self.source = source
    self.appleVoice = appleVoice
    self.gatewayVoice = gatewayVoice
    self.gatewayProvider = gatewayProvider
  }
}
