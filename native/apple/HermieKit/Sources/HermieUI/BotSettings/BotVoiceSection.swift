import HermieCore
import SwiftUI

/// The pure parts of the bot's Voice choice: what the row says, and which device voices the page lists.
@MainActor
enum BotVoiceLogic {
  /// The row's value: "Default", or "Apple · Samantha", "Gateway · Rachel". `Apple` and `Gateway` are
  /// names, the same in every language.
  static func summary(_ voice: BotVoice?, appleVoices: [SpeechVoice], gateway: GatewaySpeechAccess?) -> String {
    guard let voice else {
      return NativeStrings.BotSettings.voiceDefault
    }

    switch voice.source {
    case .apple:
      let name = voice.voice.flatMap { id in appleVoices.first { $0.id == id }?.name } ?? NativeStrings.VoiceSetup.automatic
      return "Apple · \(name)"
    case .gateway:
      let name = gateway?.name(ofVoice: voice.voice) ?? voice.voice ?? NativeStrings.VoiceSetup.gatewayDefaultVoice
      return "Gateway · \(name)"
    }
  }

  /// The device voices the page lists: those of the device's language, best first; a voice already
  /// chosen in another language is listed too, so what is selected is always on the page.
  static func appleChoices(voices: [SpeechVoice], chosen: String?, deviceTag: String) -> [SpeechVoice] {
    let language = VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: chosen, deviceTag: deviceTag)
    var shown = VoiceSetupLogic.voices(in: language, from: voices)

    if let chosen, !shown.contains(where: { $0.id == chosen }), let extra = voices.first(where: { $0.id == chosen }) {
      shown.insert(extra, at: 0)
    }

    return shown
  }

  /// The gateway's part of the page is there where the gateway can speak, and wherever the bot was given
  /// the gateway's voice: a choice already made stays on the page, as chosen, while the gateway has not
  /// answered or cannot be reached.
  static func showsGatewaySection(state: GatewayVoiceState, current: BotVoice?) -> Bool {
    state == .ready || current?.source == .gateway
  }

  /// "Samantha, enhanced" / "My voice, Personal Voice"; with the region ("Enhanced · Belgium") where the
  /// voices listed come from more than one.
  static func detail(of voice: SpeechVoice, showRegion: Bool = false) -> String {
    let quality = voice.personal ? NativeStrings.VoiceSetup.qualityPersonal : VoiceSetupLogic.quality(voice.quality)

    if showRegion, let region = VoiceSetupLogic.regionName(of: voice.language) {
      return "\(quality) · \(region)"
    }

    return quality
  }
}

/**
 The bot's own voice, in its settings: Default (it speaks in the voice chosen on the Voice screen), or a
 source and a voice just for this bot. Kept on this device, per gateway and bot (`VoiceSettings`), and
 used by "Read aloud", the chat's automatic read and voice mode whenever this bot speaks.
 */
struct BotVoiceSection: View {
  let chat: ChatRef
  let session: GatewaySession

  @Environment(AppLaunch.self) private var launch: AppLaunch?

  var body: some View {
    if let settings = launch?.voice {
      let gateway = session.speechAccess(profile: chat.bot)

      Section {
        NavigationLink {
          BotVoicePage(chat: chat, settings: settings, gateway: gateway)
        } label: {
          LabeledContent(NativeStrings.BotSettings.voice) {
            Text(
              BotVoiceLogic.summary(
                settings.botVoice(bot: chat.bot, gatewayID: chat.gatewayId), appleVoices: AppleSpeechSynthesizer.installedVoices(),
                gateway: gateway))
          }
        }
        .accessibilityIdentifier("hermie.botSettings.voice")
      } header: {
        Text(NativeStrings.BotSettings.voice)
      } footer: {
        SettingsNote(NativeStrings.BotSettings.voiceFooter)
      }
      .task { await gateway?.loadConfig() }
    }
  }
}

/// The page behind the row: Default, the device's voices, and the gateway's where it has them.
struct BotVoicePage: View {
  let chat: ChatRef
  let settings: VoiceSettings
  let gateway: GatewaySpeechAccess?

  @State private var appleVoices: [SpeechVoice] = []
  /// Hearing a gateway voice before choosing it; one for as long as the page is shown.
  @State private var previewer: GatewayVoicePreviewer?

  init(chat: ChatRef, settings: VoiceSettings, gateway: GatewaySpeechAccess?) {
    self.chat = chat
    self.settings = settings
    self.gateway = gateway
    _previewer = State(
      initialValue: gateway.map { GatewayVoicePreviewer(access: $0, sentence: NativeStrings.VoiceSetup.sample) })
  }

  var body: some View {
    let current = settings.botVoice(bot: chat.bot, gatewayID: chat.gatewayId)

    List {
      Section {
        row(
          NativeStrings.BotSettings.voiceDefault, detail: NativeStrings.BotSettings.voiceDefaultDetail,
          selected: current == nil, id: "default"
        ) {
          settings.setBotVoice(nil, bot: chat.bot, gatewayID: chat.gatewayId)
        }
      }

      let apple = BotVoiceLogic.appleChoices(
        voices: appleVoices, chosen: current?.source == .apple ? current?.voice : nil,
        deviceTag: Locale.preferredLanguages.first ?? Locale.current.identifier)
      let showRegion = VoiceSetupLogic.spansRegions(apple)

      Section {
        row(NativeStrings.VoiceSetup.automatic, selected: current == BotVoice(source: .apple), id: "apple.automatic") {
          choose(BotVoice(source: .apple))
        }

        ForEach(apple) { voice in
          row(
            voice.name, detail: BotVoiceLogic.detail(of: voice, showRegion: showRegion),
            selected: current == BotVoice(source: .apple, voice: voice.id), id: "apple.\(voice.id)"
          ) {
            choose(BotVoice(source: .apple, voice: voice.id))
          }
        }
      } header: {
        Text(NativeStrings.VoiceSetup.sourceDevice)
      } footer: {
        if VoiceSetupLogic.onlyCompact(apple) {
          SettingsNote(NativeStrings.VoiceSetup.betterVoices)
            .accessibilityIdentifier("hermie.botSettings.voice.betterVoices")
        }
      }

      let state = GatewayVoiceLogic.state(of: gateway)

      if BotVoiceLogic.showsGatewaySection(state: state, current: current) {
        Section {
          if state == .unavailable {
            GatewayUnavailableView(
              retry: gateway.map { access in { Task { await access.retryVoices() } } },
              identifierPrefix: "hermie.botSettings.voice.gateway")
          } else if state == .unknown {
            HStack(spacing: 10) {
              ProgressView()
              Text(NativeStrings.VoiceSetup.gatewayVoicesLoading)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
          }

          row(
            NativeStrings.VoiceSetup.gatewayDefaultVoice, selected: current == BotVoice(source: .gateway),
            id: "gateway.default"
          ) {
            choose(BotVoice(source: .gateway))
          }

          if gateway?.canChooseVoice == true || state != .ready {
            if let gateway, gateway.loadingVoices {
              HStack(spacing: 10) {
                ProgressView()
                Text(NativeStrings.VoiceSetup.gatewayVoicesLoading)
                  .foregroundStyle(.secondary)
              }
              .accessibilityElement(children: .combine)
            } else if let gateway, state == .ready, let error = gateway.voicesError {
              GatewayVoicesErrorView(
                error: error, retry: { Task { await gateway.retryVoices() } }, identifierPrefix: "hermie.botSettings.voice")
            }

            ForEach(
              GatewayVoiceLogic.keeping(
                current?.source == .gateway ? current?.voice : nil, in: gateway?.selectableVoices ?? [])
            ) { voice in
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  row(voice.label, selected: current == BotVoice(source: .gateway, voice: voice.id), id: "gateway.\(voice.id)") {
                    choose(BotVoice(source: .gateway, voice: voice.id))
                  }

                  if let previewer, previewer.offers(voice) {
                    GatewayVoicePreviewButton(
                      voice: voice, previewer: previewer, identifierPrefix: "hermie.botSettings.voice.gateway")
                  }
                }

                if let previewer {
                  GatewayVoicePreviewMessage(
                    voiceID: voice.id, previewer: previewer, identifierPrefix: "hermie.botSettings.voice.gateway")
                }
              }
            }
          }
        } header: {
          Text(NativeStrings.VoiceSetup.sourceGateway)
        } footer: {
          if state == .ready, gateway?.canChooseVoice != true {
            SettingsNote(NativeStrings.VoiceSetup.gatewayNoChoice)
          }
        }
      }
    }
    .navigationTitle(NativeStrings.BotSettings.voice)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task {
      appleVoices = AppleSpeechSynthesizer.installedVoices()
      await gateway?.loadConfig()
      await gateway?.loadVoices()
    }
    .onDisappear { previewer?.stop() }
    .accessibilityIdentifier("hermie.botSettings.voicePage")
  }

  private func choose(_ voice: BotVoice) {
    settings.setBotVoice(voice, bot: chat.bot, gatewayID: chat.gatewayId)
  }

  private func row(
    _ title: String, detail: String? = nil, selected: Bool, id: String, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .foregroundStyle(.primary)

          if let detail {
            Text(detail)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        if selected {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel([title, detail, selected ? NativeStrings.VoiceSetup.selected : nil].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("hermie.botSettings.voice.\(id)")
  }
}
