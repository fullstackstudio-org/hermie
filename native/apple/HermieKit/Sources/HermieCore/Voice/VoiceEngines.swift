import Foundation

/// Where a chat screen gets its recogniser and its synthesiser: the platform's in the app, fakes in the
/// tests. One of each per chat screen, not shared: each holds the one session it has started, and two
/// chats on one engine would cut each other off without either knowing.
public struct VoiceEngines: Sendable {
  public var dictation: @MainActor @Sendable () -> any DictationEngine
  public var speech: @MainActor @Sendable () -> any SpeechSynthesizing
  /// A voice mode call's engines, made fresh for each call.
  public var call: @MainActor @Sendable () -> VoiceModeEngines
  /// The same two with the gateway's voice as a second source; nil where there is none (the tests'
  /// fakes), and then the device's voice is the only one.
  public var gateway: GatewayVoiceEngines?

  public init(
    dictation: @escaping @MainActor @Sendable () -> any DictationEngine,
    speech: @escaping @MainActor @Sendable () -> any SpeechSynthesizing,
    call: @escaping @MainActor @Sendable () -> VoiceModeEngines = { AppleVoiceModeEngine.call() },
    gateway: GatewayVoiceEngines? = nil
  ) {
    self.dictation = dictation
    self.speech = speech
    self.call = call
    self.gateway = gateway
  }

  /// `SFSpeechRecognizer` with `AVAudioEngine`, and `AVSpeechSynthesizer`; for a call, one
  /// `AVAudioEngine` that listens and speaks (`AppleVoiceModeEngine`). The gateway's text-to-speech
  /// is the second source of both.
  public static let live = VoiceEngines(
    dictation: { AppleSpeechRecognizer() },
    speech: { AppleSpeechSynthesizer() },
    call: { AppleVoiceModeEngine.call() },
    gateway: .live
  )

  /// A synthesiser for reading and for previews: one that can also speak the gateway's voice where
  /// there is a gateway to ask.
  @MainActor
  public func speech(gateway access: GatewaySpeechAccess?) -> any SpeechSynthesizing {
    guard let access, let gateway else {
      return speech()
    }

    return gateway.speech(access)
  }

  /// A call's engines, the gateway's voice among the sources where there is a gateway to ask.
  @MainActor
  public func call(gateway access: GatewaySpeechAccess?) -> VoiceModeEngines {
    guard let access, let gateway else {
      return call()
    }

    return gateway.call(access)
  }
}

/// The gateway-aware halves of `VoiceEngines`: made around one bot's `GatewaySpeechAccess`.
public struct GatewayVoiceEngines: Sendable {
  public var speech: @MainActor @Sendable (GatewaySpeechAccess) -> any SpeechSynthesizing
  public var call: @MainActor @Sendable (GatewaySpeechAccess) -> VoiceModeEngines

  public init(
    speech: @escaping @MainActor @Sendable (GatewaySpeechAccess) -> any SpeechSynthesizing,
    call: @escaping @MainActor @Sendable (GatewaySpeechAccess) -> VoiceModeEngines
  ) {
    self.speech = speech
    self.call = call
  }

  /// The device's voices and the gateway's, the gateway's through `GatewaySpeechRenderer` with the
  /// device's renderer as its fall-back.
  public static let live = GatewayVoiceEngines(
    speech: { access in
      GatewaySpeechSynthesizer(apple: AppleSpeechSynthesizer(), renderer: renderer(access))
    },
    call: { access in
      AppleVoiceModeEngine.call(renderer: renderer(access))
    }
  )

  @MainActor
  private static func renderer(_ access: GatewaySpeechAccess) -> GatewaySpeechRenderer {
    GatewaySpeechRenderer(
      transport: access.transport, profile: access.profile, fallback: AppleSpeechRenderer(),
      available: { [weak access] in access?.mayBeAvailable ?? false })
  }
}
