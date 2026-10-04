import Foundation
import Observation

/**
 What one bot's gateway offers to speak with, as the screens and the speaking engines ask it: whether
 its text-to-speech is there, which provider, and which voices can be chosen. The answers are read from
 the gateway on demand (`loadConfig`, `loadVoices`) and kept.

 `profile` is the bot's handle: the gateway resolves the text-to-speech chain, and the keys it needs,
 per profile, so two bots on one gateway may speak through different providers.
 */
@MainActor
@Observable
public final class GatewaySpeechAccess {
  public let transport: any GatewaySpeechTransport
  public let profile: String?

  /// `voice-config`, once it has answered; nil before that. A gateway that did not answer (no such
  /// route, unreachable) is `unavailable`, and is asked again the next time.
  public private(set) var config: GatewayVoiceConfig?
  /// ElevenLabs' voices, cloned ones included; empty until read, and for any other provider.
  public private(set) var elevenLabsVoices: [GatewayVoice] = []
  public private(set) var loadingVoices = false
  public private(set) var voicesLoaded = false

  @ObservationIgnored private var configFailed = false
  @ObservationIgnored private var loadingConfig: Task<Void, Never>?

  public init(transport: any GatewaySpeechTransport, profile: String?) {
    self.transport = transport
    self.profile = profile
  }

  /// The gateway can speak. False until `voice-config` has said so.
  public var isAvailable: Bool { config?.ttsAvailable == true }

  /// Not known to be missing: what the engines go by, so a reply read before the answer arrived is
  /// still tried against the gateway.
  public var mayBeAvailable: Bool { config?.ttsAvailable != false }

  public var providerName: String? { config?.providerName }

  /// The voices a person can choose between, when the gateway lets a request name one.
  public var selectableVoices: [GatewayVoice] {
    guard let config, config.voiceSelection else {
      return []
    }

    return config.isElevenLabs ? elevenLabsVoices : config.voices
  }

  /// A voice can be chosen: the gateway takes one per request, and has a list to choose from.
  public var canChooseVoice: Bool { config?.choosesFromList == true }

  /// Read `voice-config`. Once it has answered it is not read again; a failure is.
  public func loadConfig() async {
    if config != nil, !configFailed {
      return
    }

    if let loadingConfig {
      await loadingConfig.value
      return
    }

    let transport = transport
    let profile = profile

    let task = Task { [weak self] in
      let answer = try? await transport.voiceConfig(profile: profile)
      self?.configRead(answer)
    }

    loadingConfig = task
    await task.value
    loadingConfig = nil
  }

  private func configRead(_ answer: GatewayVoiceConfig?) {
    configFailed = answer == nil
    config = answer ?? .unavailable
  }

  /// Read the voice list of a provider that has one (ElevenLabs'): after `loadConfig`.
  public func loadVoices() async {
    guard config?.isElevenLabs == true, !voicesLoaded, !loadingVoices else {
      return
    }

    loadingVoices = true
    let list = try? await transport.elevenLabsVoices(profile: profile)
    loadingVoices = false

    if let list {
      elevenLabsVoices = list
      voicesLoaded = true
    }
  }

  /// The name of a voice for the screen: the gateway's label, or the id when it is not in the list.
  public func name(ofVoice id: String?) -> String? {
    guard let id else {
      return nil
    }

    return selectableVoices.first { $0.id == id }?.label ?? id
  }
}
