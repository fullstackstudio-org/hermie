import Foundation
import HermieMarkdown
import SwiftUI

/// The words of a `hermie-chart` block, from `Resources/Native.xcstrings` (`native.chart.*`). The Markdown
/// target owns no string catalog, so it takes them through its environment (`markdownChartLabels`).
extension NativeStrings {
  enum Chart {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Category (what a screen reader calls the horizontal axis and a pie's slices)
    static var category: String { string("native.chart.category") }
    /// Value
    static var value: String { string("native.chart.value") }
    /// Series
    static var series: String { string("native.chart.series") }
    /// Copy chart data
    static var copySource: String { string("native.chart.copySource") }
    /// Copy
    static var copy: String { string("native.chart.copy") }
    /// Copied
    static var copied: String { string("native.chart.copied") }
    /// Show chart data
    static var showSource: String { string("native.chart.showSource") }
    /// Show chart
    static var showChart: String { string("native.chart.showChart") }

    /// Bar chart / Line chart / Pie chart
    static func kind(_ kind: HermieChartKind) -> String {
      switch kind {
      case .bar: string("native.chart.kind.bar")
      case .line: string("native.chart.kind.line")
      case .pie: string("native.chart.kind.pie")
      }
    }

    /// {kind}, {title}.
    static func summaryTitled(_ kind: String, _ title: String) -> String {
      String(
        localized: "native.chart.summary.titled", defaultValue: "\(kind), \(title).", table: "Native", bundle: .module)
    }
    /// In {unit}.
    static func summaryUnit(_ unit: String) -> String {
      String(localized: "native.chart.summary.unit", defaultValue: "In \(unit).", table: "Native", bundle: .module)
    }
    /// {label} {value}
    static func summaryPoint(_ label: String, _ value: String) -> String {
      String(
        localized: "native.chart.summary.point", defaultValue: "\(label) \(value)", table: "Native", bundle: .module)
    }
    /// {series}: {points}.
    static func summarySeries(_ name: String, _ points: String) -> String {
      String(
        localized: "native.chart.summary.series", defaultValue: "\(name): \(points).", table: "Native",
        bundle: .module)
    }
    /// and {count} more
    static func summaryMore(_ count: Int) -> String {
      String(
        localized: "native.chart.summary.more", defaultValue: "and \(count) more", table: "Native", bundle: .module)
    }
  }
}

extension MarkdownChartLabels {
  /// The labels in the reader's language. Read when a chart is drawn (a view's body), never at import: a
  /// language switch has to reach the next chart.
  @MainActor static var localized: MarkdownChartLabels {
    MarkdownChartLabels(
      category: NativeStrings.Chart.category,
      value: NativeStrings.Chart.value,
      series: NativeStrings.Chart.series,
      kindName: { NativeStrings.Chart.kind($0) },
      summary: { spec in
        HermieChartSpeech.summary(
          spec,
          words: HermieChartSpeech.Words(
            kind: { NativeStrings.Chart.kind($0) },
            titled: { NativeStrings.Chart.summaryTitled($0, $1) },
            unit: { NativeStrings.Chart.summaryUnit($0) },
            point: { NativeStrings.Chart.summaryPoint($0, $1) },
            series: { NativeStrings.Chart.summarySeries($0, $1) },
            more: { NativeStrings.Chart.summaryMore($0) }
          ))
      },
      copySource: NativeStrings.Chart.copySource,
      code: MarkdownCodeStrings(
        copy: NativeStrings.Chart.copy, copied: NativeStrings.Chart.copied,
        showSource: NativeStrings.Chart.showSource, showRendered: NativeStrings.Chart.showChart)
    )
  }
}

extension View {
  /// A reply drawn with the words of a chart block in the reader's language.
  @MainActor func markdownChartWords() -> some View {
    environment(\.markdownChartLabels, .localized)
  }
}
