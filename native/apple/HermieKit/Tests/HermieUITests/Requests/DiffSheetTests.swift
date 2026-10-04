import Foundation
import HermieCore
import HermieGateway
import HermieProtocol
import SwiftUI
import Testing

@testable import HermieUI

private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// The contract's example diff with this request id, read the way the app reads a frame.
private func diff(_ id: String) throws -> ReviewDiff {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  let frames = try #require(root["methods"]?["review.diff"]?["frames"]?.arrayValue)
  let match = try #require(frames.first { $0["id"]?.stringValue == id }, "\(id)")
  let params = ReviewDiffParams(json: try #require(match["params"]?.objectValue))

  switch ReviewDiff.read(params) {
  case .success(let diff): return diff
  case .failure(let problem):
    Issue.record("refused: \(problem)")
    throw problem
  }
}

/// What the diff sheet and the confirmation's fields draw, as values a test can read: where a hunk
/// lands, how a line and a tab look and sound, and how a field kind is drawn. (The sheets themselves
/// are not driven by UI tests.)
@MainActor
@Suite("Diff sheet and confirm fields")
struct DiffSheetTests {
  // MARK: Where a hunk lands

  @Test("a pinned hunk says where: start, end or whole file; one without a pin shows its header and says nothing")
  func placeLabels() throws {
    typealias Words = NativeStrings.Interactive.Diff

    let start = DiffHunkPlace(hunk: try diff("req_diff_rename").hunks[0])
    #expect(start.label == Words.anchorStart && Words.anchorStart == "Start of the file")
    #expect(start.detail == "@@ -1,3 +1,3 @@", "the numbers of a start-pinned hunk stay: they are 0 or 1")

    let end = DiffHunkPlace(hunk: try diff("req_diff_append").hunks[0])
    #expect(end.label == Words.anchorEnd && Words.anchorEnd == "End of the file")

    let whole = DiffHunkPlace(hunk: try diff("req_diff_new_file").hunks[0])
    #expect(whole.label == Words.anchorBoth && Words.anchorBoth == "Whole file")
    #expect(whole.detail == "@@ -0,0 +1,2 @@")

    let plain = DiffHunkPlace(hunk: try diff("req_diff_settings").hunks[0])
    #expect(plain.label == nil, "no pin, no claim")
    #expect(plain.detail == "@@ -3,4 +3,4 @@ class Settings:", "its header as it is")
  }

  @Test("for the end of the file the header's line numbers are not shown as the place the change lands")
  func endHidesTheNumbers() throws {
    let append = try diff("req_diff_append").hunks[0]
    #expect(append.header == "@@ -3,1 +3,2 @@", "the frame says line 3")
    #expect(DiffHunkPlace.detail(for: append) == nil, "and the sheet does not")

    // With a section the sheet shows the section, never the numbers in front of it.
    var params = ReviewDiffParams(json: [
      "v": 1, "kind": "modify", "path": "a.go",
      "hunks": [["id": "h1", "header": "@@ -2,1 +2,2 @@ func tail() {", "lines": [" x", "+y"], "anchor": "end"]]
    ])
    params.sessionID = "s"
    guard case .success(let withSection) = ReviewDiff.read(params) else {
      Issue.record("refused")
      return
    }

    let shown = DiffHunkPlace.detail(for: withSection.hunks[0])
    #expect(shown == "func tail() {")
    #expect(shown?.contains("-2") == false && shown?.contains("+2") == false && shown?.contains("@@") == false)
  }

  @Test("a rename draws the old path and the new one as separate left-to-right isolates, so right-to-left paths cannot swap sides")
  func renamePathsAreIsolated() throws {
    let hebrew = "\u{05E9}\u{05DC}\u{05D5}\u{05DD}/\u{05E7}\u{05D5}\u{05D1}\u{05E5}.txt"
    let arabic = "\u{0645}\u{0644}\u{0641}/\u{0646}\u{0635}.txt"
    let old = DiffFileHeader.isolated(DraftText.reveal(hebrew))
    let new = DiffFileHeader.isolated(DraftText.reveal(arabic))

    for text in [old, new] {
      #expect(text.hasPrefix("\u{2066}") && text.hasSuffix("\u{2069}"), "an LTR isolate")
    }

    #expect(old.dropFirst().dropLast() == hebrew[...] && new.dropFirst().dropLast() == arabic[...], "the path itself, unchanged")
    #expect(old != new)

    // The header holds the two as two views: there is no single string with both paths.
    guard case .success(let diff) = ReviewDiff.read(
      ReviewDiffParams(json: [
        "v": 1, "kind": "rename", "path": .string(arabic), "old_path": .string(hebrew),
        "hunks": [["id": "h1", "header": "@@ -1,2 +1,2 @@", "lines": [" a", "-b", "+B"], "anchor": "both"]]
      ]))
    else {
      Issue.record("refused")
      return
    }

    #expect(diff.oldPath == hebrew && diff.path == arabic)
    let rendered = ImageRenderer(content: DiffFileHeader(diff: diff).frame(width: 320).padding())
    #expect((try #require(rendered.cgImage)).height > 0)
  }

  // MARK: Lines

  @Test("added and removed lines differ by their marker and a band, not by colour alone; the note has its own marker")
  func markers() {
    typealias Lines = DiffLinesView
    #expect(Lines.symbol(.added) == "+" && Lines.symbol(.removed) == "\u{2212}" && Lines.symbol(.context) == " ")
    #expect(Lines.symbol(.noNewline) == "\\")
    #expect(Lines.symbol(.added) != Lines.symbol(.removed))
    #expect(Lines.tint(.added) != Lines.tint(.removed))
    #expect(Lines.tint(.context) == .clear)
  }

  @Test("a tab is drawn as a marker and the spaces to its stop, in the text VoiceOver reads too as a word")
  func tabs() {
    #expect(String(DiffLinesView.attributed("\tx").characters) == "\u{2192}       x")
    #expect(String(DiffLinesView.attributed("ab\tc").characters) == "ab\u{2192}     c")
    #expect(String(DiffLinesView.attributed("plain").characters) == "plain")
    #expect(String(DiffLinesView.attributed("").characters) == "")

    let line = ReviewDiff.Line(mark: .added, text: "\t\tfmt.Println(i)")
    let spoken = DiffLinesView.spoken(line)
    #expect(spoken == "Added:  tab  tab fmt.Println(i)", "each tab is named, never silent")
  }

  @Test("VoiceOver reads what happened to a line, an empty line and git's note")
  func spoken() {
    #expect(DiffLinesView.spoken(.init(mark: .removed, text: "x = 1")) == "Removed: x = 1")
    #expect(DiffLinesView.spoken(.init(mark: .context, text: "y")) == "Unchanged: y")
    #expect(DiffLinesView.spoken(.init(mark: .context, text: "")) == "Unchanged: empty line")
    #expect(DiffLinesView.spoken(.init(mark: .noNewline, text: "\\ No newline at end of file")) == "No newline at end of file")
  }

  // MARK: Fields

  @Test("an amount is the value large and bold with its currency beside it, as given; a field kind decides only the style")
  func fieldStyles() {
    typealias Row = ConfirmFieldRow
    #expect(Row.Style.of(.amount) == .amount)
    #expect(Row.Style.of(.recipient) == .monospaced && Row.Style.of(.domain) == .monospaced)
    for kind in [ConfirmFieldKind.text, .model, .count, .date] {
      #expect(Row.Style.of(kind) == .plain, "\(kind)")
    }
    #expect(ConfirmFieldKind.allCases.count == 7, "a kind added to the contract needs a style decided")

    let cost = ConfirmField(id: "cost", kind: .amount, label: "Estimated cost", value: "4,20", currency: "€")
    #expect(Row.amountParts(cost).value == "4,20", "the value is never parsed, rounded or localised")
    #expect(Row.amountParts(cost).currency == "€")
    #expect(Row.spoken(cost) == "4,20 €")
    let bare = ConfirmField(id: "x", kind: .amount, label: "L", value: "1.00")
    #expect(Row.amountParts(bare).value == "1.00" && Row.amountParts(bare).currency == nil)
    #expect(Row.spoken(bare) == "1.00")
    #expect(Row.spoken(ConfirmField(id: "t", kind: .text, label: "L", value: "v")) == "v")
  }

  @Test("an amount's value and currency are separate texts: a right-to-left currency cannot reorder the value")
  func amountIsSeparate() {
    let field = ConfirmField(id: "cost", kind: .amount, label: "L", value: "-4.20", currency: "\u{0631}.\u{0633}")
    let parts = ConfirmFieldRow.amountParts(field)
    #expect(parts.value == "-4.20", "the sign and the digits are a text of their own")
    #expect(parts.currency == "\u{0631}.\u{0633}")
    #expect(!parts.value.contains(parts.currency ?? "?"))

    // As given, markdown and links included: nothing is read.
    let markup = ConfirmField(id: "cost", kind: .amount, label: "L", value: "**4**[x](https://evil.example)", currency: "EUR")
    #expect(ConfirmFieldRow.amountParts(markup).value == "**4**[x](https://evil.example)")
  }

  @Test("the fields count as seen once both their ends have been in view, and stay seen")
  func fieldsReview() {
    var review = ConfirmFieldsReview()
    let frame = CGRect(x: 0, y: 100, width: 300, height: 400)
    #expect(!review.complete)

    // A window below the fields sees nothing; one that shows their top sees the top only.
    review.see(frame: frame, window: CGRect(x: 0, y: 600, width: 300, height: 300))
    #expect(!review.topSeen && !review.bottomSeen)
    review.see(frame: frame, window: CGRect(x: 0, y: 0, width: 300, height: 300))
    #expect(review.topSeen && !review.bottomSeen && !review.complete)

    // Scrolled on until the bottom shows: complete, though the frame never fitted the window.
    review.see(frame: frame, window: CGRect(x: 0, y: 300, width: 300, height: 300))
    #expect(review.complete)
    review.see(frame: frame, window: CGRect(x: 0, y: 900, width: 300, height: 300))
    #expect(review.complete, "it stays")

    // An unmeasured frame or window counts for nothing.
    var fresh = ConfirmFieldsReview()
    fresh.see(frame: .zero, window: CGRect(x: 0, y: 0, width: 300, height: 300))
    fresh.see(frame: frame, window: .zero)
    #expect(!fresh.topSeen && !fresh.bottomSeen)

    // A short block that fits is complete at once.
    var short = ConfirmFieldsReview()
    short.see(frame: CGRect(x: 0, y: 10, width: 300, height: 80), window: CGRect(x: 0, y: 0, width: 300, height: 300))
    #expect(short.complete)
  }

  // MARK: The views draw

  @Test("a hunk card and the fields draw at the default size and at AX5, narrow, with long and wide text")
  func render() throws {
    var wide = ReviewDiffParams(json: [
      "v": 1, "kind": "modify", "path": "a.go",
      "hunks": [
        [
          "id": "h1", "header": "@@ -10,3 +10,3 @@",
          "lines": [" a", .string("-" + String(repeating: "wide ", count: 89) + "wide"), .string("+\tkept\t" + String(repeating: "x", count: 300)), " c"]
        ]
      ]
    ])
    wide.sessionID = "s"
    guard case .success(let long) = ReviewDiff.read(wide) else {
      Issue.record("refused")
      return
    }

    let fields = [
      ConfirmField(id: "cost", kind: .amount, label: "Estimated cost", value: "4.20", currency: "€"),
      ConfirmField(id: "to", kind: .recipient, label: "To", value: String(repeating: "a", count: 190) + "@x.example"),
      ConfirmField(id: "model", kind: .model, label: "Model", value: "claude-opus-5-5")
    ]

    for size in [DynamicTypeSize.large, .accessibility5] {
      let card = DiffHunkCard(hunk: long.hunks[0], number: 1, total: 1, decision: nil, enabled: true) { _ in }
        .frame(width: 320)
        .padding()
        .dynamicTypeSize(size)
      let renderer = ImageRenderer(content: card)
      renderer.proposedSize = ProposedViewSize(width: 360, height: nil)
      #expect((try #require(renderer.cgImage, "the hunk did not render")).height > 0)

      let facts = ConfirmFieldsView(fields: fields)
        .frame(width: 320)
        .padding()
        .dynamicTypeSize(size)
      let factsRenderer = ImageRenderer(content: facts)
      factsRenderer.proposedSize = ProposedViewSize(width: 360, height: nil)
      #expect((try #require(factsRenderer.cgImage, "the fields did not render")).height > 0)
    }
  }
}
