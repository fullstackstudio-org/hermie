import SwiftUI

/// `TranscriptList`'s implementation: a `ScrollView` over a `LazyVStack`,
/// bottom-anchored with the iOS 18 scroll APIs (implementation A of the spike;
/// docs/native.md, "Transcript list", has the measurements behind each choice).
///
/// - `defaultScrollAnchor(.bottom)` opens at the newest row.
/// - `scrollPosition` over a `scrollTargetLayout` keeps the row at the top of
///   the viewport in place when rows are inserted above it. That is what makes
///   a history prepend jump-free (0.0–0.3 pt in the spike).
/// - `defaultScrollAnchor(_, for: .sizeChanges)` is `.bottom` while the list
///   follows the newest row, so a growing reply stays in view, and `nil`
///   otherwise, so a reply growing below a reader who scrolled up does not move
///   them. Whether it follows is `TranscriptFollow`'s to decide: from what moved
///   the content (the reader, the list, the rows growing), not from one
///   geometry update, and growth the anchor did not keep is brought back to the
///   bottom. The reader's own send (`followOwnSend`) always follows.
/// - Commands go through the same `ScrollPosition`. One told `scrollTo(id:)`
///   keeps that target and resolves it again on every content change, and that
///   second resolution lands about 13 pt from the first (measured, whatever the
///   anchor). A prepend straight after a programmatic jump would show it, so
///   `onNearTop` is held back after a jump until the reader has scrolled: the
///   history then loads under a position the reader made, which holds.
/// - `onScrollGeometryChange` reduces the geometry to what the rules act on;
///   scrolling re-renders nothing until the list stops or starts following.
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
  /// Following, the scroll phase and the last geometry. A reference, not
  /// observed: the per-frame bookkeeping re-renders nothing; what views read
  /// is mirrored into `state.isAtBottom`.
  @State private var tracker = FollowTracker()

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
    .onScrollGeometryChange(for: TranscriptFollow.Geometry.self) { geometry in
      TranscriptFollow.Geometry(
        offset: geometry.contentOffset.y,
        contentHeight: geometry.contentSize.height,
        containerHeight: geometry.containerSize.height,
        visibleMaxY: geometry.visibleRect.maxY
      )
    } action: { old, new in
      // Growth while following is kept by the size-change anchor, which reads `isAtBottom`; it is
      // not chased with a scroll command from here: one issued while the rows changed size (a
      // reply settling) left the lazy stack drawing an empty viewport.
      tracker.geometry = new
      tracker.follow.geometryChanged(from: old, to: new, phase: tracker.phase, threshold: state.bottomThreshold)
      publishFollowing()
    }
    .onScrollGeometryChange(for: Edges.self) { geometry in
      Edges(geometry, bottomThreshold: state.bottomThreshold, topThreshold: state.nearTopThreshold)
    } action: { _, edges in
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
      tracker.phase = Self.followPhase(phase)
      tracker.follow.phaseChanged(
        to: tracker.phase, atBottom: tracker.geometry?.isAtBottom(threshold: state.bottomThreshold) ?? true)
      publishFollowing()
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
    .onChange(of: items.identity) {
      keepAnchorRow()
    }
    .onChange(of: state.commandSerial) {
      perform(state.take())
    }
  }

  private func perform(_ command: TranscriptListState.Command?) {
    switch command {
    case .bottom(let animated):
      tracker.follow.commandedBottom()
      publishFollowing()
      withAnimation(animated ? .default : nil) {
        position.scrollTo(edge: .bottom)
      }
    case .item(let id, let anchor, let animated):
      guard let id = id.base as? Item.ID else { return }
      commanded = true
      tracker.follow.commandedItem()
      publishFollowing()
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

  /// A new snapshot of the rows. The position the lazy stack keeps is the id of the row at the
  /// top of the viewport, and when that row is gone (a reconcile that moved or renamed rows) it
  /// drew an empty viewport there, with the scroller still showing content: the blank page after
  /// a send. So on every snapshot whose ids changed, the list checks that row is still there, and
  /// when it is not goes back to the bottom while following, or to the nearest row that is still
  /// there (`TranscriptFollow.survivor`). The check scans from the newest row, where the top row
  /// usually is.
  private func keepAnchorRow() {
    let previous = tracker.items
    tracker.items = items
    guard let previous else { return }

    guard let top = position.viewID(type: Item.ID.self) else {
      // No row recorded yet (the list opened at the bottom and nobody scrolled): while following,
      // a shrink or a new first row is the change that can leave it on a row that is gone.
      if tracker.follow.following, items.count < previous.count || items.first?.id != previous.first?.id {
        position.scrollTo(edge: .bottom)
      }
      return
    }
    guard items.lastIndex(where: { $0.id == top }) == nil else { return }

    if tracker.follow.following {
      position.scrollTo(edge: .bottom)
      return
    }
    let present = Set(items.map(\.id))
    if let survivor = TranscriptFollow.survivor(of: top, in: previous.map(\.id), isPresent: present.contains) {
      position.scrollTo(id: survivor, anchor: .top)
    }
  }

  /// `isAtBottom` is what the pill, the unread count and the read marks see: the
  /// list follows the newest row.
  private func publishFollowing() {
    if state.isAtBottom != tracker.follow.following {
      state.isAtBottom = tracker.follow.following
    }
  }

  static func followPhase(_ phase: ScrollPhase) -> TranscriptFollow.Phase {
    switch phase {
    case .idle: .idle
    case .tracking, .interacting, .decelerating: .reader
    case .animating: .animating
    @unknown default: .idle
    }
  }

  /// The follow state and what it is decided from, kept out of observation.
  @MainActor final class FollowTracker {
    var follow = TranscriptFollow()
    var phase = TranscriptFollow.Phase.idle
    /// The last geometry the list reported.
    var geometry: TranscriptFollow.Geometry?
    /// The rows as of the last snapshot.
    var items: TranscriptListItems<Item>?
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

  /// The geometry, reduced to what the history paging acts on.
  struct Edges: Equatable {
    var nearTop: Bool

    init(_ geometry: ScrollGeometry, bottomThreshold: CGFloat, topThreshold: CGFloat) {
      let visible = geometry.visibleRect
      nearTop = geometry.contentSize.height > geometry.containerSize.height && visible.minY <= topThreshold
    }
  }
}
