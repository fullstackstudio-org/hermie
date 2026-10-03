import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// The table's geometry, measured from the cells' own frames: every header
/// cell spans its whole column (the header band has no gaps), header and body
/// share their column widths, and each column's alignment holds in the header
/// and the body alike.
@MainActor
@Suite struct MarkdownTableLayoutTests {
  /// The owner's table from the 0.2.2 feedback: short headers over wider body
  /// columns, which left the header band as short boxes with gaps.
  static let receipts = """
    | Purchase | VAT | Source |
    |---|---|---|
    | MacBook Pro | € 876,27 | Coolblue 99681268 (entry 50) |
    | iPhone 17 Pro Max | € 223,71 | Media Markt receipt 1890796, € 1.289,00 incl. / € 1.065,29 excl. |
    | **Total** | **€ 1.227,19** | |
    """

  static let emptyHeader = """
    | | Now | Without these four |
    |---|--:|--:|
    | 5a, owed | € 1.011,96 | € 1.011,96 |
    """

  static let alignments = """
    | L | C | R | D |
    |:---|:---:|---:|---|
    | a | b | c | d |
    | a much longer cell | a much longer cell | a much longer cell | a much longer cell |
    """

  @MainActor final class Frames {
    var cells: [Key: CGRect] = [:]
    var contents: [Key: CGRect] = [:]

    struct Key: Hashable {
      var row: Int
      var column: Int
    }

    func cell(_ row: Int, _ column: Int) -> CGRect? { cells[Key(row: row, column: column)] }
    func content(_ row: Int, _ column: Int) -> CGRect? { contents[Key(row: row, column: column)] }
  }

  /// Lays the table out at `width` and returns the frames its cells reported.
  func frames(_ markdown: String, width: CGFloat, dynamicType: DynamicTypeSize = .large) throws -> (Frames, MarkdownTable) {
    let document = MarkdownDocument(markdown)
    guard case .table(let table) = try #require(document.blocks.first).kind else {
      Issue.record("not a table")
      throw CancellationError()
    }
    let frames = Frames()
    let view = MarkdownTableView(table: table)
      .environment(\.dynamicTypeSize, dynamicType)
      .environment(\.markdownTableCellFrames, MarkdownTableCellFrameSink { reported in
        let key = Frames.Key(row: reported.row, column: reported.column)
        switch reported.part {
        case .cell: frames.cells[key] = reported.frame
        case .content: frames.contents[key] = reported.frame
        }
      })
      .frame(width: width)
    #if os(macOS)
      let host = NSHostingView(rootView: view)
      host.frame = CGRect(x: 0, y: 0, width: width, height: 2000)
      let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
      window.contentView = host
      for _ in 0..<5 {
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
      }
    #else
      let host = UIHostingController(rootView: view)
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 2000))
      window.rootViewController = host
      window.isHidden = false
      for _ in 0..<5 {
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
      }
    #endif
    _ = window
    let count = (table.rows.count + 1) * table.header.count
    #expect(frames.cells.count == count, "\(frames.cells.count) of \(count) cells reported")
    return (frames, table)
  }

  static let tolerance: CGFloat = 0.5

  func same(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) <= Self.tolerance }

  /// The header band is one strip: the header cells touch, start at the
  /// table's edge, are all the row's height, and each is exactly as wide as
  /// its column's body cells.
  func expectHeaderSpansColumns(_ frames: Frames, _ table: MarkdownTable, _ name: String) throws {
    let columns = table.header.count
    let headers = try (0..<columns).map { try #require(frames.cell(-1, $0), "\(name): header \($0)") }
    #expect(same(headers[0].minX, 0), "\(name): header starts at \(headers[0].minX)")
    for column in 0..<columns {
      let header = headers[column]
      if column > 0 {
        #expect(same(headers[column - 1].maxX, header.minX), "\(name): gap before header \(column)")
        #expect(same(headers[column - 1].height, header.height), "\(name): header \(column) is not the row's height")
      }
      for row in table.rows.indices {
        let body = try #require(frames.cell(row, column))
        #expect(same(body.minX, header.minX), "\(name): column \(column) row \(row) starts at \(body.minX), header at \(header.minX)")
        #expect(same(body.width, header.width), "\(name): column \(column) row \(row) is \(body.width) wide, header \(header.width)")
      }
      // The column is as wide as its widest content, and the header fills it.
      let widest = try (-1..<table.rows.count).map { try #require(frames.content($0, column)).width }.max() ?? 0
      #expect(same(header.width, widest), "\(name): header \(column) is \(header.width), column content \(widest)")
    }
  }

  @Test func headerCellsSpanTheirColumns() throws {
    let (frames, table) = try frames(Self.receipts, width: 1200)
    try expectHeaderSpansColumns(frames, table, "receipts")
    // The short "VAT" header is narrower than its column's amounts, and still
    // fills the column.
    let vatText = try #require(frames.content(-1, 1))
    let vatCell = try #require(frames.cell(-1, 1))
    #expect(vatText.width < vatCell.width - 1)
  }

  @Test func anEmptyHeaderCellStillFillsItsColumn() throws {
    let (frames, table) = try frames(Self.emptyHeader, width: 1200)
    try expectHeaderSpansColumns(frames, table, "empty header")
    let empty = try #require(frames.cell(-1, 0))
    let body = try #require(frames.cell(0, 0))
    #expect(same(empty.width, body.width))
    #expect(empty.height > 0)
  }

  @Test(arguments: [DynamicTypeSize.large, .accessibility3])
  func alignmentHoldsInHeaderAndBody(dynamicType: DynamicTypeSize) throws {
    let (frames, table) = try frames(Self.alignments, width: 1600, dynamicType: dynamicType)
    try expectHeaderSpansColumns(frames, table, "alignments")
    for row in -1..<table.rows.count {
      for column in 0..<4 {
        let cell = try #require(frames.cell(row, column))
        let content = try #require(frames.content(row, column))
        let at = "row \(row) column \(column): content \(content) in \(cell)"
        switch column {
        case 0, 3: #expect(same(content.minX, cell.minX), "leading, \(at)")
        case 1: #expect(same(content.midX, cell.midX), "centre, \(at)")
        default: #expect(same(content.maxX, cell.maxX), "trailing, \(at)")
        }
      }
    }
    // The short cells really are narrower than their columns, so the checks
    // above tell the alignments apart.
    for column in 0..<4 {
      let short = try #require(frames.content(0, column))
      let cell = try #require(frames.cell(0, column))
      #expect(short.width < cell.width - 10)
    }
  }

  /// At an iPhone's width a table that does not fit wraps its long cells (the
  /// header band still unbroken) instead of growing a column past the screen.
  @Test(arguments: [DynamicTypeSize.large, .accessibility3])
  func aNarrowTableWrapsLongCells(dynamicType: DynamicTypeSize) throws {
    let (frames, table) = try frames(Self.receipts, width: 340, dynamicType: dynamicType)
    try expectHeaderSpansColumns(frames, table, "receipts at 340")
    let long = try #require(frames.content(1, 2))
    let single = try #require(frames.content(0, 2))
    #expect(long.height > single.height + 1, "the long source wraps: \(long) vs \(single)")
  }

  /// A five-column table at an iPhone's width keeps its band whole whether it
  /// fits or scrolls.
  @Test func aWideTableKeepsItsHeaderBand() throws {
    let wide = """
      | Registrar | Domain | Renews | Autorenew | Nameservers |
      |:--|:-:|--:|---|---|
      | Registrar One | docs.example.org | 2026-10-04 | off | ns1.example.net |
      """
    let (frames, table) = try frames(wide, width: 340)
    try expectHeaderSpansColumns(frames, table, "five columns at 340")
  }
}
