import SwiftUI

/// A one-line, centred capsule: how a demoted row (`chip`) draws.
struct ItemChip: View {
  let text: String
  var systemImage: String?
  var tone: Tone = .neutral
  var action: (@MainActor () -> Void)?

  enum Tone {
    case neutral, danger
  }

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    Group {
      if let action {
        Button(action: action) { label }
          .buttonStyle(.plain)
      } else {
        label
      }
    }
    .frame(maxWidth: .infinity)
  }

  private var label: some View {
    HStack(spacing: 6) {
      if let systemImage {
        Image(systemName: systemImage)
          .imageScale(.small)
          .accessibilityHidden(true)
      }
      // One line normally; at the accessibility sizes the whole text, so
      // nothing a larger size was asked for is cut off.
      Text(text)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        .truncationMode(.middle)
        .multilineTextAlignment(.center)
    }
    .font(.footnote)
    // Primary, not secondary: on the capsule's fill a secondary label falls
    // short of the 4.5:1 the accessibility audit asks for.
    .foregroundStyle(tone == .danger ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
    .padding(.horizontal, 12)
    .padding(.vertical, 5)
    .background(.fill.tertiary, in: .capsule)
    .contentShape(.capsule)
  }
}

/// The quiet rounded surface a card (tool, notice, cron, approval) sits on.
struct CardSurface: ViewModifier {
  var tint: Color?

  func body(content: Content) -> some View {
    content
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        (tint.map { AnyShapeStyle($0.opacity(0.12)) } ?? AnyShapeStyle(.fill.quaternary)),
        in: .rect(cornerRadius: 14)
      )
      .overlay {
        if let tint {
          RoundedRectangle(cornerRadius: 14).strokeBorder(tint.opacity(0.35), lineWidth: 1)
        }
      }
  }
}

extension View {
  func cardSurface(tint: Color? = nil) -> some View {
    modifier(CardSurface(tint: tint))
  }
}

/// A disclosure's header: a label and a chevron that turns, as one button.
struct DisclosureHeader<Label: View>: View {
  @Bindable var box: TranscriptExpansion.Box
  @ViewBuilder var label: Label

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button {
      withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
        box.isExpanded.toggle()
      }
    } label: {
      HStack(spacing: 6) {
        label
        Image(systemName: "chevron.right")
          .imageScale(.small)
          .rotationEffect(.degrees(box.isExpanded ? 90 : 0))
          .accessibilityHidden(true)
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityValue(box.isExpanded ? Strings.Chat.Menu.hideDetails : Strings.Chat.Menu.showDetails)
  }
}

extension NativeStrings {
  enum Transcript {
    /// This message ({kind}) needs a newer version of Hermie.
    static func unsupportedItem(_ kind: String) -> String {
      String(
        localized: "native.transcript.unsupportedItem",
        defaultValue: "This message (\(kind)) needs a newer version of Hermie.",
        table: "Native",
        bundle: .module
      )
    }
  }
}
