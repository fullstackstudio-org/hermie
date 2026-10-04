import CoreGraphics

/// Where the pictures of one message go: a pure function of how many there are and how wide the
/// room is, never of what has loaded.
///
/// That is the point of it. A row in the transcript is measured once and kept; a thumbnail that
/// brought its own size with it would change the row's height when it arrived, and the reader would
/// be moved by exactly that much. Every frame here is decided before a byte is fetched, so a
/// picture arriving (or failing) changes what is drawn inside its frame and nothing else.
///
/// One picture is a wide frame the picture is fitted into; two or more are a grid of squares the
/// pictures fill and crop, as Messages draws them (the same split the Expo app made: a lone picture
/// is the message, a grid is a grid).
enum MediaImageLayout {
  /// The widest a block of pictures grows, in points.
  static let maxWidth: CGFloat = 260
  /// The gap between two pictures.
  static let spacing: CGFloat = 4
  /// The most frames a message shows; with more, the last one says how many there are.
  static let maxCells = 9
  /// A lone picture's frame is this share of its width tall.
  static let soloAspect: CGFloat = 0.75
  /// The corner of a frame.
  static let cornerRadius: CGFloat = 12

  struct Cell: Equatable {
    var rect: CGRect
    /// Which of the message's pictures the frame shows.
    var index: Int
    /// On the last frame of a message with more pictures than frames: how many pictures it stands for
    /// (itself and the ones that did not fit), so it can say "+N".
    var overflow: Int?
  }

  struct Plan: Equatable {
    var size: CGSize
    var cells: [Cell]
    var columns: Int
  }

  /// How many pictures go across: one fills the width, two and four go in pairs, the rest in threes.
  static func columns(forCount count: Int) -> Int {
    switch count {
    case ...1: 1
    case 2, 4: 2
    default: 3
    }
  }

  /// How many frames a message of `count` pictures has.
  static func visibleCount(_ count: Int) -> Int {
    min(max(count, 0), maxCells)
  }

  /// The block's size and its frames, for the room `width` allows. A width that is not a width (a
  /// probe: nothing, infinity, zero or less) is the widest the block grows.
  static func plan(count: Int, width proposed: CGFloat?) -> Plan {
    let visible = visibleCount(count)
    guard visible > 0 else { return Plan(size: .zero, cells: [], columns: 1) }

    let width: CGFloat
    if let proposed, proposed.isFinite, proposed > 0 {
      width = min(proposed, maxWidth)
    } else {
      width = maxWidth
    }

    let columns = columns(forCount: visible)

    if columns == 1 {
      let height = (width * soloAspect).rounded()
      let cell = Cell(rect: CGRect(x: 0, y: 0, width: width, height: height), index: 0, overflow: nil)
      return Plan(size: CGSize(width: width, height: height), cells: [cell], columns: 1)
    }

    let side = ((width - spacing * CGFloat(columns - 1)) / CGFloat(columns)).rounded(.down)
    let rows = (visible + columns - 1) / columns
    var cells: [Cell] = []
    cells.reserveCapacity(visible)
    for index in 0..<visible {
      let column = index % columns
      let row = index / columns
      let origin = CGPoint(x: CGFloat(column) * (side + spacing), y: CGFloat(row) * (side + spacing))
      let overflow = count > maxCells && index == visible - 1 ? count - (visible - 1) : nil
      cells.append(Cell(rect: CGRect(origin: origin, size: CGSize(width: side, height: side)), index: index, overflow: overflow))
    }
    let size = CGSize(
      width: side * CGFloat(columns) + spacing * CGFloat(columns - 1),
      height: side * CGFloat(rows) + spacing * CGFloat(rows - 1))
    return Plan(size: size, cells: cells, columns: columns)
  }

  /// The largest size with `aspect` (width over height) that fits inside `container`, centred: where
  /// a picture lands when it is fitted into a frame.
  static func fitted(aspect: CGFloat, in container: CGSize) -> CGSize {
    guard aspect.isFinite, aspect > 0, container.width > 0, container.height > 0 else { return container }
    if container.width / container.height > aspect {
      return CGSize(width: container.height * aspect, height: container.height)
    }
    return CGSize(width: container.width, height: container.width / aspect)
  }

  /// The decoded size a thumbnail needs for `frame` on a screen with `scale` pixels to a point,
  /// rounded up to a step of 64 so two frames of nearly one size share a cache entry.
  static func thumbnailPixels(for frame: CGSize, scale: CGFloat) -> Int {
    let longest = max(frame.width, frame.height) * max(scale, 1)
    return max(64, Int((longest / 64).rounded(.up)) * 64)
  }
}
