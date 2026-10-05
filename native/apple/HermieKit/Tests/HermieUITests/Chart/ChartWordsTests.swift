import Foundation
import HermieMarkdown
import Testing

@testable import HermieUI

/// The words of a `hermie-chart` block: in the catalogue in three languages, and what the labels the app hands the
/// Markdown target say.
@MainActor
@Suite("Chart block: the words")
struct ChartWordsTests {
  @Test(arguments: [
    "native.chart.category", "native.chart.value", "native.chart.series", "native.chart.copySource",
    "native.chart.copy", "native.chart.copied", "native.chart.showSource", "native.chart.showChart",
    "native.chart.kind.bar", "native.chart.kind.line", "native.chart.kind.pie"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test func theEndOfALongSeriesIsAPluralInEveryLanguage() throws {
    try expectPluralForms("native.chart.summary.more")
    #expect(NativeStrings.Chart.summaryMore(28).contains("28"))
  }

  /// The same text in a language that borrows the punctuation.
  @Test(arguments: [
    "native.chart.summary.titled", "native.chart.summary.unit", "native.chart.summary.point",
    "native.chart.summary.series"
  ])
  func theSameWhereTheSentenceIsPunctuation(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl", "de"])
  }

  @Test func theNameSentencesKeepBothPlaceholdersInEveryLanguage() throws {
    for key in ["native.chart.summary.titled", "native.chart.summary.series", "native.chart.summary.point"] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%1$@") && text.contains("%2$@"), "\(key) in \(language)")
      }
    }
  }

  @Test func theLabelsTheAppHandsTheMarkdownTargetComeFromTheCatalogue() {
    let labels = MarkdownChartLabels.localized
    let spec = HermieChartSpec(
      kind: .bar, title: "Sales", unit: "EUR", x: ["Q1", "Q2"],
      series: [HermieChartSeries(name: "2026", values: [12, 15.5])])

    for kind in HermieChartKind.allCases {
      #expect(!labels.kindName(kind).isEmpty && !labels.kindName(kind).hasPrefix("native."))
    }

    #expect(Set(HermieChartKind.allCases.map(labels.kindName)).count == 3)
    #expect(
      !labels.category.hasPrefix("native.") && !labels.value.hasPrefix("native.") && !labels.series.hasPrefix("native."))

    let spoken = labels.summary(spec)
    #expect(spoken.contains("Sales") && spoken.contains("EUR") && spoken.contains("2026"))
    #expect(spoken.contains("Q1") && spoken.contains("15.5"))
    #expect(!spoken.contains("native."))
    #expect(!labels.code.copy.hasPrefix("native.") && !labels.code.showSource.hasPrefix("native."))
  }
}
