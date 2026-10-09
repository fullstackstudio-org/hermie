import SwiftUI

// The callout a `[!NOTE]` quote is drawn as (`MarkdownAlert.swift` decides which quotes). An icon and a title
// in the kind's colour over a tinted card, then the quote's own blocks. The icon is decoration: the kind in
// words is the container's name, so VoiceOver says "Warning" before it reads the content.

/// The name of each callout, in the reader's language. English here; the app supplies its own through
/// `EnvironmentValues.markdownAlertLabels`, because this target owns no string catalog.
public struct MarkdownAlertLabels: Sendable {
  public var name: @Sendable (MarkdownAlertKind) -> String

  public init(name: @escaping @Sendable (MarkdownAlertKind) -> String) {
    self.name = name
  }

  public static let english = MarkdownAlertLabels { kind in
    switch kind {
    case .note: "Note"
    case .tip: "Tip"
    case .important: "Important"
    case .warning: "Warning"
    case .caution: "Caution"
    }
  }
}

extension EnvironmentValues {
  /// The names of the callouts. The default is English; the app's views set their own.
  @Entry public var markdownAlertLabels = MarkdownAlertLabels.english

  /// Set inside a callout: a quote in it is an ordinary quote.
  @Entry var markdownInAlert = false
}

extension MarkdownAlertKind {
  var symbol: String {
    switch self {
    case .note: "info.circle"
    case .tip: "lightbulb"
    case .important: "exclamationmark.bubble"
    case .warning: "exclamationmark.triangle"
    case .caution: "exclamationmark.octagon"
    }
  }

  /// System colours, so a callout follows light, dark and increased contrast.
  var color: Color {
    switch self {
    case .note: .blue
    case .tip: .green
    case .important: .purple
    case .warning: .orange
    case .caution: .red
    }
  }
}

struct MarkdownAlertView: View {
  let alert: MarkdownAlert

  @Environment(\.markdownAlertLabels) private var labels
  @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 12

  var body: some View {
    let name = labels.name(alert.kind)

    VStack(alignment: .leading, spacing: 6) {
      Label(name, systemImage: alert.kind.symbol)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(alert.kind.color)
        .accessibilityHidden(true)

      if !alert.body.isEmpty {
        MarkdownBlockStack(blocks: alert.body)
          .environment(\.markdownInAlert, true)
      }
    }
    .padding(padding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(alert.kind.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(alignment: .leading) {
      UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12)
        .fill(alert.kind.color)
        .frame(width: 4)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(name)
  }
}
