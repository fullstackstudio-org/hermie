import Foundation

/// One point of a drawn signature, in the pad's own coordinates (points, origin top left).
public struct SignaturePoint: Sendable, Equatable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

/// One stroke: what the pen drew between touching down and lifting.
public struct SignatureStroke: Sendable, Equatable {
  public var points: [SignaturePoint]

  public init(points: [SignaturePoint]) {
    self.points = points
  }

  /// The length of the line the points make.
  public var length: Double {
    zip(points, points.dropFirst()).reduce(0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
  }
}

/// What the person has drawn on the pad: the one thing both files of a signature are made from, whichever
/// drawing view collected it (`PKCanvasView` on iOS, a plain pad on the Mac). The model holds only points: no
/// pressure, no colour, nothing of the pen. The PNG and the SVG are drawn from these, so they show the same
/// signature (`SignatureArtwork`).
///
/// It is bounded, so a hand that never lifts cannot grow a file past what the gateway takes: points closer than
/// `minimumGap` to the one before are dropped, and at `maxPoints` (or `maxStrokes`) the pad takes no more.
public struct SignatureInk: Sendable, Equatable {
  /// The most points all strokes may hold together.
  public static let maxPoints = 20_000
  /// The most strokes.
  public static let maxStrokes = 200
  /// A point nearer than this (in points) to the previous one adds nothing to the line.
  public static let minimumGap = 0.75
  /// How much line makes a signature: a tap is not one.
  public static let minimumLength = 24.0

  public private(set) var strokes: [SignatureStroke] = []

  public init() {}

  /// Build ink from strokes drawn elsewhere (a `PKDrawing`'s strokes, sampled): each point is filtered like a
  /// point drawn here.
  public init(strokes drawn: [[SignaturePoint]]) {
    for points in drawn {
      guard let first = points.first, begin(at: first) else { continue }

      for point in points.dropFirst() {
        extend(to: point)
      }
    }
  }

  public var isEmpty: Bool { strokes.isEmpty }

  public var pointCount: Int { strokes.reduce(0) { $0 + $1.points.count } }

  /// The line drawn, in points.
  public var length: Double { strokes.reduce(0) { $0 + $1.length } }

  /// Enough has been drawn to be a signature.
  public var isSignature: Bool { length >= Self.minimumLength }

  private static func isUsable(_ point: SignaturePoint) -> Bool {
    point.x.isFinite && point.y.isFinite && abs(point.x) < 100_000 && abs(point.y) < 100_000
  }

  /// The pen touched down at `point`. False when the pad takes no more strokes or the point is not a place.
  @discardableResult
  public mutating func begin(at point: SignaturePoint) -> Bool {
    guard Self.isUsable(point), strokes.count < Self.maxStrokes, pointCount < Self.maxPoints else {
      return false
    }

    strokes.append(SignatureStroke(points: [point]))
    return true
  }

  /// The pen moved to `point` in the stroke it is drawing.
  public mutating func extend(to point: SignaturePoint) {
    guard Self.isUsable(point), let last = strokes.last?.points.last, pointCount < Self.maxPoints else {
      return
    }

    guard hypot(point.x - last.x, point.y - last.y) >= Self.minimumGap else {
      return
    }

    strokes[strokes.count - 1].points.append(point)
  }

  /// Take the last stroke back.
  public mutating func undo() {
    if !strokes.isEmpty {
      strokes.removeLast()
    }
  }

  public mutating func clear() {
    strokes = []
  }

  // MARK: - Artwork

  /// The strokes cropped to what was drawn, with a margin, scaled down (never up) to at most `maxWidth` by
  /// `maxHeight`, in the units both files use. Nil when nothing was drawn.
  public func artwork(
    margin: Double = 12, maxWidth: Double = 800, maxHeight: Double = 400, lineWidth: Double = 3
  ) -> SignatureArtwork? {
    let all = strokes.flatMap(\.points)

    guard let first = all.first else {
      return nil
    }

    var minX = first.x
    var maxX = first.x
    var minY = first.y
    var maxY = first.y

    for point in all {
      minX = min(minX, point.x)
      maxX = max(maxX, point.x)
      minY = min(minY, point.y)
      maxY = max(maxY, point.y)
    }

    let drawnWidth = max(maxX - minX, 1)
    let drawnHeight = max(maxY - minY, 1)
    let room = margin + lineWidth / 2
    let scale = min(1, (maxWidth - 2 * room) / drawnWidth, (maxHeight - 2 * room) / drawnHeight)
    // Whole units, never more than the bounds (a rounding error must not make 800 into 801).
    let width = min(Int(maxWidth), max(1, Int((drawnWidth * scale + 2 * room - 1e-6).rounded(.up))))
    let height = min(Int(maxHeight), max(1, Int((drawnHeight * scale + 2 * room - 1e-6).rounded(.up))))

    // Centred in the frame, so a rounding up leaves the same room on both sides.
    let offsetX = (Double(width) - drawnWidth * scale) / 2
    let offsetY = (Double(height) - drawnHeight * scale) / 2

    let placed = strokes.map { stroke in
      stroke.points.map {
        SignaturePoint(x: ($0.x - minX) * scale + offsetX, y: ($0.y - minY) * scale + offsetY)
      }
    }

    return SignatureArtwork(width: width, height: height, lineWidth: lineWidth, strokes: placed)
  }
}

/// A signature ready to be written as a PNG and as an SVG: whole-number dimensions, and strokes already placed
/// inside them.
public struct SignatureArtwork: Sendable, Equatable {
  public let width: Int
  public let height: Int
  public let lineWidth: Double
  public let strokes: [[SignaturePoint]]

  /// A stroke shorter than this is a dot, drawn as one.
  static let dotLength = 1.0

  /// What one stroke is drawn as: a dot, or a line through its points, smoothed through the midpoints.
  public enum Segment: Equatable, Sendable {
    case move(SignaturePoint)
    case line(SignaturePoint)
    case quad(control: SignaturePoint, end: SignaturePoint)
    case dot(SignaturePoint)
  }

  /// The segments of one stroke. Two points are a line; three or more a curve that passes through the first and
  /// the last and leans toward the points between (a quadratic through each midpoint).
  public static func segments(of points: [SignaturePoint]) -> [Segment] {
    guard let first = points.first else {
      return []
    }

    let length = SignatureStroke(points: points).length

    if points.count == 1 || length < dotLength {
      return [.dot(first)]
    }

    if points.count == 2 {
      return [.move(first), .line(points[1])]
    }

    var segments: [Segment] = [.move(first)]

    for index in 1..<(points.count - 1) {
      let control = points[index]
      let next = points[index + 1]
      segments.append(.quad(control: control, end: SignaturePoint(x: (control.x + next.x) / 2, y: (control.y + next.y) / 2)))
    }

    segments.append(.line(points[points.count - 1]))
    return segments
  }
}
