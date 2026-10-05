import Foundation

// `hermie-chart`: numbers a bot returns, drawn as a chart
// ========================================================
//
// A reply carries a chart as a fenced block whose language is `hermie-chart` and whose body is one JSON
// object. The format is documented in `docs/charts.md`, which is also what a bot's prompt can point to;
// this file is the validator for it, and the two are meant to be read together.
//
//     {"type": "bar", "title": "Sales", "unit": "EUR", "x": ["Q1", "Q2"],
//      "series": [{"name": "2026", "values": [12, 15]}]}
//
// The rule is the one the Mermaid blocks follow: a block that is not exactly what the format says is NOT
// drawn, and the caller shows it as the code block it is. A picture that quietly leaves out or bends what
// the author sent is worse than the source it was made from. So the validator is strict (unknown keys,
// strings where numbers belong, a series of the wrong length, a number that is not finite are all refusals)
// and bounded (a cap on the size of the block, the number of series and points, the length of every label),
// so a reply cannot make the app draw ten thousand marks.
//
// Pure and total: no SwiftUI, never traps. The renderer is `HermieChartView.swift`.

/// What kind of chart.
public enum HermieChartKind: String, Sendable, Hashable, CaseIterable {
  case bar
  case line
  case pie
}

/// One named row of numbers; `values[i]` belongs to `x[i]`.
public struct HermieChartSeries: Sendable, Hashable {
  public var name: String
  public var values: [Double]

  public init(name: String, values: [Double]) {
    self.name = name
    self.values = values
  }
}

/// A chart that passed validation. Every field is within the limits of `HermieChartLimits`.
public struct HermieChartSpec: Sendable, Hashable {
  public var kind: HermieChartKind
  public var title: String?
  /// What the numbers are counted in (`EUR`, `%`, `ms`): shown on the value axis and beside a value that
  /// is read aloud.
  public var unit: String?
  /// The categories, one per point; unique. For a pie, the slices.
  public var x: [String]
  /// One series for a pie; one or more for a bar or line chart.
  public var series: [HermieChartSeries]

  public init(
    kind: HermieChartKind, title: String? = nil, unit: String? = nil, x: [String], series: [HermieChartSeries]
  ) {
    self.kind = kind
    self.title = title
    self.unit = unit
    self.x = x
    self.series = series
  }

  /// The number of marks the chart draws.
  public var pointCount: Int { series.reduce(0) { $0 + $1.values.count } }
}

/// The caps. Generous for anything a person reads in a chat bubble, small enough that no block is a
/// cost: 8 series of 100 points is 800 marks and under 16 KB of JSON.
public enum HermieChartLimits {
  /// The block's text, in UTF-8 bytes. Checked before anything is parsed.
  public static let maxSourceBytes = 16 * 1024
  public static let maxSeries = 8
  /// Categories, which is to say points per series (slices, for a pie).
  public static let maxPoints = 100
  public static let maxSlices = 24
  public static let maxLabelLength = 60
  public static let maxTitleLength = 120
  public static let maxUnitLength = 12
  /// A value beyond this is a mistake or an attack, and would not draw anyway.
  public static let maxMagnitude = 1e15
}

/// Why a block is not a chart. Each case is one rule of the format, so a test can name the rule it breaks
/// and a reader of `docs/charts.md` can find it.
public enum HermieChartError: Error, Sendable, Hashable {
  case tooLarge
  case notJSON
  case notAnObject
  case unknownKey(String)
  case missing(String)
  case wrongType(String)
  case unknownType(String)
  case tooManySeries
  case tooManyPoints
  case noPoints
  case noSeries
  case labelTooLong(String)
  case emptyLabel(String)
  case duplicateLabel(String)
  case lengthMismatch(series: String)
  case notNumeric(series: String)
  case notFinite(series: String)
  case pieNeedsOneSeries
  case pieNeedsPositiveValues
}

/// What the markdown renderer does with a fenced block.
public enum HermieChartDecision: Sendable, Hashable {
  /// Draw this.
  case chart(HermieChartSpec)
  /// Show it as the code block it is: not a chart fence, or a chart fence that is not a valid chart.
  case code
}

public enum HermieChart {
  /// The fence's language.
  public static let fenceLanguage = "hermie-chart"

  /// Whether a fence's language names a chart block. Case does not matter: models capitalise.
  public static func isChartFence(language: String?) -> Bool {
    language?.lowercased() == fenceLanguage
  }

  /// The one decision the renderer makes: a chart when the fence is a chart fence and its body validates,
  /// the code block it came from otherwise.
  public static func decide(language: String?, source: String) -> HermieChartDecision {
    guard isChartFence(language: language), let spec = try? parse(source).get() else {
      return .code
    }

    return .chart(spec)
  }

  /// Validate a block's body.
  public static func parse(_ source: String) -> Result<HermieChartSpec, HermieChartError> {
    do {
      return .success(try validated(source))
    } catch let error as HermieChartError {
      return .failure(error)
    } catch {
      return .failure(.notJSON)
    }
  }

  // MARK: Validation

  private static let topLevelKeys: Set<String> = ["type", "title", "x", "series", "unit"]
  private static let seriesKeys: Set<String> = ["name", "values"]

  private static func validated(_ source: String) throws -> HermieChartSpec {
    guard source.utf8.count <= HermieChartLimits.maxSourceBytes else {
      throw HermieChartError.tooLarge
    }

    guard let data = source.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data, options: [])
    else {
      throw HermieChartError.notJSON
    }

    guard let object = parsed as? [String: Any] else {
      throw HermieChartError.notAnObject
    }

    if let unknown = object.keys.filter({ !topLevelKeys.contains($0) }).sorted().first {
      throw HermieChartError.unknownKey(unknown)
    }

    let kind = try kind(of: object)
    let title = try optionalLabel(object["title"], key: "title", limit: HermieChartLimits.maxTitleLength)
    let unit = try optionalLabel(object["unit"], key: "unit", limit: HermieChartLimits.maxUnitLength)
    let x = try categories(object["x"], kind: kind)
    let series = try seriesList(object["series"], kind: kind, points: x.count)

    return HermieChartSpec(kind: kind, title: title, unit: unit, x: x, series: series)
  }

  private static func kind(of object: [String: Any]) throws -> HermieChartKind {
    guard let raw = object["type"] else {
      throw HermieChartError.missing("type")
    }

    guard let name = raw as? String else {
      throw HermieChartError.wrongType("type")
    }

    guard let kind = HermieChartKind(rawValue: name) else {
      throw HermieChartError.unknownType(name)
    }

    return kind
  }

  /// A string label, trimmed. Absent or JSON `null` is no label; an empty one is no label too.
  private static func optionalLabel(_ value: Any?, key: String, limit: Int) throws -> String? {
    guard let value, !(value is NSNull) else {
      return nil
    }

    guard let text = value as? String else {
      throw HermieChartError.wrongType(key)
    }

    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard trimmed.count <= limit else {
      throw HermieChartError.labelTooLong(key)
    }

    return trimmed.isEmpty ? nil : trimmed
  }

  /// `x`: strings, or numbers (a year) that are written out as text. Every one non-empty, short, unique.
  private static func categories(_ value: Any?, kind: HermieChartKind) throws -> [String] {
    guard let value else {
      throw HermieChartError.missing("x")
    }

    guard let list = value as? [Any] else {
      throw HermieChartError.wrongType("x")
    }

    guard !list.isEmpty else {
      throw HermieChartError.noPoints
    }

    guard list.count <= (kind == .pie ? HermieChartLimits.maxSlices : HermieChartLimits.maxPoints) else {
      throw HermieChartError.tooManyPoints
    }

    var seen = Set<String>()
    var labels: [String] = []

    for item in list {
      let text: String

      if let string = item as? String {
        text = string.trimmingCharacters(in: .whitespacesAndNewlines)
      } else if let number = number(item) {
        text = format(number)
      } else {
        throw HermieChartError.wrongType("x")
      }

      guard !text.isEmpty else {
        throw HermieChartError.emptyLabel("x")
      }

      guard text.count <= HermieChartLimits.maxLabelLength else {
        throw HermieChartError.labelTooLong("x")
      }

      guard seen.insert(text).inserted else {
        throw HermieChartError.duplicateLabel(text)
      }

      labels.append(text)
    }

    return labels
  }

  private static func seriesList(_ value: Any?, kind: HermieChartKind, points: Int) throws -> [HermieChartSeries] {
    guard let value else {
      throw HermieChartError.missing("series")
    }

    guard let list = value as? [Any] else {
      throw HermieChartError.wrongType("series")
    }

    guard !list.isEmpty else {
      throw HermieChartError.noSeries
    }

    guard list.count <= HermieChartLimits.maxSeries else {
      throw HermieChartError.tooManySeries
    }

    if kind == .pie, list.count != 1 {
      throw HermieChartError.pieNeedsOneSeries
    }

    var names = Set<String>()
    var out: [HermieChartSeries] = []

    for item in list {
      guard let object = item as? [String: Any] else {
        throw HermieChartError.wrongType("series")
      }

      if let unknown = object.keys.filter({ !seriesKeys.contains($0) }).sorted().first {
        throw HermieChartError.unknownKey(unknown)
      }

      guard let rawName = object["name"] else {
        throw HermieChartError.missing("name")
      }

      guard let name = (rawName as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
        throw HermieChartError.wrongType("name")
      }

      guard !name.isEmpty else {
        throw HermieChartError.emptyLabel("name")
      }

      guard name.count <= HermieChartLimits.maxLabelLength else {
        throw HermieChartError.labelTooLong("name")
      }

      guard names.insert(name).inserted else {
        throw HermieChartError.duplicateLabel(name)
      }

      guard let rawValues = object["values"] else {
        throw HermieChartError.missing("values")
      }

      guard let list = rawValues as? [Any] else {
        throw HermieChartError.wrongType("values")
      }

      // Counted before any element is read: a long list of the wrong length is refused whole.
      guard list.count == points else {
        throw HermieChartError.lengthMismatch(series: name)
      }

      var values: [Double] = []

      for element in list {
        guard let number = number(element) else {
          throw HermieChartError.notNumeric(series: name)
        }

        guard number.isFinite, abs(number) <= HermieChartLimits.maxMagnitude else {
          throw HermieChartError.notFinite(series: name)
        }

        values.append(number)
      }

      if kind == .pie {
        guard values.allSatisfy({ $0 >= 0 }), values.contains(where: { $0 > 0 }) else {
          throw HermieChartError.pieNeedsPositiveValues
        }
      }

      out.append(HermieChartSeries(name: name, values: values))
    }

    return out
  }

  /// A JSON number as a `Double`: not a boolean (JSON `true` is an `NSNumber` too), not a string.
  private static func number(_ value: Any) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }

    return number.doubleValue
  }

  // MARK: Words

  /// A number as a short, locale-neutral label: whole numbers without a fraction, the rest with at most
  /// three digits.
  public static func format(_ value: Double) -> String {
    if value.rounded() == value, abs(value) < 1e15 {
      return String(Int64(value))
    }

    var text = String(format: "%.3f", value)

    while text.hasSuffix("0") { text.removeLast() }
    if text.hasSuffix(".") { text.removeLast() }

    return text
  }
}
