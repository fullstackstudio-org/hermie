import CoreGraphics
import HermieMarkdown

/// Which picture of a message the full-screen gallery shows, and where the reader can go from
/// there. Pure state: the gallery's views read it and the swipe, the arrow keys and the buttons
/// write it.
struct ImageGalleryModel: Equatable {
  let images: [MessageImage]
  private(set) var index: Int

  /// A gallery over `images`, opened on `start` (clamped into range; an empty gallery stays on 0).
  init(images: [MessageImage], start: Int = 0) {
    self.images = images
    self.index = images.isEmpty ? 0 : min(max(start, 0), images.count - 1)
  }

  var isEmpty: Bool { images.isEmpty }
  var current: MessageImage? { images.indices.contains(index) ? images[index] : nil }
  var hasPrevious: Bool { index > 0 }
  var hasNext: Bool { index + 1 < images.count }

  /// "2 of 5": one-based, for the title and for VoiceOver. Nothing for a lone picture.
  var position: (current: Int, total: Int)? {
    images.count > 1 ? (index + 1, images.count) : nil
  }

  /// Moves to `target`, clamped. Returns whether it moved.
  @discardableResult
  mutating func select(_ target: Int) -> Bool {
    guard !images.isEmpty else { return false }
    let clamped = min(max(target, 0), images.count - 1)
    guard clamped != index else { return false }
    index = clamped
    return true
  }

  @discardableResult
  mutating func next() -> Bool { select(index + 1) }

  @discardableResult
  mutating func previous() -> Bool { select(index - 1) }

  /// The pictures worth having decoded before the reader gets to them: the current one and its
  /// neighbours.
  var preload: [Int] {
    guard !images.isEmpty else { return [] }
    return Array(max(0, index - 1)...min(images.count - 1, index + 1))
  }
}

/// Pinch and pan on one picture of the gallery: the arithmetic, apart from the gestures.
struct ImageZoom: Equatable {
  static let minimumScale: CGFloat = 1
  static let maximumScale: CGFloat = 6
  /// Where a double tap on a picture at rest zooms to.
  static let doubleTapScale: CGFloat = 2.5

  private(set) var scale: CGFloat = 1
  var offset: CGSize = .zero

  var isZoomed: Bool { scale > Self.minimumScale + 0.001 }

  /// Sets the scale, held between the least and the most; back at rest, the picture is centred.
  mutating func setScale(_ proposed: CGFloat) {
    guard proposed.isFinite else { return }
    scale = min(max(proposed, Self.minimumScale), Self.maximumScale)
    if !isZoomed { offset = .zero }
  }

  /// A double tap: a picture at rest zooms in, a zoomed one goes back.
  mutating func toggle() {
    if isZoomed {
      self = ImageZoom()
    } else {
      setScale(Self.doubleTapScale)
    }
  }

  /// `offset` pulled back so no edge of the picture comes away from the edge of the view: the
  /// picture, fitted into `container` at `fitted` and scaled by `scale`, may move only as far as it
  /// overhangs the view.
  static func clampedOffset(_ offset: CGSize, scale: CGFloat, fitted: CGSize, container: CGSize) -> CGSize {
    let overhangX = max(0, (fitted.width * scale - container.width) / 2)
    let overhangY = max(0, (fitted.height * scale - container.height) / 2)
    return CGSize(
      width: min(max(offset.width, -overhangX), overhangX),
      height: min(max(offset.height, -overhangY), overhangY))
  }
}
