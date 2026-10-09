import SwiftUI

// A drawn `hermie-chart` or `hermie-cards` block: the picture itself, with no header bar over it.
// ==============================================================================================
//
// What a listing has (a language label, Copy, Show source) lives in a small "..." button in the block's
// top-trailing corner instead, so the picture is the block. The button is quiet (secondary, on a thin
// material so it reads over a plot), a real button either way, named for VoiceOver, and opens a short menu
// with "Show source" (a toggle: the JSON is shown in the picture's place) and "Copy source". A copy is
// confirmed by the glyph turning into a check mark for a moment and by a haptic, the way the reply's Copy
// button does it. `native/web/src/markdown/DrawnBlock.tsx` is its twin.

/// The words of the corner button and its menu.
struct MarkdownDrawnStrings: Sendable {
  var moreOptions: String
  var showSource: String
  var showRendered: String
  var copySource: String
  var copied: String
}

struct MarkdownDrawnBlock<Drawing: View>: View {
  /// The block's source: what Copy copies and what Show source shows.
  let source: String
  /// What VoiceOver calls the block.
  let name: String
  /// When set, the picture is read as one element with this value (a chart); when `nil` the drawing keeps its
  /// own elements (the cards), inside one container named `name`.
  var spoken: String?
  let strings: MarkdownDrawnStrings
  @ViewBuilder var drawing: () -> Drawing

  @State private var showsSource = false
  @State private var copied = false
  @ScaledMetric(relativeTo: .body) private var padding: CGFloat = 10
  @ScaledMetric(relativeTo: .body) private var button: CGFloat = 28

  var body: some View {
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(alignment: .topTrailing) {
        menu
      }
      .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var content: some View {
    if showsSource {
      ScrollView(.horizontal) {
        Text(source)
          .font(.callout.monospaced())
          .fixedSize(horizontal: true, vertical: false)
          .padding(padding)
          .padding(.trailing, button)
          .accessibilityLabel(name)
      }
      .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    } else if let spoken {
      drawing()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityValue(spoken)
    } else {
      drawing()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(name)
    }
  }

  private var menu: some View {
    Menu {
      Button {
        showsSource.toggle()
      } label: {
        Label(
          showsSource ? strings.showRendered : strings.showSource,
          systemImage: showsSource ? "eye" : "chevron.left.forwardslash.chevron.right")
      }

      Button {
        MarkdownPasteboard.copy(source)
        copied = true
      } label: {
        Label(strings.copySource, systemImage: "doc.on.doc")
      }
    } label: {
      Image(systemName: copied ? "checkmark" : "ellipsis")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(width: button, height: button)
        .background(.thinMaterial, in: Circle())
        .contentShape(Circle())
    }
    .menuIndicator(.hidden)
    .buttonStyle(.plain)
    .accessibilityLabel(copied ? strings.copied : strings.moreOptions)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
    .task(id: copied) {
      guard copied else { return }
      try? await Task.sleep(for: .seconds(1.5))
      copied = false
    }
  }
}
