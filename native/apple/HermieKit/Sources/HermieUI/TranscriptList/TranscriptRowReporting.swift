import SwiftUI

/// How the collection-view list hosts a row: at its ideal height whatever height it is offered,
/// so its size depends on the width alone, and (in a cell) reporting that height when its content
/// changes it.
///
/// - `.id(id)`: a cell is reused for another row, and without a fresh identity SwiftUI kept the
///   previous occupant's geometry, so `onGeometryChange` stayed silent when the new row happened
///   to be as tall as the old one had been, and the layout kept a height measured for something
///   else.
/// - `.ignoresSafeArea()`: the list scrolls under the header and the composer, and a row must not
///   be laid out inset by the part of a bar its cell is under (the cell reports no safe area too,
///   `TranscriptHostingCell`).
struct TranscriptRowReporting<ID: Hashable>: ViewModifier {
  let id: ID
  /// Called with the row's height, rounded up; nil when the row is only being measured.
  let report: ((CGFloat) -> Void)?

  func body(content: Content) -> some View {
    content
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { height in
        report?(height)
      }
      .frame(maxHeight: .infinity, alignment: .top)
      .ignoresSafeArea()
      .id(id)
  }
}
