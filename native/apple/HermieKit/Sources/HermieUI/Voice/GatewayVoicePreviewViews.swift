import HermieCore
import SwiftUI

/// The words of the voice previews and of a voice list the gateway could not give, apart from the views.
enum GatewayVoicePreviewLogic {
  /// What a voice's play button is called: "Play sample of Rachel", and "Stop" while it loads or plays.
  static func accessibilityLabel(name: String, phase: GatewayVoicePreviewer.Phase) -> String {
    phase == .idle ? NativeStrings.VoiceSetup.previewPlay(name) : NativeStrings.VoiceSetup.previewStop
  }

  /// The brief message under a voice that could not be heard.
  static func message(for failure: GatewayVoicePreviewer.Failure) -> String {
    switch failure {
    case .noSample: NativeStrings.VoiceSetup.previewNoSample
    case .unreachable: NativeStrings.VoiceSetup.previewUnreachable
    case .unplayable: NativeStrings.VoiceSetup.previewUnplayable
    case .callActive: NativeStrings.VoiceSetup.previewCallActive
    }
  }

  /// Said instead of the voice list when the gateway could not give it.
  static func message(for error: GatewayVoicesError) -> String {
    switch error {
    case .unavailable: NativeStrings.VoiceSetup.voicesUnavailable
    case .loading: NativeStrings.VoiceSetup.voicesStillLoading
    }
  }
}

/// A small play / stop button for one gateway voice. It only plays: the row's own button chooses.
struct GatewayVoicePreviewButton: View {
  let voice: GatewayVoice
  let previewer: GatewayVoicePreviewer
  var tint: Color = .accentColor
  let identifierPrefix: String

  var body: some View {
    let phase = previewer.phase(of: voice.id)

    Button {
      previewer.toggle(voice)
    } label: {
      ZStack {
        switch phase {
        case .idle:
          Image(systemName: "play.circle.fill")
        case .loading:
          ProgressView()
            .controlSize(.small)
        case .playing:
          Image(systemName: "stop.circle.fill")
        }
      }
      .font(.title2)
      .foregroundStyle(tint)
      .frame(minWidth: 36, minHeight: 36)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(GatewayVoicePreviewLogic.accessibilityLabel(name: voice.label, phase: phase))
    .accessibilityValue(phase == .loading ? NativeStrings.VoiceSetup.previewLoading : "")
    .accessibilityIdentifier("\(identifierPrefix).preview.\(voice.id)")
  }
}

/// The brief inline message under a voice whose sample failed; nothing while it did not.
struct GatewayVoicePreviewMessage: View {
  let voiceID: String
  let previewer: GatewayVoicePreviewer
  var color: Color = .secondary
  let identifierPrefix: String

  var body: some View {
    if let failure = previewer.failure(of: voiceID) {
      Text(GatewayVoicePreviewLogic.message(for: failure))
        .font(.footnote)
        .foregroundStyle(color)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("\(identifierPrefix).previewMessage.\(voiceID)")
    }
  }
}

/// Said where the gateway was chosen as the voice but cannot speak now (no answer, or no text-to-speech):
/// the choice is kept, the device speaks meanwhile, and a button asks again where there is a gateway to ask.
struct GatewayUnavailableView: View {
  var color: Color = .secondary
  var tint: Color = .accentColor
  let retry: (() -> Void)?
  let identifierPrefix: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.VoiceSetup.gatewayUnavailable)
        .font(.footnote)
        .foregroundStyle(color)
        .fixedSize(horizontal: false, vertical: true)

      if let retry {
        Button(NativeStrings.VoiceSetup.voicesRetry, action: retry)
          .buttonStyle(.plain)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(tint)
          .accessibilityIdentifier("\(identifierPrefix).unavailableRetry")
      }
    }
    .accessibilityIdentifier("\(identifierPrefix).unavailable")
  }
}

/// What stands in for a voice list the gateway could not give: why, and a button that asks again.
struct GatewayVoicesErrorView: View {
  let error: GatewayVoicesError
  var color: Color = .secondary
  var tint: Color = .accentColor
  let retry: () -> Void
  let identifierPrefix: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(GatewayVoicePreviewLogic.message(for: error))
        .font(.footnote)
        .foregroundStyle(color)
        .fixedSize(horizontal: false, vertical: true)

      Button(NativeStrings.VoiceSetup.voicesRetry, action: retry)
        .buttonStyle(.plain)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(tint)
        .accessibilityIdentifier("\(identifierPrefix).voicesRetry")
    }
    .padding(.vertical, 10)
    .accessibilityIdentifier("\(identifierPrefix).voicesError")
  }
}
