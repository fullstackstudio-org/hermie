import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Dictation at the trailing end of the field, as Messages has it: a quiet waveform while the field
/// is empty, the stop colour with a pulsing microphone while it listens. A tap starts dictation, and
/// a tap again stops it; what was heard goes into the field as it is heard and is the reader's to
/// read, change and send.
struct DictationButton: View {
  let dictation: DictationModel
  let width: CGFloat
  let height: CGFloat

  var body: some View {
    let listening = dictation.isListening

    Button {
      let dictation = self.dictation
      Task { await dictation.toggle() }
    } label: {
      Image(systemName: listening ? "mic.fill" : "waveform")
        .font(.body.weight(listening ? .bold : .regular))
        .symbolEffect(.pulse, isActive: listening)
        .frame(width: width, height: height)
    }
    .buttonStyle(DictationButtonStyle(listening: listening))
    .help(listening ? Strings.Chat.Voice.dictateStop : Strings.Chat.Voice.dictate)
    .accessibilityLabel(listening ? Strings.Chat.Voice.dictateStop : Strings.Chat.Voice.dictate)
    .accessibilityIdentifier(listening ? "composer.dictate.stop" : "composer.dictate")
  }
}

/// No disc while it waits (the waveform sits in the field), a stop-red capsule while the microphone
/// is open.
struct DictationButtonStyle: ButtonStyle {
  let listening: Bool

  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(listening ? AnyShapeStyle(Color.white) : AnyShapeStyle(.secondary))
      .background(listening ? AnyShapeStyle(SendButtonStyle.stopRed) : AnyShapeStyle(Color.clear), in: .capsule)
      .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
      .contentShape(.capsule)
  }
}

/// What dictation says over the field: that it is listening, or why the last try did not work, in one
/// line, with the way to the settings where only the reader can fix it.
struct DictationNoticeRow: View {
  let dictation: DictationModel

  @Environment(\.openURL) private var openURL

  var body: some View {
    if dictation.isListening {
      Label(Strings.Chat.Voice.listening, systemImage: "waveform")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("composer.dictate.listening")
        .onAppear {
          AccessibilityNotification.Announcement(Strings.Chat.Voice.listening).post()
        }
    } else if let failure = dictation.failure {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(Self.text(failure), systemImage: "mic.slash")
          .font(.footnote)
          .foregroundStyle(failure == .noSpeech ? Color.secondary : Color.red)
          .fixedSize(horizontal: false, vertical: true)

        if failure == .permission, let url = Self.settingsURL {
          Button(Strings.Chat.Voice.openSettings) { openURL(url) }
            .buttonStyle(.borderless)
            .font(.footnote)
            .accessibilityIdentifier("composer.dictate.openSettings")
        }

        Spacer(minLength: 0)

        Button {
          dictation.clearFailure()
        } label: {
          Image(systemName: "xmark")
            .accessibilityLabel(Strings.Chat.Sheet.close)
        }
        .buttonStyle(.borderless)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("composer.dictate.notice")
    }
  }

  static func text(_ failure: RecognitionFailure) -> String {
    switch failure {
    case .permission: Strings.Chat.Voice.permissionDenied
    case .noSpeech: Strings.Chat.Voice.noSpeech
    case .unavailable: Strings.Chat.Voice.unavailable
    case .failed: Strings.Chat.Voice.failed
    }
  }

  /// Where the microphone's permission is switched: the app's page in Settings on iPhone and iPad, the
  /// Microphone pane of System Settings on the Mac.
  static var settingsURL: URL? {
    #if os(iOS)
      URL(string: UIApplication.openSettingsURLString)
    #else
      URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    #endif
  }
}
