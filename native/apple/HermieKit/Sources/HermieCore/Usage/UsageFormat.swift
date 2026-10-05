import Foundation

/// How use is written: tokens compactly, cost in dollars, in the reader's locale.
public enum UsageFormat {
  /// `12,345` as `12K`, `1,250,000` as `1.3M`: in the locale's own compact style, never more than three
  /// significant digits.
  public static func tokens(_ count: Int, locale: Locale = .current) -> String {
    count.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)).locale(locale))
  }

  /// A cost in US dollars: cents under ten, whole dollars above a thousand. The gateway prices in dollars
  /// whatever the reader's currency is.
  public static func cost(_ amount: Double, locale: Locale = .current) -> String {
    let value = amount.isFinite ? max(0, amount) : 0
    let digits = value >= 1000 ? 0 : 2

    return value.formatted(
      .currency(code: "USD").precision(.fractionLength(digits)).locale(locale))
  }

  /// A day key (`2026-10-05`) as a short date in the reader's locale: "5 Oct". The day is UTC, and so is
  /// the text, so it never shifts with the reader's time zone.
  public static func day(_ key: String, locale: Locale = .current) -> String {
    guard let date = UsageDays.date(forKey: key) else {
      return key
    }

    var style = Date.FormatStyle(timeZone: TimeZone(identifier: "UTC") ?? .gmt).locale(locale)

    style = style.day().month(.abbreviated)

    return date.formatted(style)
  }

  /// Whole per cent, `0.456` as `46%`.
  public static func percent(_ fraction: Double, locale: Locale = .current) -> String {
    let value = fraction.isFinite ? min(1, max(0, fraction)) : 0

    return value.formatted(.percent.precision(.fractionLength(0)).locale(locale))
  }
}
