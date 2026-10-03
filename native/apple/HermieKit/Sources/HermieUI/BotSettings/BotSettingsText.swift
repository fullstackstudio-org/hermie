import HermieCore
import SwiftUI

/// What the bot settings say about a failure, in the reader's language. The gateway's own words, when
/// it sent some, are untrusted text: they reach the screen as `Text(verbatim:)` through a `String`
/// and are never read as Markdown.
enum BotSettingsText {
  static func message(for failure: BotSettingsFailure, handle: String) -> String {
    switch failure {
    case .forbidden:
      NativeStrings.BotSettings.readOnly
    case .unsupported:
      NativeStrings.BotSettings.unsupported
    case .offline:
      NativeStrings.BotSettings.offline
    case .notFound:
      Strings.BotRename.missing(name: handle)
    case .notApplied:
      NativeStrings.BotSettings.notApplied
    case .lastToolset:
      NativeStrings.BotSettings.lastToolset
    case .refused(let reason):
      reason.isEmpty ? Strings.App.BotProfile.saveFailed : Strings.Profiles.Capabilities.saveFailed(reason: reason)
    }
  }

  /// The name accent colours are announced and labelled by.
  static func name(of accent: BotAccent) -> String {
    switch accent {
    case .default: Strings.App.Layout.Accents.default
    case .indigo: Strings.App.Layout.Accents.indigo
    case .violet: Strings.App.Layout.Accents.violet
    case .magenta: Strings.App.Layout.Accents.magenta
    case .red: Strings.App.Layout.Accents.red
    case .orange: Strings.App.Layout.Accents.orange
    case .teal: Strings.App.Layout.Accents.teal
    case .green: Strings.App.Layout.Accents.green
    case .graphite: Strings.App.Layout.Accents.graphite
    case .slate: Strings.App.Layout.Accents.slate
    case .lime: Strings.App.Layout.Accents.lime
    }
  }
}

/// One failure, under the control it is about: the primary label colour with a red symbol, because
/// red text falls short of the contrast audit.
struct FailureLine: View {
  let failure: BotSettingsFailure
  let handle: String
  var dismiss: (() -> Void)?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .accessibilityHidden(true)
      Text(verbatim: BotSettingsText.message(for: failure, handle: handle))
        .font(.callout)
        .foregroundStyle(Color.primary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)

      if let dismiss {
        Button(action: dismiss) {
          Image(systemName: "xmark")
            .accessibilityLabel(Strings.Chat.Sheet.close)
        }
        .buttonStyle(.borderless)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

extension Color {
  /// An sRGB colour from `0xRRGGBB`.
  init(hex: UInt32) {
    self.init(
      .sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}

extension BotAccent {
  /// The colour of the swatch, and of the ring around it.
  var fill: Color { Color(hex: fillHex) }
  /// The colour a bot's initial sits on: white text is readable on it.
  var bubble: Color { Color(hex: bubbleHex) }
}
