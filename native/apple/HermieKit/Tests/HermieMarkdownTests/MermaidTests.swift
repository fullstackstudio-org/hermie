import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Mermaid: which fences are drawn (flowcharts and pies), how they are laid out, and that everything
/// else stays source.
@Suite struct MermaidTests {
  func chart(_ source: String) -> MermaidFlowchart? {
    if case .flowchart(let chart)? = MermaidParser.parse(source) { return chart }
    return nil
  }

  // MARK: Parsing flowcharts

  @Test func nodesShapesAndEdges() throws {
    let parsed = try #require(
      chart(
        """
        flowchart LR
          A[Start] --> B{Ready?}
          B -->|yes| C((Go))
          B -- no --> D([Wait]) --> A
          E[[Sub]] -.-> F{{Hex}}
          F ==> G(Round)
          G --- A
        """))
    #expect(parsed.direction == .leftRight)
    let byID = Dictionary(uniqueKeysWithValues: parsed.nodes.map { ($0.id, $0) })
    #expect(byID["A"]?.label == "Start" && byID["A"]?.shape == .rect)
    #expect(byID["B"]?.shape == .rhombus && byID["B"]?.label == "Ready?")
    #expect(byID["C"]?.shape == .circle)
    #expect(byID["D"]?.shape == .stadium)
    #expect(byID["E"]?.shape == .subroutine)
    #expect(byID["F"]?.shape == .hexagon)
    #expect(byID["G"]?.shape == .round)
    #expect(parsed.nodes.map(\.id) == ["A", "B", "C", "D", "E", "F", "G"], "in the order they were mentioned")

    #expect(parsed.edges.count == 7)
    #expect(parsed.edges[1].label == "yes")
    #expect(parsed.edges[2].label == "no" && parsed.edges[2].from == "B" && parsed.edges[2].to == "D")
    #expect(parsed.edges[3] == MermaidEdge(from: "D", to: "A", stroke: .solid, arrow: true, label: nil))
    #expect(parsed.edges[4].stroke == .dotted && parsed.edges[4].arrow)
    #expect(parsed.edges[5].stroke == .thick)
    #expect(parsed.edges[6].arrow == false)
  }

  @Test func theFirstLabelOfANodeSticks() throws {
    let parsed = try #require(chart("graph TD\nA[Start] --> B\nA --> C"))
    #expect(parsed.nodes.first { $0.id == "A" }?.label == "Start")
    #expect(parsed.nodes.first { $0.id == "B" }?.label == "B")
  }

  @Test func directionsAndHeaders() throws {
    #expect(chart("graph\nA --> B")?.direction == .topDown)
    #expect(chart("graph TB\nA --> B")?.direction == .topDown)
    #expect(chart("flowchart BT\nA --> B")?.direction == .bottomUp)
    #expect(chart("FLOWCHART rl\nA --> B")?.direction == .rightLeft)
  }

  @Test func labelsAreCleaned() throws {
    let parsed = try #require(chart("graph TD\nA[\"Hello<br/>world &amp; co\"] --> B"))
    #expect(parsed.nodes[0].label == "Hello\nworld & co")
  }

  @Test func commentsAndSemicolonsAreStatements() throws {
    let parsed = try #require(chart("graph TD %% a comment\nA --> B; B --> C %% another"))
    #expect(parsed.edges.count == 2)
  }

  @Test func whatIsOutsideTheSubsetStaysSource() {
    #expect(MermaidParser.parse("sequenceDiagram\nA->>B: hi") == nil)
    #expect(MermaidParser.parse("classDiagram\nA <|-- B") == nil)
    #expect(MermaidParser.parse("gantt\ntitle x") == nil)
    #expect(MermaidParser.parse("graph TD\nsubgraph one\nA --> B\nend") == nil)
    #expect(MermaidParser.parse("graph TD\nA --> B\nstyle A fill:#f9f") == nil)
    #expect(MermaidParser.parse("graph TD\nA") == nil, "one node is a box, not a diagram")
    #expect(MermaidParser.parse("graph TD\nA -->") == nil, "half arrived")
    #expect(MermaidParser.parse("graph TD\nA --> B -x") == nil)
    #expect(MermaidParser.parse("") == nil)
    #expect(MermaidParser.parse("graph TD") == nil)
  }

  @Test func aDataDumpIsNotADiagram() {
    let big = "graph TD\n" + (0..<70).map { "N\($0) --> N\($0 + 1)" }.joined(separator: "\n")
    #expect(MermaidParser.parse(big) == nil)
  }

  // MARK: Pies

  @Test func aPie() throws {
    guard case .pie(let pie)? = MermaidParser.parse("pie showData title Pets\n  \"Dogs\" : 386\n  \"Cats: indoor\" : 85.5\n  Rats : 15") else {
      Issue.record("not a pie")
      return
    }
    #expect(pie.title == "Pets")
    #expect(pie.slices.map(\.label) == ["Dogs", "Cats: indoor", "Rats"])
    #expect(pie.slices.map(\.value) == [386, 85.5, 15])
  }

  @Test func aTitleLineOfItsOwn() throws {
    guard case .pie(let pie)? = MermaidParser.parse("pie\ntitle Where\n\"a\" : 1\n\"b\" : 3") else {
      Issue.record("not a pie")
      return
    }
    #expect(pie.title == "Where")
    #expect(pie.arcs.map(\.percent) == [25, 75])
  }

  @Test func theArcsAddUpToATurn() throws {
    guard case .pie(let pie)? = MermaidParser.parse("pie\n\"a\" : 1\n\"b\" : 1\n\"c\" : 1") else {
      Issue.record("not a pie")
      return
    }
    let arcs = pie.arcs
    #expect(arcs.first?.startDegrees == 0)
    #expect(abs((arcs.last?.endDegrees ?? 0) - 360) < 1e-9)
    for (a, b) in zip(arcs, arcs.dropFirst()) { #expect(a.endDegrees == b.startDegrees) }
    #expect(arcs.map(\.percent) == [33, 33, 33])
    #expect(arcs.allSatisfy { !$0.isFull })
    guard case .pie(let one)? = MermaidParser.parse("pie\n\"only\" : 5") else { return }
    #expect(one.arcs.first?.isFull == true)
  }

  @Test func piesThatHaveNoCircleStaySource() {
    #expect(MermaidParser.parse("pie\n\"a\" : 0") == nil)
    #expect(MermaidParser.parse("pie\n\"a\" : -3") == nil)
    #expect(MermaidParser.parse("pie\n\"a\" : x") == nil)
    #expect(MermaidParser.parse("pie\n\"a\" : 1\n\"b\"") == nil, "a row still arriving")
    #expect(MermaidParser.parse("pie\n") == nil)
    let many = "pie\n" + (0..<11).map { "\"s\($0)\" : 1" }.joined(separator: "\n")
    #expect(MermaidParser.parse(many) == nil)
  }

  @Test func theSummaryReadsAsSentences() throws {
    let flow = try #require(MermaidParser.parse("graph TD\nA[Start] --> B{Ready?}\nB -->|yes| C[Go]"))
    #expect(flow.summary == "Start to Ready?; Ready?, yes, to Go")
    let pie = try #require(MermaidParser.parse("pie title Pets\n\"Dogs\" : 3\n\"Cats\" : 1"))
    #expect(pie.summary == "Pets: Dogs 3, 75 percent; Cats 1, 25 percent")
  }

  // MARK: Layout

  func layout(_ source: String, body: CGFloat = 17) throws -> MermaidFlowLayout {
    MermaidLayout.layout(try #require(chart(source)), bodyFontSize: body)
  }

  @Test func ranksFollowTheLongestPath() throws {
    let parsed = try #require(chart("graph TD\nA --> B\nB --> C\nA --> C\nA --> D"))
    let ranks = MermaidLayout.ranks(of: parsed)
    #expect(ranks == ["A": 0, "B": 1, "C": 2, "D": 1])
  }

  @Test func aCycleSettles() throws {
    let parsed = try #require(chart("graph TD\nA --> B\nB --> C\nC --> A"))
    let ranks = MermaidLayout.ranks(of: parsed)
    #expect(ranks.keys.count == 3)
    let layout = MermaidLayout.layout(parsed, bodyFontSize: 17)
    #expect(layout.nodes.count == 3 && layout.edges.count == 3)
  }

  @Test func topDownStacksRanksVertically() throws {
    let l = try layout("graph TD\nA --> B\nA --> C\nB --> D")
    let y = Dictionary(uniqueKeysWithValues: l.nodes.map { ($0.node.id, $0.rect.minY) })
    #expect(y["A"]! < y["B"]! && y["B"]! < y["D"]!)
    #expect(y["B"] == y["C"] || abs(y["B"]! - y["C"]!) < 30, "siblings share a rank")
    #expect(l.nodes.first { $0.node.id == "B" }!.rect.minX != l.nodes.first { $0.node.id == "C" }!.rect.minX)
  }

  @Test func leftRightIsTheSameLayoutOnTheOtherAxis() throws {
    let td = try layout("graph TD\nA --> B --> C")
    let lr = try layout("graph LR\nA --> B --> C")
    #expect(lr.size.width > lr.size.height)
    #expect(td.size.height > td.size.width)
    let x = lr.nodes.map(\.rect.minX)
    #expect(x == x.sorted())
  }

  @Test func reversedDirectionsMirrorTheForwardOnes() throws {
    let forward = try layout("graph TD\nA --> B --> C")
    let reversed = try layout("graph BT\nA --> B --> C")
    #expect(forward.size == reversed.size)
    #expect(reversed.nodes[0].rect.minY > reversed.nodes[2].rect.minY)
    let back = try layout("graph RL\nA --> B --> C")
    #expect(back.nodes[0].rect.minX > back.nodes[2].rect.minX)
  }

  @Test func everyBoxIsInsideTheDrawing() throws {
    let sources = [
      "graph TD\nA[A rather long label that has to wrap onto several lines] --> B{Decide?}\nB -->|yes| C((x))\nB -->|no| D\nC --> E\nD --> E",
      "graph LR\nA --> B\nA --> C\nA --> D\nA --> E\nA --> F"
    ]
    for source in sources {
      let l = try layout(source)
      for node in l.nodes {
        #expect(node.rect.minX >= 0 && node.rect.minY >= 0, "\(node.node.id)")
        #expect(node.rect.maxX <= l.size.width && node.rect.maxY <= l.size.height, "\(node.node.id)")
        #expect(node.rect.width <= MermaidLayout.maximumWidth + 8 + 16)
      }
      // No two boxes overlap.
      for (i, a) in l.nodes.enumerated() {
        for b in l.nodes[(i + 1)...] { #expect(!a.rect.intersects(b.rect), "\(a.node.id) \(b.node.id)") }
      }
    }
  }

  @Test func longLabelsWrapAndWordsAreNeverCut() {
    let lines = MermaidLayout.wrap("a rather long label that wraps", fontSize: 14, maxTextWidth: 100)
    #expect(lines.count > 1)
    #expect(lines.joined(separator: " ") == "a rather long label that wraps")
    #expect(MermaidLayout.wrap("/very/long/path/that/is/one/word", fontSize: 14, maxTextWidth: 50) == ["/very/long/path/that/is/one/word"])
    #expect(MermaidLayout.wrap("one\ntwo", fontSize: 14, maxTextWidth: 500) == ["one", "two"])
  }

  @Test func theLayoutIsDeterministicAndScalesWithTheFont() throws {
    let source = "graph TD\nA[Alpha] --> B[Beta]"
    #expect(try layout(source) == layout(source))
    #expect(try layout(source, body: 30).size.height > layout(source, body: 17).size.height)
    #expect(MermaidLayout.diagramFontSize(body: 17) == 14)
    #expect(MermaidLayout.diagramFontSize(body: 8) == 10)
  }

  @Test func edgesStartAndEndOnTheRims() throws {
    let l = try layout("graph TD\nA --> B")
    let edge = l.edges[0]
    let a = l.nodes[0].rect
    let b = l.nodes[1].rect
    #expect(abs(edge.start.y - a.maxY) < 0.001 && abs(edge.end.y - b.minY) < 0.001)
  }

  // MARK: Drawn

  @MainActor
  @Test func drawnDiagramsGetARealSize() throws {
    for source in ["graph TD\nA[Start] --> B{Ready?}\nB -->|yes| C[Go]", "pie title Pets\n\"Dogs\" : 3\n\"Cats\" : 1"] {
      let diagram = try #require(MermaidParser.parse(source))
      let view = MermaidDiagramView(diagram: diagram)
      #if os(macOS)
        let host = NSHostingController(rootView: view)
      #else
        let host = UIHostingController(rootView: view)
      #endif
      let size = host.sizeThatFits(in: CGSize(width: 2000, height: CGFloat.greatestFiniteMagnitude))
      #expect(size.width > 50 && size.height > 50 && size.height < 1000, "\(size)")
    }
  }
}
