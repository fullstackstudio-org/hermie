import SwiftUI

/// The scrolling surface of a chat: rows from oldest to newest, anchored to the
/// bottom.
///
/// This is a boundary (D14 in the native plan). Its public surface — the rows,
/// a `TranscriptListState`, a row builder and an optional overlay for the jump
/// pill — says nothing about how the list is drawn, so the implementation
/// behind it can be swapped without touching the item views or the chat
/// screen. The current one is a SwiftUI `ScrollView` over a `LazyVStack`
/// (`SwiftUITranscriptList`); the spike that chose it, and its numbers, are in
/// docs/native.md, "Transcript list".
///
/// What it promises:
///
/// - it opens at the newest row, and follows the newest row as it grows while
///   the reader is at the bottom;
/// - while the reader is scrolled up, nothing moves under them: a row growing
///   below and rows prepended above leave the visible rows where they are;
/// - a row's builder runs again only when that row's `Item` changed (`==`), so
///   a streamed delta re-renders the streaming row and nothing else. The
///   builder must therefore depend on nothing but its item and stable
///   references: a value captured from elsewhere does not refresh the row.
public struct TranscriptList<Item: Identifiable & Equatable & Sendable, Row: View, Overlay: View>: View
where Item.ID: Sendable {
  private let items: TranscriptListItems<Item>
  private let state: TranscriptListState
  private let spacing: CGFloat
  private let row: (Item) -> Row
  private let overlay: (TranscriptListState) -> Overlay

  /// - Parameters:
  ///   - items: the rows, oldest first.
  ///   - state: where the list is and what it was asked to do.
  ///   - spacing: the gap between rows.
  ///   - row: builds one row. See the type's notes on what it may capture.
  ///   - overlay: drawn over the bottom edge; the jump pill goes here.
  public init(
    _ items: TranscriptListItems<Item>,
    state: TranscriptListState,
    spacing: CGFloat = 8,
    @ViewBuilder row: @escaping (Item) -> Row,
    @ViewBuilder overlay: @escaping (TranscriptListState) -> Overlay
  ) {
    self.items = items
    self.state = state
    self.spacing = spacing
    self.row = row
    self.overlay = overlay
  }

  public var body: some View {
    SwiftUITranscriptList(items: items, state: state, spacing: spacing, row: row)
      .overlay(alignment: .bottom) {
        overlay(state)
      }
  }
}

extension TranscriptList {
  /// For a short or one-off list; a model that publishes snapshots should hold
  /// `TranscriptListItems` instead (see there why).
  public init(
    _ items: [Item],
    state: TranscriptListState,
    spacing: CGFloat = 8,
    @ViewBuilder row: @escaping (Item) -> Row,
    @ViewBuilder overlay: @escaping (TranscriptListState) -> Overlay
  ) {
    self.init(TranscriptListItems(items), state: state, spacing: spacing, row: row, overlay: overlay)
  }
}

extension TranscriptList where Overlay == EmptyView {
  public init(
    _ items: TranscriptListItems<Item>,
    state: TranscriptListState,
    spacing: CGFloat = 8,
    @ViewBuilder row: @escaping (Item) -> Row
  ) {
    self.init(items, state: state, spacing: spacing, row: row) { _ in EmptyView() }
  }

  public init(
    _ items: [Item],
    state: TranscriptListState,
    spacing: CGFloat = 8,
    @ViewBuilder row: @escaping (Item) -> Row
  ) {
    self.init(TranscriptListItems(items), state: state, spacing: spacing, row: row) { _ in EmptyView() }
  }
}

/// One row, compared on its item, so SwiftUI skips the builder for a row whose
/// item did not change.
struct TranscriptListRow<Item: Equatable & Sendable, Row: View>: View, Equatable {
  let item: Item
  let row: (Item) -> Row

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.item == rhs.item
  }

  var body: some View {
    row(item)
  }
}
