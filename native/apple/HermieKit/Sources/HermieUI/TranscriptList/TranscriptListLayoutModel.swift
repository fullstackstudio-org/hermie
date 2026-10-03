import CoreGraphics

/// The geometry of the collection-view transcript list, shared by the UIKit
/// and AppKit layouts: one row per item, stacked top to bottom with `spacing`
/// between them, each as tall as it last measured (or `estimatedHeight` until
/// it has been on screen).
///
/// Heights are kept by item id, not by index, so a prepend, a trim or a
/// roll-up keeps every measured row's height and the rows that did not change
/// keep their positions relative to each other. That is what makes the anchor
/// arithmetic below exact.
///
/// The anchor rule, used for every change that is not the reader's own
/// scrolling: the first row whose bottom is below the top of the viewport
/// stays where it is on screen. A row that grows or shrinks above that point
/// moves the content offset by the same amount, so nothing visible moves;
/// one at or below it grows downwards and moves nothing above it. While the
/// reader is at the bottom the bottom edge is kept instead.
struct TranscriptListLayoutModel<ID: Hashable> {
  /// Where a row is and how tall it is.
  struct Measured {
    var height: CGFloat
    /// The width it was measured at; a row measured at another width keeps its
    /// height as an estimate until it is measured again.
    var width: CGFloat
  }

  /// A row on screen and how far its top is below the top of the viewport,
  /// in points (negative when it starts above it).
  struct Anchor: Equatable {
    var id: ID
    var offset: CGFloat
  }

  private(set) var ids: [ID] = []
  private(set) var index: [ID: Int] = [:]
  private(set) var tops: [CGFloat] = []
  private(set) var contentHeight: CGFloat = 0
  private var measured: [ID: Measured] = [:]

  var spacing: CGFloat = 8 {
    didSet { if spacing != oldValue { recompute() } }
  }

  var estimatedHeight: CGFloat = 72 {
    didSet { if estimatedHeight != oldValue { recompute() } }
  }

  /// The width rows are laid out at.
  private(set) var width: CGFloat = 0

  var count: Int { ids.count }

  /// Replaces the rows. Heights are carried over by id; ids no longer present
  /// are forgotten.
  mutating func setIDs(_ newIDs: [ID]) {
    ids = newIDs
    var newIndex: [ID: Int] = [:]
    newIndex.reserveCapacity(newIDs.count)
    for (position, id) in newIDs.enumerated() {
      newIndex[id] = position
    }
    index = newIndex
    if measured.count > newIDs.count * 2 + 64 {
      measured = measured.filter { newIndex[$0.key] != nil }
    }
    recompute()
  }

  /// Lays rows out at `newWidth`. Measured heights stay as estimates.
  mutating func setWidth(_ newWidth: CGFloat) {
    width = newWidth
  }

  func height(of id: ID) -> CGFloat {
    measured[id]?.height ?? estimatedHeight
  }

  /// Whether `id` was measured at the current width.
  func isMeasured(_ id: ID) -> Bool {
    measured[id]?.width == width
  }

  /// Whether a new measurement of a row is a change worth laying out: any
  /// first measurement at this width, and afterwards a change of more than
  /// `measurementTolerance`. A row on screen is measured again whenever the
  /// layout is invalidated, and text heights round differently from one
  /// measurement to the next by a point; taking those would move every row
  /// below by that point. A real change (a line of text, a disclosure) is far
  /// larger.
  func accepts(_ height: CGFloat, for id: ID) -> Bool {
    guard isMeasured(id) else { return true }
    return abs(height - self.height(of: id)) > Self.measurementTolerance
  }

  static var measurementTolerance: CGFloat { 1.5 }

  /// Records a measured height and answers by how much the row changed.
  @discardableResult
  mutating func setHeight(_ height: CGFloat, for id: ID) -> CGFloat {
    let old = self.height(of: id)
    let wasMeasured = isMeasured(id)
    measured[id] = Measured(height: height, width: width)
    let delta = height - old
    #if DEBUG
      if delta != 0 {
        TranscriptListDiagnostics.remeasured.append("\(id):\(Int(old))→\(Int(height))\(wasMeasured ? "" : "(first)")")
      }
    #endif
    if delta != 0, let position = index[id] {
      // Only the rows below move: shift their tops instead of recomputing.
      for later in (position + 1)..<ids.count {
        tops[later] += delta
      }
      contentHeight += delta
    }
    return delta
  }

  /// The whole layout again, O(n). Called when the rows or the spacing change.
  mutating func recompute() {
    tops.removeAll(keepingCapacity: true)
    tops.reserveCapacity(ids.count)
    var y: CGFloat = 0
    for (position, id) in ids.enumerated() {
      if position > 0 { y += spacing }
      tops.append(y)
      y += height(of: id)
    }
    contentHeight = y
  }

  func frame(at position: Int) -> CGRect {
    CGRect(x: 0, y: tops[position], width: width, height: height(of: ids[position]))
  }

  func frame(of id: ID) -> CGRect? {
    index[id].map(frame(at:))
  }

  /// The rows that intersect `minY..<maxY`, found by binary search.
  func positions(intersecting minY: CGFloat, _ maxY: CGFloat) -> Range<Int> {
    guard !ids.isEmpty, maxY > minY else { return 0..<0 }
    let first = firstPosition(endingBelow: minY)
    var last = first
    while last < ids.count && tops[last] < maxY {
      last += 1
    }
    return first..<last
  }

  /// The first row whose bottom is below `y`.
  func firstPosition(endingBelow y: CGFloat) -> Int {
    var low = 0
    var high = ids.count
    while low < high {
      let mid = (low + high) / 2
      if tops[mid] + height(of: ids[mid]) <= y {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  /// The row the anchor rule keeps in place, for a viewport whose top is at
  /// `visibleTop` in content coordinates.
  func anchor(visibleTop: CGFloat) -> Anchor? {
    let position = firstPosition(endingBelow: visibleTop)
    guard position < ids.count else { return nil }
    return Anchor(id: ids[position], offset: tops[position] - visibleTop)
  }

  /// The viewport top that puts `anchor` back where it was, or nil when its
  /// row is gone.
  func visibleTop(restoring anchor: Anchor) -> CGFloat? {
    frame(of: anchor.id).map { $0.minY - anchor.offset }
  }

  /// By how much the viewport must move when the row at `position` changes
  /// height by `delta`, so that nothing visible moves: the full change for a
  /// row that starts above the viewport's top, nothing otherwise.
  func offsetAdjustment(forRowAt position: Int, delta: CGFloat, visibleTop: CGFloat, pinnedToBottom: Bool) -> CGFloat {
    if pinnedToBottom { return delta }
    // `tops` already holds the new layout for the rows below; this row's top
    // did not move.
    return tops[position] < visibleTop ? delta : 0
  }
}

#if DEBUG
  /// What the lab reads to explain a movement: rows whose measured height
  /// changed after they had been measured once at the same width.
  enum TranscriptListDiagnostics {
    // Debug builds only, and only ever touched from the main thread (the
    // layouts and the lab), so unchecked.
    nonisolated(unsafe) static var remeasured: [String] = []
    /// The largest on-screen movement of a row that was on screen before and
    /// after the last structural change, in points, measured on the row views
    /// themselves (not on the model).
    nonisolated(unsafe) static var lastStructuralShift: CGFloat?

    /// Records the shift between two snapshots of on-screen row positions.
    static func recordShift<ID: Hashable>(before: [ID: CGFloat], after: [ID: CGFloat]) {
      lastStructuralShift = before.compactMap { id, y in after[id].map { abs($0 - y) } }.max()
    }
  }
#endif
