import Foundation

// Mermaid, for the two diagram kinds that can be drawn natively without a web view or a third-party
// renderer: flowcharts (`flowchart` / `graph`) and pies. A port of the web and Expo clients' parsers
// (`packages/markdown/src/mermaid/parse.ts`, `pie.ts`) with their subset and their rule: anything else
// (a sequence diagram, a class diagram, a `subgraph`, a half-streamed fence) answers `nil`, and the
// caller shows the source in a labelled listing with Copy. A picture that quietly leaves out what the
// author asked for is worse than the source it was made from.
//
// Pure and total: no SwiftUI, never traps.

public enum MermaidDirection: Sendable, Hashable {
  case topDown, bottomUp, leftRight, rightLeft

  var isHorizontal: Bool { self == .leftRight || self == .rightLeft }
}

public enum MermaidShape: Sendable, Hashable {
  case rect, round, stadium, circle, rhombus, hexagon, subroutine
}

public enum MermaidStroke: Sendable, Hashable {
  case solid, dotted, thick
}

public struct MermaidNode: Sendable, Hashable {
  public var id: String
  public var label: String
  public var shape: MermaidShape
}

public struct MermaidEdge: Sendable, Hashable {
  public var from: String
  public var to: String
  public var stroke: MermaidStroke
  /// Whether the far end carries an arrowhead (`---` does not).
  public var arrow: Bool
  public var label: String?
}

public struct MermaidFlowchart: Sendable, Hashable {
  public var direction: MermaidDirection
  public var nodes: [MermaidNode]
  public var edges: [MermaidEdge]
}

public struct MermaidPieSlice: Sendable, Hashable {
  public var label: String
  public var value: Double
}

public struct MermaidPie: Sendable, Hashable {
  public var title: String?
  public var slices: [MermaidPieSlice]
}

public enum MermaidDiagram: Sendable, Hashable {
  case flowchart(MermaidFlowchart)
  case pie(MermaidPie)

  /// What a screen reader says for the picture: the diagram as sentences.
  public var summary: String {
    switch self {
    case .flowchart(let chart):
      let labels = Dictionary(uniqueKeysWithValues: chart.nodes.map { ($0.id, $0.label.replacingOccurrences(of: "\n", with: " ")) })
      let steps = chart.edges.map { edge -> String in
        let from = labels[edge.from] ?? edge.from
        let to = labels[edge.to] ?? edge.to
        let via = edge.label.map { ", \($0)," } ?? ""
        return "\(from)\(via) \(edge.arrow ? "to" : "linked with") \(to)"
      }
      return steps.joined(separator: "; ")
    case .pie(let pie):
      let total = pie.slices.reduce(0) { $0 + $1.value }
      let parts = pie.slices.map { slice -> String in
        let percent = total > 0 ? Int((slice.value / total * 100).rounded()) : 0
        return "\(slice.label) \(MermaidParser.format(slice.value)), \(percent) percent"
      }
      return (pie.title.map { "\($0): " } ?? "") + parts.joined(separator: "; ")
    }
  }
}

public enum MermaidParser {
  /// Past these a diagram is a data dump, not a picture, and stays source.
  static let maximumNodes = 60
  static let maximumEdges = 120
  static let maximumSource = 8000
  static let maximumSlices = 10
  static let maximumPieSource = 4000

  /// Stands for the `;` of an entity while a line is cut into statements.
  static let entityMark = "\u{E000}"

  /// The diagram a `mermaid` fence draws, or `nil` when it is outside what is drawn.
  public static func parse(_ source: String) -> MermaidDiagram? {
    if let chart = parseFlowchart(source) { return .flowchart(chart) }
    if let pie = parsePie(source) { return .pie(pie) }
    return nil
  }

  // MARK: Labels

  /// A label as the reader should see it: unquoted, `<br/>` a line break, three entities decoded.
  static func cleanLabel(_ raw: String?) -> String {
    guard let raw else { return "" }
    var text = raw.replacingOccurrences(of: entityMark, with: ";").jsTrimmed
    for quote in ["\"", "'"] where text.count >= 2 && text.hasPrefix(quote) && text.hasSuffix(quote) {
      text = String(text.dropFirst().dropLast())
      break
    }
    text = Patterns.lineBreak.replace(text, with: "\n")
    text = text.replacingOccurrences(of: "&quot;", with: "\"")
      .replacingOccurrences(of: "&amp;", with: "&")
      .replacingOccurrences(of: "&lt;", with: "<")
      .replacingOccurrences(of: "&gt;", with: ">")
    return text.jsTrimmed
  }

  /// The value of a pie slice as written: no decimals when it has none.
  static func format(_ value: Double) -> String {
    value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
  }

  enum Patterns {
    static let lineBreak = JSRegex(#"<br\s*/?>"#, caseInsensitive: true)
    static let comment = JSRegex(#"%%.*\z"#)
    static let header = JSRegex(#"^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*\z"#, caseInsensitive: true)
    static let unsupported = JSRegex(#"^(?:subgraph|end|style|classDef|class|click|linkStyle|direction)\b"#, caseInsensitive: true)
    static let node = JSRegex(
      #"^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:(\(\()(.*?)\)\)|(\[\[)(.*?)\]\]|(\(\[)(.*?)\]\)|(\{\{)(.*?)\}\}|(\[)(.*?)\]|(\()(.*?)\)|(\{)(.*?)\})?"#
    )
    static let pipeLabel = JSRegex(#"^\s*\|([^|\n]*)\|"#)

    struct Edge {
      var regex: JSRegex
      var stroke: MermaidStroke
      var arrow: Bool
      var labelGroup: Int?
    }

    /// Most specific first: `-.->` before `--`, and `--text-->` before `-->`.
    static let edges: [Edge] = [
      Edge(regex: JSRegex(#"^\s*-\.\s*([^.\n]+?)\s*\.->"#), stroke: .dotted, arrow: true, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*-\.\s*([^.\n]+?)\s*\.-"#), stroke: .dotted, arrow: false, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*-\.->"#), stroke: .dotted, arrow: true, labelGroup: nil),
      Edge(regex: JSRegex(#"^\s*-\.-"#), stroke: .dotted, arrow: false, labelGroup: nil),
      Edge(regex: JSRegex(#"^\s*==\s*([^=\n]+?)\s*==>"#), stroke: .thick, arrow: true, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*==\s*([^=\n]+?)\s*=="#), stroke: .thick, arrow: false, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*={2,}>"#), stroke: .thick, arrow: true, labelGroup: nil),
      Edge(regex: JSRegex(#"^\s*={3,}"#), stroke: .thick, arrow: false, labelGroup: nil),
      Edge(regex: JSRegex(#"^\s*--\s*([^->\n]+?)\s*-->"#), stroke: .solid, arrow: true, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*--\s*([^->\n]+?)\s*---"#), stroke: .solid, arrow: false, labelGroup: 1),
      Edge(regex: JSRegex(#"^\s*-{2,}>"#), stroke: .solid, arrow: true, labelGroup: nil),
      Edge(regex: JSRegex(#"^\s*-{3,}"#), stroke: .solid, arrow: false, labelGroup: nil)
    ]

    static let pieHeader = JSRegex(#"^pie(?:\s+showData)?(?:\s+title\s+(.*))?\z"#, caseInsensitive: true)
    static let pieTitle = JSRegex(#"^title\s+(.*)\z"#, caseInsensitive: true)
    static let pieSlice = JSRegex(#"^(.*?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\z"#)
  }

  /// The source's lines without comments or blanks.
  static func lines(of source: String) -> [String] {
    source.components(separatedBy: "\n")
      .map { Patterns.comment.replace($0, with: "").jsTrimmed }
      .filter { !$0.isEmpty }
  }

  // MARK: Flowchart

  private struct Builder {
    var nodes: [String: MermaidNode] = [:]
    var order: [String] = []
    var edges: [MermaidEdge] = []

    /// Records a node, keeping the label that is not merely an id: `A[Start] --> B` and a later
    /// `A --> C` are one node, and the second mention carries no label.
    mutating func node(_ id: String, label: String?, shape: MermaidShape) {
      let text = (label ?? "").isEmpty ? nil : label
      if var existing = nodes[id] {
        if let text {
          existing.label = text
          existing.shape = shape
          nodes[id] = existing
        }
        return
      }
      nodes[id] = MermaidNode(id: id, label: text ?? id, shape: shape)
      order.append(id)
    }
  }

  private static func shape(of match: JSRegex.Match) -> (label: String?, shape: MermaidShape) {
    let pairs: [(Int, MermaidShape)] = [
      (3, .circle), (5, .subroutine), (7, .stadium), (9, .hexagon), (11, .rect), (13, .round), (15, .rhombus)
    ]
    for (group, shape) in pairs where match.groups[group - 1] != nil {
      return (match.groups[group], shape)
    }
    return (nil, .rect)
  }

  private static func drop(_ count: Int, from text: String) -> String {
    (text as NSString).substring(from: count)
  }

  private static func parseStatement(_ statement: String, into builder: inout Builder) -> Bool {
    var rest = statement
    guard let first = Patterns.node.firstMatch(rest), let firstID = first[1] else { return false }
    var previous = firstID
    let firstShape = shape(of: first)
    builder.node(previous, label: cleanLabel(firstShape.label), shape: firstShape.shape)
    rest = drop(first.range.length, from: rest)

    while rest.hasNonSpace {
      guard let pattern = Patterns.edges.first(where: { $0.regex.test(rest) }), let edge = pattern.regex.firstMatch(rest) else {
        return false
      }
      rest = drop(edge.range.length, from: rest)

      var label = pattern.labelGroup.flatMap { edge[$0] }.map { cleanLabel($0) } ?? ""
      if let piped = Patterns.pipeLabel.firstMatch(rest) {
        label = cleanLabel(piped[1])
        rest = drop(piped.range.length, from: rest)
      }

      guard let target = Patterns.node.firstMatch(rest), let id = target[1] else { return false }
      let targetShape = shape(of: target)
      builder.node(id, label: cleanLabel(targetShape.label), shape: targetShape.shape)
      builder.edges.append(
        MermaidEdge(from: previous, to: id, stroke: pattern.stroke, arrow: pattern.arrow, label: label.isEmpty ? nil : label))
      previous = id
      rest = drop(target.range.length, from: rest)
    }
    return true
  }

  static func parseFlowchart(_ source: String) -> MermaidFlowchart? {
    guard !source.isEmpty, source.utf16.count <= maximumSource else { return nil }
    var lines = lines(of: source)
    guard !lines.isEmpty else { return nil }
    let header = lines.removeFirst()
    guard let match = Patterns.header.firstMatch(header) else { return nil }

    let declared = (match[1] ?? "TD").uppercased()
    let direction: MermaidDirection =
      switch declared {
      case "BT": .bottomUp
      case "LR": .leftRight
      case "RL": .rightLeft
      default: .topDown
      }

    var builder = Builder()
    for line in lines {
      if Patterns.unsupported.test(line) { return nil }
      // A `;` ends a statement, except the one that ends an entity (`&amp;` in a label).
      var guarded = line
      for entity in ["&amp;", "&lt;", "&gt;", "&quot;"] {
        guarded = guarded.replacingOccurrences(of: entity, with: String(entity.dropLast()) + entityMark)
      }
      for statement in guarded.split(separator: ";", omittingEmptySubsequences: true) {
        guard String(statement).hasNonSpace else { continue }
        if !parseStatement(String(statement), into: &builder) { return nil }
      }
    }

    guard !builder.nodes.isEmpty, builder.nodes.count <= maximumNodes, builder.edges.count <= maximumEdges else { return nil }
    // A single node with no edges is a box, not a diagram.
    guard !builder.edges.isEmpty else { return nil }
    return MermaidFlowchart(direction: direction, nodes: builder.order.compactMap { builder.nodes[$0] }, edges: builder.edges)
  }

  // MARK: Pie

  static func parsePie(_ source: String) -> MermaidPie? {
    guard !source.isEmpty, source.utf16.count <= maximumPieSource else { return nil }
    var lines = lines(of: source)
    guard !lines.isEmpty else { return nil }
    let header = lines.removeFirst()
    guard let match = Patterns.pieHeader.firstMatch(header) else { return nil }

    var title: String? = cleanLabel(match[1])
    if title?.isEmpty == true { title = nil }
    var slices: [MermaidPieSlice] = []

    for line in lines {
      if let titled = Patterns.pieTitle.firstMatch(line) {
        // A second title is a diagram that says two things.
        if title != nil || !slices.isEmpty { return nil }
        title = cleanLabel(titled[1])
        continue
      }
      guard let slice = Patterns.pieSlice.firstMatch(line), let value = slice[2].flatMap(Double.init), value.isFinite else {
        return nil
      }
      let label = cleanLabel(slice[1])
      guard !label.isEmpty else { return nil }
      slices.append(MermaidPieSlice(label: label, value: value))
    }

    guard !slices.isEmpty, slices.count <= maximumSlices, slices.reduce(0, { $0 + $1.value }) > 0 else { return nil }
    return MermaidPie(title: title?.isEmpty == true ? nil : title, slices: slices)
  }
}
