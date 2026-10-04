import Foundation
import HermieProtocol

/// A voice a bot was given of its own (bot settings › Voice): a source, and the voice in it. A nil voice
/// is the source's own choice: "automatic" for the device, the gateway's configured voice for the gateway.
public struct BotVoice: Sendable, Equatable {
  public var source: SpeechSource
  /// The device voice's identifier, or the gateway voice's id.
  public var voice: String?

  public init(source: SpeechSource, voice: String? = nil) {
    self.source = source
    self.voice = voice
  }

  init?(json: JSONValue) {
    guard let source = json["source"]?.stringValue.flatMap(SpeechSource.init(rawValue:)) else {
      return nil
    }

    self.init(source: source, voice: json["voice"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 })
  }

  var json: JSONValue {
    var object: JSONObject = ["source": .string(source.rawValue)]

    if let voice {
      object["voice"] = .string(voice)
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

  public init(source: SpeechSource = .apple, appleVoice: String? = nil, gatewayVoice: String? = nil) {
    self.source = source
    self.appleVoice = appleVoice
    self.gatewayVoice = gatewayVoice
  }
}
