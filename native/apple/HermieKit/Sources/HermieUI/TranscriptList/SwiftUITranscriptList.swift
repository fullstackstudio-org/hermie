import SwiftUI

/// `TranscriptList`'s implementation: a `ScrollView` over a `LazyVStack`,
/// bottom-anchored with the iOS 18 scroll APIs (implementation A of the spike;
/// docs/native.md, "Transcript list", has the measurements behind each choice).
///
/// - `defaultScrollAnchor(.bottom)` opens at the newest row.
/// - `scrollPosition` over a `scrollTargetLayout` keeps the row at the top of
///   the viewport in place when rows are inserted above it. That is what makes
///   a history prepend jump-free (0.0–0.3 pt in the spike).
/// - `defaultScrollAnchor(_, for: .sizeChanges)` is `.bottom` while the reader
///   is at the bottom, so a growing reply stays in view, and `nil` otherwise,
///   so a reply growing below a reader who scrolled up does not move them.
/// - Commands go through the same `ScrollPosition`. One told `scrollTo(id:)`
///   keeps that target and resolves it again on every content change, and that
///   second resolution lands about 13 pt from the first (measured, whatever the
///   anchor). A prepend straight after a programmatic jump would show it, so
///   `onNearTop` is held back after a jump until the reader has scrolled: the
///   history then loads under a position the reader made, which holds.
/// - `onScrollGeometryChange` reduces the geometry to two booleans (at the
///   bottom, near the top), so scrolling re-renders nothing until one flips.
struct SwiftUITranscriptList<Item: Identifiable & Equatable & Sendable, Row: View>: View where Item.ID: Sendable {
  let items: TranscriptListItems<Item>
  let state: TranscriptListState
  let spacing: CGFloat
  let row: (Item) -> Row

  @State private var position = ScrollPosition(idType: Item.ID.self)
  /// The position is one a command set, not one the reader scrolled to.
  @State private var commanded = false
  /// The list came near the top while `commanded`; ask for history once the
  /// reader has scrolled.
  @State private var nearTopHeld = false

  var body: some View {
    ScrollView {
      LazyVStack(spacing: spacing) {
        ForEach(items) { item in
          TranscriptListRow(item: item, row: row)
            .equatable()
        }
      }
      .scrollTargetLayout()
    }
    .accessibilityIdentifier("transcript.list")
    .scrollPosition($position, anchor: .top)
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(state.isAtBottom ? .bottom : nil, for: .sizeChanges)
    .onScrollGeometryChange(for: Edges.self) { geometry in
      Edges(geometry, bottomThreshold: state.bottomThreshold, topThreshold: state.nearTopThreshold)
    } action: { _, edges in
      if state.isAtBottom != edges.atBottom {
        state.isAtBottom = edges.atBottom
      }
      if edges.nearTop {
        if state.nearTopArmed {
          state.nearTopArmed = false
          if commanded {
            nearTopHeld = true
          } else {
            state.onNearTop?()
          }
        }
      } else {
        state.nearTopArmed = true
        nearTopHeld = false
      }
    }
    .modifier(OffsetTracking(state: state))
    .onScrollPhaseChange { _, phase in
      switch phase {
      case .interacting:
        commanded = false
      case .idle where nearTopHeld && !commanded:
        nearTopHeld = false
        state.onNearTop?()
      default:
        break
      }
    }
    .onChange(of: position.viewID(type: Item.ID.self)) { _, id in
      state.topVisibleID = id.map { AnyHashable($0) }
    }
    .onChange(of: state.commandSerial) {
      perform(state.take())
    }
  }

  private func perform(_ command: TranscriptListState.Command?) {
    switch command {
    case .bottom(let animated):
      withAnimation(animated ? .default : nil) {
        position.scrollTo(edge: .bottom)
      }
    case .item(let id, let anchor, let animated):
      guard let id = id.base as? Item.ID else { return }
      commanded = true
      withAnimation(animated ? .default : nil) {
        position.scrollTo(id: id, anchor: anchor)
      }
    case .pan(let delta):
      commanded = true
      position.scrollTo(y: max(0, state.contentOffset + delta))
    case nil:
      break
    }
  }

  /// Keeps `state.contentOffset` current for the lab's pan, in debug builds
  /// only: a release build does no work per scrolled frame for it.
  struct OffsetTracking: ViewModifier {
    let state: TranscriptListState

    func body(content: Content) -> some View {
      #if DEBUG
        content.onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in
          state.contentOffset = offset
        }
      #else
        content
      #endif
    }
  }

  /// The geometry, reduced to what the list acts on.
  struct Edges: Equatable {
    var atBottom: Bool
    var nearTop: Bool

    init(_ geometry: ScrollGeometry, bottomThreshold: CGFloat, topThreshold: CGFloat) {
      let visible = geometry.visibleRect
      atBottom = visible.maxY >= geometry.contentSize.height - bottomThreshold
      nearTop = geometry.contentSize.height > geometry.containerSize.height && visible.minY <= topThreshold
    }
  }
}
