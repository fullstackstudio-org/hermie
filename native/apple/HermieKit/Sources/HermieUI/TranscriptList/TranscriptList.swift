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

  @Environment(\.transcriptListImplementation) private var requested

  public var body: some View {
    implementation
      .overlay(alignment: .bottom) {
        overlay(state)
      }
  }

  @ViewBuilder private var implementation: some View {
    switch TranscriptListImplementation.resolved(requested) {
    case .swiftUI:
      SwiftUITranscriptList(items: items, state: state, spacing: spacing, row: row)
    case .collection:
      CollectionTranscriptHost(items: items, state: state, spacing: spacing, row: row)
    }
  }
}

/// Which list draws a `TranscriptList`; see "Transcript list" in docs/native.md.
enum TranscriptListImplementation: String, CaseIterable, Sendable {
  /// `ScrollView` + `LazyVStack` (implementation A).
  case swiftUI
  /// `UICollectionView` / `NSCollectionView` with SwiftUI rows (implementation B).
  case collection

  /// What a list uses when nothing asks for one in particular: the collection
  /// view on iPhone and iPad (the SwiftUI list loses the reader's place on a
  /// prepend under iOS 26.x), the SwiftUI list on the Mac until the collection
  /// view has been measured there (docs/native.md, "Transcript list").
  #if os(macOS)
    static let standard = TranscriptListImplementation.swiftUI
  #else
    static let standard = TranscriptListImplementation.collection
  #endif

  /// `requested`, else the launch argument `-HermieListImplementation` (debug
  /// builds; the lab and its UI tests use it), else `standard`.
  static func resolved(_ requested: TranscriptListImplementation?) -> TranscriptListImplementation {
    if let requested { return requested }
    #if DEBUG
      if let raw = UserDefaults.standard.string(forKey: "HermieListImplementation"), let forced = Self(rawValue: raw) {
        return forced
      }
    #endif
    return standard
  }
}

extension EnvironmentValues {
  /// Forces one implementation of `TranscriptList`, for the lab's comparisons.
  @Entry var transcriptListImplementation: TranscriptListImplementation? = nil
}

/// Implementation B behind the boundary: measures the safe area the list is
/// given and hands it to the collection view as content insets, so rows
/// scroll under bars and the composer while the newest row still stops above
/// them.
///
/// The collection view ignores every region of the safe area, the keyboard's
/// included: the keyboard is in the insets it is handed, and a view that also
/// let the keyboard shorten its frame counted the keyboard twice, leaving a
/// keyboard's height of empty list between the newest row and the composer.
struct CollectionTranscriptHost<Item: Identifiable & Equatable & Sendable, Row: View>: View where Item.ID: Sendable {
  let items: TranscriptListItems<Item>
  let state: TranscriptListState
  let spacing: CGFloat
  let row: (Item) -> Row

  @State private var insets = EdgeInsets()

  var body: some View {
    Color.clear
      .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { insets = $0 }
      .overlay {
        CollectionTranscriptList(
          items: items, state: state, spacing: spacing, insets: insets, commandSerial: state.commandSerial, row: row
        )
        .ignoresSafeArea(edges: .vertical)
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
