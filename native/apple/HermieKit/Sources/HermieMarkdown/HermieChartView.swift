import Charts
import SwiftUI

// The `hermie-chart` renderer: Swift Charts over a `HermieChartSpec` that already passed validation
// (`HermieChart.swift`). Nothing here decides whether a block is a chart.

/// The words of the buttons on a listing or a drawn block.
public struct MarkdownCodeStrings: Sendable {
  public var copy: String
  public var copied: String
  public var showSource: String
  public var showRendered: String

  public init(copy: String, copied: String, showSource: String, showRendered: String) {
    self.copy = copy
    self.copied = copied
    self.showSource = showSource
    self.showRendered = showRendered
  }

  public static let english = MarkdownCodeStrings(
    copy: MarkdownStrings.copy, copied: MarkdownStrings.copied, showSource: MarkdownStrings.showSource,
    showRendered: MarkdownStrings.showRendered)
}

/// Every word a chart block shows or speaks. English here; the app supplies its own language through
/// `EnvironmentValues.markdownChartLabels`, because this target owns no string catalog.
public struct MarkdownChartLabels: Sendable {
  /// What a screen reader calls the picture's axes and legend.
  public var category: String
  public var value: String
  public var series: String
  /// The name of each kind, which labels the block.
  public var kindName: @Sendable (HermieChartKind) -> String
  /// What a screen reader says for the whole chart: the kind, the title, the unit and the numbers.
  public var summary: @Sendable (HermieChartSpec) -> String
  /// Copy the block's JSON.
  public var copySource: String
  public var code: MarkdownCodeStrings

  public init(
    category: String,
    value: String,
    series: String,
    kindName: @escaping @Sendable (HermieChartKind) -> String,
    summary: @escaping @Sendable (HermieChartSpec) -> String,
    copySource: String,
    code: MarkdownCodeStrings
  ) {
    self.category = category
    self.value = value
    self.series = series
    self.kindName = kindName
    self.summary = summary
    self.copySource = copySource
    self.code = code
  }

  public static let english = MarkdownChartLabels(
    category: "Category",
    value: "Value",
    series: "Series",
    kindName: { englishKind($0) },
    summary: { spec in
      HermieChartSpeech.summary(
        spec,
        words: HermieChartSpeech.Words(
          kind: { englishKind($0) },
          titled: { kind, title in "\(kind), \(title)." },
          unit: { unit in "In \(unit)." },
          point: { label, value in "\(label) \(value)" },
          series: { name, points in "\(name): \(points)." },
          more: { count in "and \(count) more" }
        ))
    },
    copySource: MarkdownStrings.copySource,
    code: .english
  )
}

private func englishKind(_ kind: HermieChartKind) -> String {
  switch kind {
  case .bar: "Bar chart"
  case .line: "Line chart"
  case .pie: "Pie chart"
  }
}

extension EnvironmentValues {
  /// The words of a chart block. The default is English; the app's views set their own.
  @Entry public var markdownChartLabels = MarkdownChartLabels.english
}

/// What a chart is read as, with the fragments' wording supplied by the caller (so a language can order
/// the sentence its own way) and the numbers capped: a chart of 800 marks is not read out mark by mark.
public enum HermieChartSpeech {
  /// How many points of each series are read.
  public static let maxPointsRead = 12

  public struct Words: Sendable {
    public var kind: @Sendable (HermieChartKind) -> String
    /// "{kind}, {title}."
    public var titled: @Sendable (String, String) -> String
    /// "In {unit}."
    public var unit: @Sendable (String) -> String
    /// "{label} {value}"
    public var point: @Sendable (String, String) -> String
    /// "{series}: {points}."
    public var series: @Sendable (String, String) -> String
    /// "and {n} more"
    public var more: @Sendable (Int) -> String

    public init(
      kind: @escaping @Sendable (HermieChartKind) -> String,
      titled: @escaping @Sendable (String, String) -> String,
      unit: @escaping @Sendable (String) -> String,
      point: @escaping @Sendable (String, String) -> String,
      series: @escaping @Sendable (String, String) -> String,
      more: @escaping @Sendable (Int) -> String
    ) {
      self.kind = kind
      self.titled = titled
      self.unit = unit
      self.point = point
      self.series = series
      self.more = more
    }
  }

  public static func summary(_ spec: HermieChartSpec, words: Words) -> String {
    var parts: [String] = []
    let kind = words.kind(spec.kind)

    parts.append(spec.title.map { words.titled(kind, $0) } ?? kind)

    if let unit = spec.unit {
      parts.append(words.unit(unit))
    }

    for series in spec.series {
      var points = zip(spec.x, series.values).prefix(maxPointsRead).map {
        words.point($0, HermieChart.format($1))
      }

      if series.values.count > maxPointsRead {
        points.append(words.more(series.values.count - maxPointsRead))
      }

      parts.append(words.series(series.name, points.joined(separator: ", ")))
    }

    return parts.joined(separator: " ")
  }
}

/// A chart block: the picture with its title, under the label and buttons of a listing, so Copy copies
/// the JSON and the eye toggles to it.
struct MarkdownChartBlock: View {
  let spec: HermieChartSpec
  let source: String

  @Environment(\.markdownChartLabels) private var labels

  var body: some View {
    MarkdownCodeView(
      label: labels.kindName(spec.kind), accessibilityLabel: labels.kindName(spec.kind),
      copyLabel: labels.copySource, source: source, rendered: AnyView(HermieChartView(spec: spec)),
      spoken: labels.summary(spec), fillsRendered: true, strings: labels.code)
  }
}

/// The picture. Colours are the system chart palette, so they follow the appearance; the height is fixed
/// because a chart has no intrinsic one, and the width is the column's.
struct HermieChartView: View {
  let spec: HermieChartSpec

  @Environment(\.markdownChartLabels) private var labels
  @ScaledMetric(relativeTo: .body) private var height: CGFloat = 220

  /// One mark: a value of one series at one category.
  private struct Mark: Identifiable {
    var id: String
    var x: String
    var series: String
    var value: Double
  }

  private var marks: [Mark] {
    spec.series.enumerated().flatMap { seriesIndex, series in
      zip(spec.x, series.values).enumerated().map { pointIndex, point in
        Mark(id: "\(seriesIndex).\(pointIndex)", x: point.0, series: series.name, value: point.1)
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let title = spec.title {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .accessibilityAddTraits(.isHeader)
      }

      chart
        .frame(height: spec.kind == .pie ? height * 1.1 : height)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var chart: some View {
    switch spec.kind {
    case .bar:
      axes(
        Chart(marks) { mark in
          BarMark(x: .value(labels.category, mark.x), y: .value(labels.value, mark.value))
            .foregroundStyle(by: .value(labels.series, mark.series))
            .position(by: .value(labels.series, mark.series))
        })
    case .line:
      axes(
        Chart(marks) { mark in
          LineMark(x: .value(labels.category, mark.x), y: .value(labels.value, mark.value))
            .foregroundStyle(by: .value(labels.series, mark.series))
            .symbol(by: .value(labels.series, mark.series))
        })
    case .pie:
      Chart(marks) { mark in
        SectorMark(angle: .value(labels.value, mark.value), innerRadius: .ratio(0.55), angularInset: 1.5)
          .cornerRadius(3)
          .foregroundStyle(by: .value(labels.category, mark.x))
      }
    }
  }

  /// The axes and legend of a bar or line chart: the unit on the value axis, a label on every category
  /// when there are few and on every n-th when there are many, a legend only when it tells series apart.
  private func axes<Content: View>(_ chart: Content) -> some View {
    let stride = max(1, Int((Double(spec.x.count) / 8).rounded(.up)))
    let shown = spec.x.enumerated().filter { $0.offset % stride == 0 }.map(\.element)

    return chart
      .chartXAxis {
        AxisMarks(values: shown) { _ in
          AxisGridLine()
          AxisTick()
          AxisValueLabel()
        }
      }
      .chartYAxisLabel(spec.unit ?? "", alignment: .trailing)
      .chartLegend(spec.series.count > 1 ? .visible : .hidden)
  }
}
