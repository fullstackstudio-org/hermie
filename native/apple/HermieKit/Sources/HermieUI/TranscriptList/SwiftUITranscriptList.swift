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
      _ = tracker.follow.geometryChanged(from: old, to: new, phase: tracker.phase, threshold: state.bottomThreshold)
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
      tracker.follow.phaseChanged(to: tracker.phase)
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
    .onChange(of: Structure(items)) { before, after in
      // Rows removed or replaced (a reconcile that moved or renamed rows): the position the lazy
      // stack keeps is the id of the row at the top of the viewport, and when that row is gone it
      // drew an empty viewport there, with the scroller still showing content. Following, the
      // list goes back to the bottom; scrolled up, to the nearest row that is still there.
      let ids = items.map(\.id)
      defer { tracker.lastIDs = ids }
      if tracker.follow.following {
        if after.count < before.count || after.first != before.first {
          position.scrollTo(edge: .bottom)
        }
        return
      }
      guard let top = position.viewID(type: Item.ID.self) else { return }
      let present = Set(ids)
      guard !present.contains(top), let old = tracker.lastIDs.firstIndex(of: top) else { return }
      let survivor =
        tracker.lastIDs[old...].first(where: present.contains) ?? tracker.lastIDs[..<old].last(where: present.contains)
      if let survivor {
        position.scrollTo(id: survivor, anchor: .top)
      }
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

  /// The shape of the rows, cheap to compare: how many, and the first and last ids.
  struct Structure: Equatable {
    var count: Int
    var first: Item.ID?
    var last: Item.ID?

    init(_ items: TranscriptListItems<Item>) {
      count = items.count
      first = items.first?.id
      last = items.last?.id
    }
  }

  /// The follow state and what it is decided from, kept out of observation.
  @MainActor final class FollowTracker {
    var follow = TranscriptFollow()
    var phase = TranscriptFollow.Phase.idle
    /// The row ids as of the last structural change, oldest first.
    var lastIDs: [Item.ID] = []
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
