import Foundation
import SwiftUI
import Testing

@testable import HermieMarkdown

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// `hermie-chart`: which fenced blocks are charts (the validator), what the renderer does with each (the
/// decision), and that a drawn chart lays out. The format is `docs/charts.md`.
@Suite("hermie-chart: the block format") struct HermieChartTests {
  private static let bar =
    #"{"type":"bar","title":"Sales per quarter","unit":"EUR","x":["Q1","Q2","Q3"],"series":[{"name":"2026","values":[12,15.5,9]}]}"#

  private func spec(_ source: String) throws -> HermieChartSpec {
    try HermieChart.parse(source).get()
  }

  private func error(_ source: String) -> HermieChartError? {
    if case .failure(let error) = HermieChart.parse(source) { return error }
    return nil
  }

  // MARK: Valid

  @Test func aBarChartWithOneSeries() throws {
    let chart = try spec(Self.bar)

    #expect(chart.kind == .bar)
    #expect(chart.title == "Sales per quarter")
    #expect(chart.unit == "EUR")
    #expect(chart.x == ["Q1", "Q2", "Q3"])
    #expect(chart.series == [HermieChartSeries(name: "2026", values: [12, 15.5, 9])])
    #expect(chart.pointCount == 3)
  }

  @Test func aLineChartWithSeveralSeriesAndNumericCategories() throws {
    let chart = try spec(
      #"{"type":"line","x":[2024,2025,2026.5],"series":[{"name":"a","values":[1,2,3]},{"name":"b","values":[-1,0,1e3]}]}"#)

    #expect(chart.kind == .line)
    #expect(chart.title == nil && chart.unit == nil)
    #expect(chart.x == ["2024", "2025", "2026.5"], "a number is written out as its label")
    #expect(chart.series.map(\.name) == ["a", "b"])
    #expect(chart.series[1].values == [-1, 0, 1000], "negative values and exponents are numbers")
  }

  @Test func aPieIsOneSeriesOfNonNegativeValues() throws {
    let chart = try spec(#"{"type":"pie","x":["a","b","c"],"series":[{"name":"share","values":[3,0,1]}]}"#)

    #expect(chart.kind == .pie)
    #expect(chart.series[0].values == [3, 0, 1])
  }

  @Test func labelsAreTrimmedAndNullOrEmptyTitleAndUnitAreNone() throws {
    let chart = try spec(
      #"{"type":"bar","title":"  ","unit":null,"x":[" a "],"series":[{"name":" s ","values":[1]}]}"#)

    #expect(chart.title == nil && chart.unit == nil)
    #expect(chart.x == ["a"] && chart.series[0].name == "s")
  }

  // MARK: Refused: the shape

  @Test func whatIsNotJSONOrNotAnObject() {
    #expect(error("") == .notJSON)
    #expect(error("not json") == .notJSON)
    #expect(error(#"{"type":"bar""#) == .notJSON, "half a block, as while it streams")
    #expect(error("[1,2,3]") == .notAnObject)
    #expect(error("42") != nil)
  }

  @Test func theTypeIsRequiredAndKnown() {
    #expect(error(#"{"x":["a"],"series":[{"name":"s","values":[1]}]}"#) == .missing("type"))
    #expect(error(#"{"type":3,"x":["a"],"series":[{"name":"s","values":[1]}]}"#) == .wrongType("type"))
    #expect(error(#"{"type":"radar","x":["a"],"series":[{"name":"s","values":[1]}]}"#) == .unknownType("radar"))
  }

  @Test func anUnknownKeyIsRefusedAtBothLevels() {
    #expect(
      error(#"{"type":"bar","subtitle":"x","x":["a"],"series":[{"name":"s","values":[1]}]}"#) == .unknownKey("subtitle"))
    #expect(
      error(#"{"type":"bar","x":["a"],"series":[{"name":"s","values":[1],"color":"red"}]}"#) == .unknownKey("color"))
  }

  @Test func theCategoriesAndSeriesAreRequired() {
    #expect(error(#"{"type":"bar","series":[{"name":"s","values":[1]}]}"#) == .missing("x"))
    #expect(error(#"{"type":"bar","x":"abc","series":[{"name":"s","values":[1]}]}"#) == .wrongType("x"))
    #expect(error(#"{"type":"bar","x":[],"series":[{"name":"s","values":[]}]}"#) == .noPoints)
    #expect(error(#"{"type":"bar","x":["a"]}"#) == .missing("series"))
    #expect(error(#"{"type":"bar","x":["a"],"series":[]}"#) == .noSeries)
    #expect(error(#"{"type":"bar","x":["a"],"series":[{"values":[1]}]}"#) == .missing("name"))
    #expect(error(#"{"type":"bar","x":["a"],"series":[{"name":"s"}]}"#) == .missing("values"))
    #expect(error(#"{"type":"bar","x":["a"],"series":["s"]}"#) == .wrongType("series"))
  }

  // MARK: Refused: the numbers

  @Test func nonNumericValuesAreRefused() {
    func values(_ list: String) -> HermieChartError? {
      error(#"{"type":"bar","x":["a","b"],"series":[{"name":"s","values":\#(list)}]}"#)
    }

    #expect(values(#"[1,"2"]"#) == .notNumeric(series: "s"), "a string is not a number")
    #expect(values("[1,true]") == .notNumeric(series: "s"), "a boolean is not a number")
    #expect(values("[1,null]") == .notNumeric(series: "s"), "a gap is not a number")
    #expect(values("[1,[2]]") == .notNumeric(series: "s"))
    #expect(values("[1,{}]") == .notNumeric(series: "s"))
  }

  @Test func aSeriesOfTheWrongLengthIsRefused() {
    #expect(
      error(#"{"type":"bar","x":["a","b"],"series":[{"name":"s","values":[1]}]}"#) == .lengthMismatch(series: "s"))
    #expect(
      error(#"{"type":"bar","x":["a"],"series":[{"name":"s","values":[1,2]}]}"#) == .lengthMismatch(series: "s"))
  }

  @Test func aNumberThatIsNotFiniteOrFarTooBigIsRefused() {
    func one(_ value: String) -> HermieChartError? {
      error(#"{"type":"bar","x":["a"],"series":[{"name":"s","values":[\#(value)]}]}"#)
    }

    #expect(one("1e999") != nil, "overflow is not a value")
    #expect(one("NaN") != nil && one("Infinity") != nil, "JSON has neither")
    #expect(one("1e16") == .notFinite(series: "s"))
    #expect(one("-1e16") == .notFinite(series: "s"))
    #expect(one("1e15") == nil, "the cap itself is fine")
  }

  @Test func aPieNeedsOneSeriesOfPositiveShares() {
    #expect(
      error(#"{"type":"pie","x":["a"],"series":[{"name":"s","values":[1]},{"name":"t","values":[1]}]}"#)
        == .pieNeedsOneSeries)
    #expect(
      error(#"{"type":"pie","x":["a","b"],"series":[{"name":"s","values":[1,-1]}]}"#) == .pieNeedsPositiveValues)
    #expect(
      error(#"{"type":"pie","x":["a","b"],"series":[{"name":"s","values":[0,0]}]}"#) == .pieNeedsPositiveValues)
  }

  // MARK: Refused: the labels

  @Test func labelsMustBeShortNonEmptyAndUnique() {
    let long = String(repeating: "a", count: HermieChartLimits.maxLabelLength + 1)
    let title = String(repeating: "t", count: HermieChartLimits.maxTitleLength + 1)
    let unit = String(repeating: "u", count: HermieChartLimits.maxUnitLength + 1)

    #expect(error(#"{"type":"bar","x":["\#(long)"],"series":[{"name":"s","values":[1]}]}"#) == .labelTooLong("x"))
    #expect(error(#"{"type":"bar","x":["a"],"series":[{"name":"\#(long)","values":[1]}]}"#) == .labelTooLong("name"))
    #expect(
      error(#"{"type":"bar","title":"\#(title)","x":["a"],"series":[{"name":"s","values":[1]}]}"#)
        == .labelTooLong("title"))
    #expect(
      error(#"{"type":"bar","unit":"\#(unit)","x":["a"],"series":[{"name":"s","values":[1]}]}"#)
        == .labelTooLong("unit"))
    #expect(error(#"{"type":"bar","x":[" "],"series":[{"name":"s","values":[1]}]}"#) == .emptyLabel("x"))
    #expect(error(#"{"type":"bar","x":["a"],"series":[{"name":"","values":[1]}]}"#) == .emptyLabel("name"))
    #expect(
      error(#"{"type":"bar","x":["a","a"],"series":[{"name":"s","values":[1,2]}]}"#) == .duplicateLabel("a"))
    #expect(
      error(#"{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]},{"name":"s","values":[2]}]}"#)
        == .duplicateLabel("s"))
    #expect(error(#"{"type":"bar","x":[true],"series":[{"name":"s","values":[1]}]}"#) == .wrongType("x"))
    #expect(error(#"{"type":"bar","title":5,"x":["a"],"series":[{"name":"s","values":[1]}]}"#) == .wrongType("title"))
  }

  // MARK: The caps

  private func big(points: Int, series: Int, kind: String = "bar") -> String {
    let x = (0..<points).map { "\"p\($0)\"" }.joined(separator: ",")
    let values = (0..<points).map { String($0) }.joined(separator: ",")
    let list = (0..<series).map { "{\"name\":\"s\($0)\",\"values\":[\(values)]}" }.joined(separator: ",")

    return "{\"type\":\"\(kind)\",\"x\":[\(x)],\"series\":[\(list)]}"
  }

  @Test func theCapsAreTheEdgeNotOneShort() throws {
    #expect(try spec(big(points: HermieChartLimits.maxPoints, series: 1)).pointCount == HermieChartLimits.maxPoints)
    #expect(try spec(big(points: 3, series: HermieChartLimits.maxSeries)).series.count == HermieChartLimits.maxSeries)
    #expect(
      try spec(big(points: HermieChartLimits.maxSlices, series: 1, kind: "pie")).x.count == HermieChartLimits.maxSlices)

    #expect(error(big(points: HermieChartLimits.maxPoints + 1, series: 1)) == .tooManyPoints)
    #expect(error(big(points: 3, series: HermieChartLimits.maxSeries + 1)) == .tooManySeries)
    #expect(error(big(points: HermieChartLimits.maxSlices + 1, series: 1, kind: "pie")) == .tooManyPoints)
  }

  @Test func aHugeBlockIsRefusedBeforeItIsParsed() {
    let padding = String(repeating: " ", count: HermieChartLimits.maxSourceBytes)

    #expect(error(Self.bar + padding) == .tooLarge)
    #expect(error(String(repeating: "[", count: 1_000_000)) == .tooLarge)
    #expect(error(String(repeating: "x", count: 5_000_000)) == .tooLarge)
  }

  @Test func theSizeIsCountedInBytesNotCharacters() {
    // Four bytes each: a block under the cap in characters and over it in bytes.
    let text = String(repeating: "\u{1F600}", count: HermieChartLimits.maxSourceBytes / 4 + 1)

    #expect(text.count < HermieChartLimits.maxSourceBytes)
    #expect(error(text) == .tooLarge)
  }

  @Test func deepNestingIsRefusedNotFollowed() {
    let deep = String(repeating: "[", count: 5_000) + String(repeating: "]", count: 5_000)

    #expect(error(deep) != nil)

    let nested =
      #"{"type":"bar","x":["a"],"series":[{"name":"s","values":["#
      + String(repeating: "[", count: 3_000) + String(repeating: "]", count: 3_000) + "]}]}"

    #expect(error(nested) != nil)
  }

  // MARK: The decision

  @Test func aValidChartFenceIsDrawn() throws {
    #expect(HermieChart.decide(language: "hermie-chart", source: Self.bar) == .chart(try spec(Self.bar)))
    #expect(
      HermieChart.decide(language: "Hermie-Chart", source: Self.bar) == .chart(try spec(Self.bar)),
      "case does not matter")
  }

  @Test func everythingElseStaysACodeBlock() {
    #expect(HermieChart.decide(language: "json", source: Self.bar) == .code, "the same JSON in another fence")
    #expect(HermieChart.decide(language: nil, source: Self.bar) == .code)
    #expect(HermieChart.decide(language: "hermie-chart", source: "{}") == .code, "a chart fence that is not a chart")
    #expect(HermieChart.decide(language: "hermie-chart", source: "") == .code)
    #expect(
      HermieChart.decide(language: "hermie-chart", source: String(Self.bar.dropLast())) == .code, "while it streams")
    #expect(HermieChart.decide(language: "hermie-chart-2", source: Self.bar) == .code)
    #expect(HermieChart.decide(language: "mermaid", source: Self.bar) == .code)
  }

  @Test func theParsedDocumentCarriesTheFenceForTheRendererToDecide() throws {
    let text =
      "Here it is:\n\n```hermie-chart\n\(Self.bar)\n```\n\nAnd not a chart:\n\n```hermie-chart\nhello\n```\n"
    let codes = MarkdownDocument(text).blocks.compactMap { block -> MarkdownCodeBlock? in
      if case .code(let code) = block.kind { return code }
      return nil
    }

    #expect(codes.count == 2)
    #expect(HermieChart.decide(language: codes[0].language, source: codes[0].text) == .chart(try spec(Self.bar)))
    #expect(HermieChart.decide(language: codes[1].language, source: codes[1].text) == .code)
  }

  @Test func theFenceLanguageIsThePublishedOne() {
    #expect(HermieChart.fenceLanguage == "hermie-chart")
    #expect(HermieChart.isChartFence(language: "hermie-chart"))
    #expect(!HermieChart.isChartFence(language: "chart"))
    #expect(!HermieChart.isChartFence(language: nil))
  }

  // MARK: Words

  @Test func theNumbersAreWrittenShort() {
    #expect(HermieChart.format(12) == "12")
    #expect(HermieChart.format(-3) == "-3")
    #expect(HermieChart.format(15.5) == "15.5")
    #expect(HermieChart.format(0.1234567) == "0.123")
    #expect(HermieChart.format(2.0001) == "2")
    #expect(HermieChart.format(1e15) == "1000000000000000")
  }

  @Test func aScreenReaderIsToldTheNumbersButNotAllOfThem() throws {
    let text = MarkdownChartLabels.english.summary(try spec(Self.bar))

    #expect(text == "Bar chart, Sales per quarter. In EUR. 2026: Q1 12, Q2 15.5, Q3 9.")

    let long = try spec(big(points: 40, series: 1))
    let spoken = MarkdownChartLabels.english.summary(long)

    #expect(spoken.contains("p0 0") && spoken.contains("p11 11") && !spoken.contains("p12 "))
    #expect(spoken.contains("and 28 more"))
  }
}

/// A drawn chart builds, lays out in a narrow column at the largest text size, and renders; an invalid one is
/// the listing it was.
@MainActor
@Suite("hermie-chart: drawn") struct HermieChartRenderingTests {
  private func render(_ view: some View, width: CGFloat) -> (size: CGSize, image: CGImage?) {
    let sized = view.frame(width: width)
    let fit = CGSize(width: width, height: .greatestFiniteMagnitude)
    #if os(macOS)
      let size = NSHostingController(rootView: sized).sizeThatFits(in: fit)
    #else
      let size = UIHostingController(rootView: sized).sizeThatFits(in: fit)
    #endif
    let renderer = ImageRenderer(content: sized)
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)

    return (size, renderer.cgImage)
  }

  @Test(arguments: [HermieChartKind.bar, .line, .pie])
  func everyKindLaysOutInANarrowColumn(kind: HermieChartKind) throws {
    let spec = HermieChartSpec(
      kind: kind, title: "Title", unit: "EUR", x: ["Q1", "Q2", "Q3"],
      series: kind == .pie
        ? [HermieChartSeries(name: "s", values: [1, 2, 3])]
        : [HermieChartSeries(name: "a", values: [1, 2, 3]), HermieChartSeries(name: "b", values: [3, 2, 1])])
    let result = render(
      MarkdownChartBlock(spec: spec, source: "{}").environment(\.dynamicTypeSize, .accessibility5), width: 320)

    #expect(result.size.width <= 320.5, "\(kind) is \(result.size.width) wide")
    #expect(result.size.height > 100, "\(kind) has a height of its own")
    #expect(result.image != nil)
  }

  @Test func aChartOfTheMostMarksAllowedStillLaysOut() throws {
    let x = (0..<HermieChartLimits.maxPoints).map { "p\($0)" }
    let series = (0..<HermieChartLimits.maxSeries).map { index in
      HermieChartSeries(name: "s\(index)", values: x.indices.map { Double($0 * (index + 1)) })
    }
    let spec = HermieChartSpec(kind: .line, x: x, series: series)
    let result = render(MarkdownChartBlock(spec: spec, source: "{}"), width: 320)

    #expect(result.size.width <= 320.5)
    #expect(result.image != nil)
  }

  @Test func theBlockViewDrawsAValidChartAndTheListingOtherwise() throws {
    func height(_ text: String) -> CGFloat {
      render(MarkdownView(MarkdownDocument(text)), width: 320).size.height
    }

    let valid = "```hermie-chart\n{\"type\":\"bar\",\"x\":[\"a\",\"b\"],\"series\":[{\"name\":\"s\",\"values\":[1,2]}]}\n```"
    let invalid = "```hermie-chart\n{\"type\":\"bar\",\"x\":[\"a\",\"b\"],\"series\":[{\"name\":\"s\",\"values\":[1]}]}\n```"

    #expect(height(valid) > 180, "the picture is about 220 tall")
    #expect(height(invalid) < 120, "a one-line listing")
  }
}
