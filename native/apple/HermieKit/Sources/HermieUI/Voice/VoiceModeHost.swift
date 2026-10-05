import HermieCore
import SwiftUI

/**
 Where a chat's call is shown: over the chat itself, not as a cover.

 A request that arrives during a call (an approval, a question, a form) is answered on its own sheet,
 never by voice. A full-screen cover would sit above the chat's sheets and keep them from coming up, so
 the call is drawn over the chat in place: on the iPhone and the iPad it fills the screen (the
 navigation bar goes for the call), on the Mac it is a compact panel in the chat's pane. The sheets
 come up over it, and the call pauses under them (`ChatFeed.voiceRequestPending`).

 The voice setup screen comes up here too, before a first call and from the call's settings glyph.
 */
struct VoiceModeHost: ViewModifier {
  let feed: ChatFeed
  let botName: String

  func body(content: Content) -> some View {
    let call = feed.voiceMode

    content
      .overlay {
        if let call, let settings = feed.voiceSettings {
          panel(call, settings: settings)
            .transition(.opacity)
        }
      }
      .animation(.easeInOut(duration: 0.25), value: call != nil)
      #if os(iOS)
        .toolbar(call != nil ? .hidden : .automatic, for: .navigationBar)
        .persistentSystemOverlays(call != nil ? .hidden : .automatic)
      #endif
      .onChange(of: feed.voiceRequestPending) { _, _ in
        feed.voiceRequestsChanged()
      }
      .sheet(
        isPresented: Binding(
          get: { feed.showingVoiceSetup },
          set: { shown in
            if !shown {
              feed.voiceSetupClosed()
            }
          })
      ) {
        if let settings = feed.voiceSettings, VoiceSheetKind.of(setUp: settings.voiceModeSetUp, inCall: feed.voiceMode != nil) == .callVoice {
          // From the call's settings glyph: this bot's voice, and the call's options.
          CallVoiceSheet(
            settings: settings, chat: feed.chat, gateway: feed.gatewaySpeech, onDone: { feed.voiceSetupClosed() })
        } else if let settings = feed.voiceSettings {
          VoiceSetupSheet(
            settings: settings, engines: feed.voiceEngines, gateway: feed.gatewaySpeech,
            firstRun: !settings.voiceModeSetUp, onDone: { feed.voiceSetupClosed() })
        }
      }
  }

  @ViewBuilder
  private func panel(_ call: VoiceModeModel, settings: VoiceSettings) -> some View {
    #if os(macOS)
      let compact = true
    #else
      let compact = false
    #endif

    VoiceModePanel(
      call: call, settings: settings, botName: botName, compact: compact, onEnd: { feed.endVoiceMode() },
      onSettings: { feed.openVoiceSetupFromCall() })
  }
}

/**
 The call screen as it is put over the chat: on the iPhone and the iPad it fills the screen, on the Mac it
 is a compact panel.

 The screen is drawn inside the safe area: only its black background goes under the status bar and the
 home indicator (`VoiceModeView` sees to that), so the controls never sit on the battery or the clock.
 */
struct VoiceModePanel: View {
  let call: VoiceModeModel
  let settings: VoiceSettings
  let botName: String
  /// The Mac's compact panel, over a dimmed chat; otherwise the whole screen.
  let compact: Bool
  let onEnd: () -> Void
  let onSettings: () -> Void

  var body: some View {
    let view = VoiceModeView(
      call: call, settings: settings, botName: botName, onEnd: onEnd, onSettings: onSettings)

    if compact {
      ZStack {
        Color.black.opacity(0.35)
          .contentShape(.rect)
        view
          .frame(width: 380, height: 540)
          .clipShape(.rect(cornerRadius: 26))
          .shadow(color: .black.opacity(0.4), radius: 30, y: 12)
      }
    } else {
      view
    }
  }
}

/// The setup screen with a synthesiser of its own for the samples: the chat's reader stays the chat's.
private struct VoiceSetupSheet: View {
  let settings: VoiceSettings
  let engines: VoiceEngines
  let gateway: GatewaySpeechAccess?
  let firstRun: Bool
  let onDone: () -> Void

  @State private var speaker: (any SpeechSynthesizing)?

  var body: some View {
    Group {
      if let speaker {
        VoiceSetupView(settings: settings, speaker: speaker, gateway: gateway, firstRun: firstRun, onDone: onDone)
      } else {
        Color.black
      }
    }
    .onAppear {
      if speaker == nil {
        speaker = engines.speech(gateway: gateway)
      }
    }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 640)
    #endif
  }
}
