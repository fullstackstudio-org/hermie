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

  /// How long a gateway that is still reading its voice list (`voices_error: "loading"`) is given, and how
  /// many times it is asked again before the screen offers a retry instead.
  @ObservationIgnored private let loadingRetryDelay: Duration
  public static let loadingRetries = 3

  /// What the gateway has refused this profile this session (a voice it does not know, a voice it cannot stream),
  /// shared by every renderer that speaks as it: one refusal is learned once, not by each chat and call.
  @ObservationIgnored public let refusals = GatewayStreamSupport()

  @ObservationIgnored private var configFailed = false
  @ObservationIgnored private var loadingConfig: Task<Void, Never>?

  public init(transport: any GatewaySpeechTransport, profile: String?, loadingRetryDelay: Duration = .seconds(2)) {
    self.transport = transport
    self.profile = profile
    self.loadingRetryDelay = loadingRetryDelay
  }

  /// The gateway can speak. False until `voice-config` has said so.
  public var isAvailable: Bool { config?.ttsAvailable == true }

  /// Not known to be missing: what the engines go by, so a reply read before the answer arrived is
  /// still tried against the gateway.
  public var mayBeAvailable: Bool { config?.ttsAvailable != false }

  public var providerName: String? { config?.providerName }

  /// The voices a person can choose between, when the gateway lets a request name one. Empty while the
  /// gateway says it could not read its list (`voicesError`).
  public var selectableVoices: [GatewayVoice] {
    guard let config, config.voiceSelection, config.voicesError == nil else {
      return []
    }

    return config.isElevenLabs ? elevenLabsVoices : config.voices
  }

  /// A voice can be chosen: the gateway takes one per request, and has a list to choose from.
  public var canChooseVoice: Bool { config?.choosesFromList == true }

  /// The gateway says it could not read its voice list; a retry asks again.
  public var voicesError: GatewayVoicesError? { config?.voicesError }

  /// A voice may be heard before it is chosen, and the gateway says that is free: a sample of ElevenLabs'
  /// voices that have one, any voice of a provider that speaks for nothing. A paid provider: never.
  public func canPreview(_ voice: GatewayVoice) -> Bool {
    switch config?.voicePreview {
    case .sample: voice.hasSample
    case .speak: true
    case nil: false
    }
  }

  /// The audio of `voice` to hear before choosing it: its recorded sample, or `sentence` spoken in it,
  /// as `voice_preview` says. Throws `GatewayPreviewError.noSample` where the gateway offers neither.
  public func previewClip(for voice: GatewayVoice, sentence: String) async throws -> GatewayAudioClip {
    switch config?.voicePreview {
    case .sample: try await transport.previewSample(voiceID: voice.id, profile: profile)
    case .speak: try await transport.speak(text: sentence, profile: profile, voice: voice.id)
    case nil: throw GatewayPreviewError.noSample
    }
  }

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

  /// Ask again for a voice list the gateway could not give: `voice-config` is read anew (it carries the
  /// verdict and Edge's list), and ElevenLabs' list after it. A failed read leaves what was there.
  public func retryVoices() async {
    guard !loadingVoices else {
      return
    }

    loadingVoices = true
    let answer = try? await transport.voiceConfig(profile: profile)
    loadingVoices = false

    if let answer {
      configRead(answer)
    }

    voicesLoaded = false
    await loadVoices()
  }

  /// A gateway on a cold cache says `voices_error: "loading"` with no voices while it fetches them: ask
  /// again after a moment, up to `loadingRetries` times, with the list shown as loading meanwhile.
  private func waitOutLoadingVoices() async {
    var attempts = 0

    while config?.voicesError == .loading, attempts < Self.loadingRetries, !loadingVoices {
      attempts += 1
      loadingVoices = true

      do {
        try await Task.sleep(for: loadingRetryDelay)
      } catch {
        loadingVoices = false
        return
      }

      let answer = try? await transport.voiceConfig(profile: profile)
      loadingVoices = false

      if let answer {
        configRead(answer)
      }
    }
  }

  /// Read the voice list of a provider that has one (ElevenLabs'): after `loadConfig`.
  public func loadVoices() async {
    await waitOutLoadingVoices()

    guard config?.isElevenLabs == true, config?.voicesError == nil, !voicesLoaded, !loadingVoices else {
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
