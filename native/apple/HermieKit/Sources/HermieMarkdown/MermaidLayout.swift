import CoreGraphics
import Foundation

/// A flowchart as coordinates, in one synchronous pass: a layered drawing, which is what a flowchart is.
///
/// Every number comes out of a label's character count and the font size, never out of a measurement
/// (the web client's rule, `packages/markdown/src/mermaid/layout.ts`): the diagram's size is known
/// before anything is drawn, so a diagram never resizes its row after the row was laid out. The
/// estimate is wrong in the same way on every platform and stable from the first frame.
///
/// Nodes get a rank from the longest path to them, ranks become rows (or columns, left to right), and
/// within a rank the order is the order the source mentioned them: a crossing-minimising pass would
/// draw a tidier picture and also draw the same source differently as the heuristic was tuned.
public struct MermaidPlacedNode: Sendable, Hashable {
  public var node: MermaidNode
  public var rect: CGRect
  /// The label, already broken into the lines the box draws.
  public var lines: [String]
}

public struct MermaidPlacedEdge: Sendable, Hashable {
  public var edge: MermaidEdge
  /// The start and the end, cut back to each box's rim.
  public var start: CGPoint
  public var end: CGPoint
}

public struct MermaidFlowLayout: Sendable, Hashable {
  public var size: CGSize
  public var fontSize: CGFloat
  public var nodes: [MermaidPlacedNode]
  public var edges: [MermaidPlacedEdge]
}

public enum MermaidLayout {
  static let paddingX: CGFloat = 14
  static let paddingY: CGFloat = 9
  static let minimumWidth: CGFloat = 56
  static let maximumWidth: CGFloat = 190
  static let gapWithin: CGFloat = 22
  static let gapBetween: CGFloat = 46
  static let margin: CGFloat = 10

  /// A rough advance per character, as a fraction of the font size.
  static let characterEm: CGFloat = 0.58

  /// The size a diagram's labels are set at: under the body's.
  public static func diagramFontSize(body: CGFloat) -> CGFloat {
    max(10, body - 3)
  }

  public static func lineHeight(_ fontSize: CGFloat) -> CGFloat {
    (fontSize * 1.35).rounded()
  }

  /// A label broken on word boundaries to fit `maxTextWidth`; an explicit line break is kept, and a
  /// word longer than a line is left whole.
  static func wrap(_ label: String, fontSize: CGFloat, maxTextWidth: CGFloat) -> [String] {
    let advance = fontSize * characterEm
    let limit = max(6, Int((maxTextWidth / advance).rounded(.down)))
    return label.components(separatedBy: "\n").flatMap { line -> [String] in
      let words = line.split(whereSeparator: { $0.isWhitespace }).map(String.init)
      guard !words.isEmpty else { return [""] }
      var out: [String] = []
      var current = ""
      for word in words {
        let candidate = current.isEmpty ? word : "\(current) \(word)"
        if candidate.count <= limit || current.isEmpty {
          current = candidate
          continue
        }
        out.append(current)
        current = word
      }
      if !current.isEmpty { out.append(current) }
      return out
    }
  }

  static func boxSize(lines: [String], shape: MermaidShape, fontSize: CGFloat) -> CGSize {
    let widest = lines.map(\.count).max() ?? 0
    // A little slack on the estimate: a label that wraps where the geometry did not expect it to
    // overflows its own box.
    var width = min(maximumWidth, max(minimumWidth, (CGFloat(widest) * fontSize * characterEm * 1.06).rounded(.up) + paddingX * 2))
    var height = CGFloat(lines.count) * lineHeight(fontSize) + paddingY * 2
    switch shape {
    case .rhombus:
      width = (width * 1.35).rounded()
      height = (height * 1.5).rounded()
    case .circle:
      let diameter = max(width, height) + 8
      width = diameter
      height = diameter
    case .hexagon:
      width += 16
    default:
      break
    }
    return CGSize(width: width, height: height)
  }

  /// Every node's rank: the longest path from a source to it, by relaxation bounded by the node count
  /// so a cycle terminates (a back edge stops raising its target once nothing moves).
  static func ranks(of chart: MermaidFlowchart) -> [String: Int] {
    var rank = Dictionary(uniqueKeysWithValues: chart.nodes.map { ($0.id, 0) })
    for _ in 0..<chart.nodes.count {
      var moved = false
      for edge in chart.edges {
        guard let from = rank[edge.from], let to = rank[edge.to] else { continue }
        if to < from + 1 {
          rank[edge.to] = from + 1
          moved = true
        }
      }
      if !moved { break }
    }
    return rank
  }

  public static func layout(_ chart: MermaidFlowchart, bodyFontSize: CGFloat) -> MermaidFlowLayout {
    let fontSize = diagramFontSize(body: bodyFontSize)
    let rank = ranks(of: chart)
    let horizontal = chart.direction.isHorizontal

    struct Sized {
      var node: MermaidNode
      var lines: [String]
      var size: CGSize
      var origin = CGPoint.zero
    }

    var sized = chart.nodes.map { node -> Sized in
      let lines = wrap(node.label, fontSize: fontSize, maxTextWidth: maximumWidth - paddingX * 2)
      return Sized(node: node, lines: lines, size: boxSize(lines: lines, shape: node.shape, fontSize: fontSize))
    }

    var byRank: [Int: [Int]] = [:]
    for (index, item) in sized.enumerated() {
      byRank[rank[item.node.id] ?? 0, default: []].append(index)
    }
    let ranks = byRank.keys.sorted()

    func main(_ size: CGSize) -> CGFloat { horizontal ? size.width : size.height }
    func cross(_ size: CGSize) -> CGFloat { horizontal ? size.height : size.width }

    var rankMain: [Int: CGFloat] = [:]
    var rankSpread: [Int: CGFloat] = [:]
    var cursor = margin
    for at in ranks {
      let bucket = byRank[at] ?? []
      let depth = bucket.map { main(sized[$0].size) }.max() ?? 0
      let spread = bucket.map { cross(sized[$0].size) }.reduce(0, +) + gapWithin * CGFloat(max(0, bucket.count - 1))
      rankMain[at] = cursor
      rankSpread[at] = spread
      cursor += depth + gapBetween
    }

    let mainSize = max(cursor - gapBetween + margin, margin * 2)
    let crossSize = (rankSpread.values.max() ?? 0) + margin * 2

    for at in ranks {
      let bucket = byRank[at] ?? []
      let depth = bucket.map { main(sized[$0].size) }.max() ?? 0
      var across = (crossSize - (rankSpread[at] ?? 0)) / 2
      for index in bucket {
        // Centred in the rank's own depth, so a tall rhombus beside a short box does not drag the
        // row's arrows out of line.
        let along = (rankMain[at] ?? margin) + (depth - main(sized[index].size)) / 2
        sized[index].origin = horizontal ? CGPoint(x: along, y: across) : CGPoint(x: across, y: along)
        across += cross(sized[index].size) + gapWithin
      }
    }

    let width = horizontal ? mainSize : crossSize
    let height = horizontal ? crossSize : mainSize

    // Bottom-up and right-to-left are the forward layout reflected along the main axis.
    if chart.direction == .bottomUp || chart.direction == .rightLeft {
      for index in sized.indices {
        if horizontal {
          sized[index].origin.x = width - sized[index].origin.x - sized[index].size.width
        } else {
          sized[index].origin.y = height - sized[index].origin.y - sized[index].size.height
        }
      }
    }

    let nodes = sized.map {
      MermaidPlacedNode(node: $0.node, rect: CGRect(origin: $0.origin, size: $0.size), lines: $0.lines)
    }
    let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.node.id, $0) })
    let edges = chart.edges.compactMap { edge -> MermaidPlacedEdge? in
      guard let from = byID[edge.from], let to = byID[edge.to] else { return nil }
      let a = CGPoint(x: from.rect.midX, y: from.rect.midY)
      let b = CGPoint(x: to.rect.midX, y: to.rect.midY)
      return MermaidPlacedEdge(edge: edge, start: rim(of: from.rect, from: a, towards: b), end: rim(of: to.rect, from: b, towards: a))
    }
    return MermaidFlowLayout(size: CGSize(width: width, height: height), fontSize: fontSize, nodes: nodes, edges: edges)
  }

  /// Where the segment from `centre` towards `towards` leaves `rect`.
  static func rim(of rect: CGRect, from centre: CGPoint, towards: CGPoint) -> CGPoint {
    let dx = towards.x - centre.x
    let dy = towards.y - centre.y
    guard dx != 0 || dy != 0 else { return centre }
    let scaleX = dx == 0 ? CGFloat.infinity : (rect.width / 2) / abs(dx)
    let scaleY = dy == 0 ? CGFloat.infinity : (rect.height / 2) / abs(dy)
    let scale = min(scaleX, scaleY)
    return CGPoint(x: centre.x + dx * scale, y: centre.y + dy * scale)
  }
}

/// A pie as angles: slice shares in degrees, clockwise from twelve o'clock.
public struct MermaidPieArc: Sendable, Hashable {
  public var index: Int
  public var startDegrees: Double
  public var endDegrees: Double
  /// The slice's share of the whole, in percent, rounded.
  public var percent: Int
  /// The slice is the whole turn (an arc from an angle to itself draws nothing).
  public var isFull: Bool { endDegrees - startDegrees >= 359.9 }
}

extension MermaidPie {
  public var arcs: [MermaidPieArc] {
    let total = slices.reduce(0) { $0 + $1.value }
    guard total > 0 else { return [] }
    var from = 0.0
    return slices.enumerated().map { index, slice in
      let share = slice.value / total
      let arc = MermaidPieArc(index: index, startDegrees: from, endDegrees: from + share * 360, percent: Int((share * 100).rounded()))
      from += share * 360
      return arc
    }
  }
}
