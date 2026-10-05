import HermieCore
import SwiftUI

/// Which sheet the chat's voice setup is: the first-run setup (before the first call, and the call starts
/// when it is done), or, once a call is on and the setup has been through, the call's own voice sheet.
enum VoiceSheetKind: Equatable {
  case setup
  case callVoice

  static func of(setUp: Bool, inCall: Bool) -> VoiceSheetKind {
    setUp && inCall ? .callVoice : .setup
  }
}

/**
 The voice sheet of a call, opened from the call screen's settings glyph: this bot's own voice first
 (the same choices as the bot's settings: Default, the device's voices, Personal Voice, the gateway's,
 with a sample where the gateway says it is free), and the call's options under it.

 A choice is written to the settings as it is made. The call's reader resolves the bot's voice for each
 sentence it says (`ReadAloudModel`), so a change is heard from the next sentence on, not from the next call.
 */
struct CallVoiceSheet: View {
  let settings: VoiceSettings
  let chat: ChatRef
  let gateway: GatewaySpeechAccess?
  let onDone: () -> Void

  var body: some View {
    NavigationStack {
      BotVoiceList(chat: chat, settings: settings, gateway: gateway) {
        CallOptionsSection(settings: settings)
      }
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(NativeStrings.VoiceSetup.done, action: onDone)
            .accessibilityIdentifier("hermie.callVoice.done")
        }
      }
    }
    .accessibilityIdentifier("hermie.callVoice")
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 560)
    #endif
  }
}

/// The options a call has on the Voice screen: how fast it speaks, how lively, and which orb it shows.
struct CallOptionsSection: View {
  let settings: VoiceSettings

  var body: some View {
    Section {
      Picker(
        NativeStrings.VoiceSetup.pace,
        selection: Binding(get: { settings.rate }, set: { settings.setRate($0) })
      ) {
        ForEach(VoiceSettings.rateSteps, id: \.self) { step in
          Text(VoiceSettings.rateLabel(step)).tag(step)
        }
      }
      .accessibilityIdentifier("hermie.callVoice.pace")

      VStack(alignment: .leading, spacing: 4) {
        LabeledContent(NativeStrings.VoiceSetup.expressivity) {
          Text(NativeStrings.VoiceSetup.percent(Int((settings.expressivity * 100).rounded())))
        }

        Slider(
          value: Binding(get: { settings.expressivity }, set: { settings.setExpressivity($0) }), in: 0...1, step: 0.25
        )
        .accessibilityLabel(NativeStrings.VoiceSetup.expressivity)
        .accessibilityIdentifier("hermie.callVoice.expressivity")
      }

      Picker(
        NativeStrings.VoiceSetup.orb,
        selection: Binding(get: { settings.voiceModeOrb }, set: { settings.setVoiceModeOrb($0) })
      ) {
        Text(NativeStrings.VoiceSetup.orbClouds).tag(VoiceOrbStyle.clouds)
        Text(NativeStrings.VoiceSetup.orbLight).tag(VoiceOrbStyle.light)
      }
      .accessibilityIdentifier("hermie.callVoice.orb")
    } header: {
      Text(Strings.Chat.Voice.mode)
    } footer: {
      if settings.speechSource == .gateway {
        SettingsNote(NativeStrings.VoiceSetup.gatewayPaceNote)
      }
    }
  }
}
