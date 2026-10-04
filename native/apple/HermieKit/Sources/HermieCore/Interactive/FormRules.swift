import Foundation
import HermieProtocol

// The rules of an `input.form` field (`contract/requests/README.md` §4) on the client's side:
// reading what the person typed, answering whether it is a value of the field, and building the
// value the answer carries. They are the gateway's own checks, in the order of its table, so a
// problem is shown next to the input before the answer goes out. The gateway still decides: a
// refusal it sends is shown the same way (`InteractiveFormModel.noteRefusal`).

/// Why an entry is not (yet) a value of its field, by the names the gateway refuses with
/// (`field:<id>:<problem>`).
public enum FormProblem: Sendable, Equatable, Hashable {
  case missing
  case type
  case format
  case tooLong
  case zone
  case offset
  case order
  case notAnOption
  case duplicate
  case belowMin
  case aboveMax
  case notInteger
  case step
  case tooFew
  case tooMany
  /// A problem this build has no words for (a later contract addition), by its wire name.
  case other(String)

  public init(wire: String) {
    switch wire {
    case "missing": self = .missing
    case "type": self = .type
    case "format": self = .format
    case "too_long": self = .tooLong
    case "zone": self = .zone
    case "offset": self = .offset
    case "order": self = .order
    case "not_an_option": self = .notAnOption
    case "duplicate": self = .duplicate
    case "below_min": self = .belowMin
    case "above_max": self = .aboveMax
    case "not_integer": self = .notInteger
    case "step": self = .step
    case "too_few": self = .tooFew
    case "too_many": self = .tooMany
    default: self = .other(wire)
    }
  }

  public var wire: String {
    switch self {
    case .missing: "missing"
    case .type: "type"
    case .format: "format"
    case .tooLong: "too_long"
    case .zone: "zone"
    case .offset: "offset"
    case .order: "order"
    case .notAnOption: "not_an_option"
    case .duplicate: "duplicate"
    case .belowMin: "below_min"
    case .aboveMax: "above_max"
    case .notInteger: "not_integer"
    case .step: "step"
    case .tooFew: "too_few"
    case .tooMany: "too_many"
    case .other(let wire): wire
    }
  }
}

/// A refusal of the gateway that names a field: `field:<id>:<problem>`.
public struct FormRefusal: Sendable, Equatable {
  public var fieldID: String
  public var problem: FormProblem

  /// `nil` for a reason that does not name a field (`bad_shape`, `not_optional`, ...).
  public init?(reason: String) {
    let parts = reason.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)

    guard parts.count == 3, parts[0] == "field", !parts[1].isEmpty, !parts[2].isEmpty else {
      return nil
    }

    fieldID = String(parts[1])
    problem = FormProblem(wire: String(parts[2]))
  }
}

/// What the person has put in one field, by the kind of control that holds it. Typed text stays
/// text until the answer is built, so a half-typed number is not lost to a parse.
public enum FormInput: Sendable, Equatable {
  /// `text`: as typed.
  case text(String)
  /// `number`: as typed.
  case number(String)
  /// `amount`: as typed.
  case amount(String)
  /// `date`: `YYYY-MM-DD`; `nil` until chosen.
  case date(String?)
  /// `time`: `HH:MM`; `nil` until chosen.
  case time(String?)
  /// `datetime`: the instant; `nil` until chosen.
  case datetime(Date?)
  /// `daterange`: both ends `YYYY-MM-DD`; `nil` until chosen.
  case range(start: String?, end: String?)
  /// A single `choice`: the option's value; `nil` until chosen.
  case choice(String?)
  /// A `choice` with `multiple`: the chosen option values.
  case choices([String])
  /// `toggle`.
  case toggle(Bool)
}

// MARK: - Dates and times

/// Calendar days and times of day in one zone (a field's `tz`, else the device's), as the contract
/// writes them: `YYYY-MM-DD` and `HH:MM`, always on the Gregorian calendar.
public struct FormClock: Sendable {
  public let zone: TimeZone

  public init(zone: TimeZone) {
    self.zone = zone
  }

  /// The zone a field's answer is in: its `tz`, the device's when it names none or one this device
  /// does not know.
  public static func zone(named name: String?, device: TimeZone = .current) -> TimeZone {
    guard let name, !name.isEmpty, let zone = TimeZone(identifier: name) else {
      return device
    }

    return zone
  }

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    calendar.locale = Locale(identifier: "en_US_POSIX")
    return calendar
  }

  /// `[year, month, day]` of a strictly written `YYYY-MM-DD` that is a real calendar date.
  static func dayParts(_ text: String) -> [Int]? {
    let pieces = text.split(separator: "-", omittingEmptySubsequences: false)

    guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
      pieces.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
      let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2])
    else {
      return nil
    }

    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? .gmt
    let components = DateComponents(year: year, month: month, day: day)

    guard let date = utc.date(from: components) else {
      return nil
    }

    let back = utc.dateComponents([.year, .month, .day], from: date)
    return back.year == year && back.month == month && back.day == day ? [year, month, day] : nil
  }

  /// Whether `text` is `YYYY-MM-DD` and a real calendar date (`2026-02-30` is not).
  public static func isCalendarDay(_ text: String) -> Bool {
    dayParts(text) != nil
  }

  /// Noon of the day in the zone: an instant that shows as that day however the zone shifts its
  /// clocks around midnight.
  public func date(day: String) -> Date? {
    guard let parts = Self.dayParts(day) else {
      return nil
    }

    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
  }

  /// The day of an instant in the zone.
  public func day(of date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
  }

  /// Minutes since midnight of a strictly written `HH:MM` (24-hour), or `nil`.
  public static func minutes(time text: String) -> Int? {
    let pieces = text.split(separator: ":", omittingEmptySubsequences: false)

    guard pieces.count == 2, pieces.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
      let hour = Int(pieces[0]), let minute = Int(pieces[1]), hour < 24, minute < 60
    else {
      return nil
    }

    return hour * 60 + minute
  }

  /// The instant that reads `time` on the day of `reference` in the zone.
  public func date(time text: String, on reference: Date) -> Date? {
    guard let minutes = Self.minutes(time: text) else {
      return nil
    }

    let parts = calendar.dateComponents([.year, .month, .day], from: reference)
    return calendar.date(
      from: DateComponents(
        year: parts.year, month: parts.month, day: parts.day, hour: minutes / 60, minute: minutes % 60))
  }

  /// The time of day of an instant in the zone, `HH:MM`.
  public func time(of date: Date) -> String {
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
  }
}

/// An instant as the contract writes it: `YYYY-MM-DDTHH:MM[:SS]` and a numeric offset `±HH:MM`.
/// `Z` is not used; a datetime ANSWER adds the zone in brackets (`FormDateTime`).
public enum FormInstant {
  /// The instant of `2026-10-03T14:30+02:00` or `2026-10-03T14:30:15-04:00`; `nil` for anything else.
  /// A trailing `Z` is read as `+00:00` so a frame that sends it is still shown.
  public static func parse(_ text: String) -> Date? {
    let halves = text.split(separator: "T", omittingEmptySubsequences: false)

    guard halves.count == 2, let day = FormClock.dayParts(String(halves[0])) else {
      return nil
    }

    var clock = halves[1]
    var offset = 0

    if clock.hasSuffix("Z") {
      clock = clock.dropLast()
    } else if let sign = clock.lastIndex(where: { $0 == "+" || $0 == "-" }) {
      let zone = clock[clock.index(after: sign)...].split(separator: ":", omittingEmptySubsequences: false)

      guard zone.count == 2, zone.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
        let hours = Int(zone[0]), let minutes = Int(zone[1]), hours < 24, minutes < 60
      else {
        return nil
      }

      offset = (hours * 3600 + minutes * 60) * (clock[sign] == "-" ? -1 : 1)
      clock = clock[..<sign]
    } else {
      return nil
    }

    let pieces = clock.split(separator: ":", omittingEmptySubsequences: false)

    guard pieces.count == 2 || pieces.count == 3,
      pieces.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
      let hour = Int(pieces[0]), let minute = Int(pieces[1]), hour < 24, minute < 60
    else {
      return nil
    }

    let second = pieces.count == 3 ? Int(pieces[2]) ?? 99 : 0

    guard second < 60 else {
      return nil
    }

    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? .gmt

    guard
      let wall = utc.date(
        from: DateComponents(
          year: day[0], month: day[1], day: day[2], hour: hour, minute: minute, second: second))
    else {
      return nil
    }

    return wall.addingTimeInterval(TimeInterval(-offset))
  }

  /// `2026-10-03T14:30+02:00` for the instant in `zone`: the zone's offset at that instant, seconds
  /// only when there are some.
  public static func format(_ date: Date, in zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    let offset = zone.secondsFromGMT(for: date)
    let sign = offset < 0 ? "-" : "+"
    let magnitude = abs(offset)
    var text = String(
      format: "%04d-%02d-%02dT%02d:%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1, parts.hour ?? 0,
      parts.minute ?? 0)

    if let second = parts.second, second != 0 {
      text += String(format: ":%02d", second)
    }

    return text + String(format: "%@%02d:%02d", sign, magnitude / 3600, (magnitude % 3600) / 60)
  }
}

// MARK: - Numbers and amounts

/// What a person types into a number or amount field: a sign, digits, and at most one decimal
/// separator (a point or a comma, whichever their keyboard offers).
public enum FormDecimalText {
  /// `(negative, whole digits, fraction digits)` of typed text, or `nil` when it is not a decimal.
  static func parts(_ typed: String) -> (negative: Bool, whole: String, fraction: String)? {
    var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    var negative = false

    if text.hasPrefix("-") || text.hasPrefix("\u{2212}") {
      negative = true
      text.removeFirst()
    } else if text.hasPrefix("+") {
      text.removeFirst()
    }

    let separators = text.filter { $0 == "." || $0 == "," }

    guard separators.count <= 1, !text.isEmpty, text.allSatisfy({ ($0.isASCII && $0.isNumber) || $0 == "." || $0 == "," })
    else {
      return nil
    }

    let halves = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "." || $0 == "," })
    let whole = halves.first.map(String.init) ?? ""
    let fraction = halves.count > 1 ? String(halves[1]) : ""

    guard !whole.isEmpty || !fraction.isEmpty else {
      return nil
    }

    return (negative, whole, fraction)
  }

  /// The number typed, `nil` when it is not one (or not a finite one).
  public static func number(_ typed: String) -> Double? {
    guard let parts = parts(typed) else {
      return nil
    }

    let text = "\(parts.whole.isEmpty ? "0" : parts.whole).\(parts.fraction.isEmpty ? "0" : parts.fraction)"

    guard let value = Double(text), value.isFinite else {
      return nil
    }

    return parts.negative && value != 0 ? -value : value
  }

  /// A number as the field shows it: whole numbers without a fraction.
  public static func text(_ value: Double) -> String {
    if let whole = Int64(exactly: value) {
      return String(whole)
    }

    return String(value)
  }
}

/// A decimal STRING for an `amount` field (`^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$`), never a JSON
/// number, with at most as many decimals as the currency's ISO 4217 minor unit.
public enum FormAmount {
  /// The decimals of a currency's minor unit (EUR 2, JPY 0, KWD 3), at most the 3 the contract
  /// allows.
  public static func minorUnit(of currency: String?) -> Int {
    switch currency?.uppercased() {
    case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF",
      "XPF":
      0
    case "BHD", "CLF", "IQD", "JOD", "KWD", "LYD", "OMR", "TND", "UYW":
      3
    default:
      2
    }
  }

  /// The decimal string for what was typed, or `nil` when it has more decimals than `decimals`
  /// allows, more than 15 whole digits, or is not a decimal at all.
  public static func canonical(_ typed: String, decimals: Int) -> String? {
    guard let parts = FormDecimalText.parts(typed) else {
      return nil
    }

    var whole = parts.whole
    let fraction = parts.fraction

    while whole.count > 1, whole.hasPrefix("0") {
      whole.removeFirst()
    }

    if whole.isEmpty {
      whole = "0"
    }

    guard whole.count <= 15, fraction.count <= min(decimals, 3) else {
      return nil
    }

    // Trailing zeros are kept as typed ("180.50"); an empty fraction ("180.") is dropped.
    let magnitude = fraction.isEmpty ? whole : "\(whole).\(fraction)"
    let isZero = whole.allSatisfy { $0 == "0" } && fraction.allSatisfy { $0 == "0" }

    return parts.negative && !isZero ? "-\(magnitude)" : magnitude
  }

  /// The value of a decimal string.
  public static func decimal(_ text: String) -> Decimal? {
    Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
  }
}

// MARK: - The rules

/// Whether an entry is a value of its field, and the value it makes.
enum FormRules {
  /// `text` as the answer carries it, `nil` for no value: whitespace alone is none, and a keyboard
  /// hint other than `plain` (an address, a number, a link) drops the whitespace around it.
  static func text(_ typed: String, field: TextFormField) -> String? {
    let blank = typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

    if blank {
      return nil
    }

    switch field.input {
    case .email?, .phone?, .url?:
      return typed.trimmingCharacters(in: .whitespacesAndNewlines)
    default:
      return typed
    }
  }

  /// Whether `text` holds a line break the contract does not allow in a one-line field: CR, LF, VT,
  /// FF, NEL, U+2028 and U+2029.
  static func hasLineBreak(_ text: String) -> Bool {
    text.unicodeScalars.contains { scalar in
      switch scalar.value {
      case 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029: true
      default: false
      }
    }
  }

  /// The first problem of `input` for `field`, in the gateway's order; `nil` when it is a value or
  /// no value at a field that does not need one.
  static func problem(_ field: FormField, _ input: FormInput, device: TimeZone) -> FormProblem? {
    let required = field.isRequired

    func absent() -> FormProblem? { required ? .missing : nil }

    switch (field, input) {
    case (.text(let field), .text(let typed)):
      guard let value = text(typed, field: field) else {
        return absent()
      }

      if !field.isMultiline, hasLineBreak(value) {
        return .format
      }

      return value.unicodeScalars.count > field.effectiveMaxLength ? .tooLong : nil
    case (.number(let field), .number(let typed)):
      if typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return absent()
      }

      guard let value = FormDecimalText.number(typed) else {
        return .format
      }

      if let min = field.min, value < min {
        return .belowMin
      }

      if let max = field.max, value > max {
        return .aboveMax
      }

      if field.isInteger, value != value.rounded() {
        return .notInteger
      }

      if let step = field.step, step > 0 {
        let steps = (value - (field.min ?? 0)) / step

        if abs(steps - steps.rounded()) > 1e-9 * Swift.max(1, abs(steps)) {
          return .step
        }
      }

      return nil
    case (.amount(let field), .amount(let typed)):
      if typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return absent()
      }

      guard let canonical = FormAmount.canonical(typed, decimals: FormAmount.minorUnit(of: field.currency)),
        let value = FormAmount.decimal(canonical)
      else {
        return .format
      }

      if let min = field.min.flatMap(FormAmount.decimal), value < min {
        return .belowMin
      }

      if let max = field.max.flatMap(FormAmount.decimal), value > max {
        return .aboveMax
      }

      return nil
    case (.date(let field), .date(let chosen)):
      guard let chosen else {
        return absent()
      }

      guard FormClock.isCalendarDay(chosen) else {
        return .format
      }

      if let min = field.min, chosen < min {
        return .belowMin
      }

      return field.max.map { chosen > $0 } == true ? .aboveMax : nil
    case (.time(let field), .time(let chosen)):
      guard let chosen else {
        return absent()
      }

      guard let minutes = FormClock.minutes(time: chosen) else {
        return .format
      }

      if let min = field.min.flatMap(FormClock.minutes(time:)), minutes < min {
        return .belowMin
      }

      return field.max.flatMap(FormClock.minutes(time:)).map { minutes > $0 } == true ? .aboveMax : nil
    case (.datetime(let field), .datetime(let chosen)):
      guard let chosen else {
        return absent()
      }

      if let min = field.min.flatMap(FormInstant.parse), chosen < min {
        return .belowMin
      }

      return field.max.flatMap(FormInstant.parse).map { chosen > $0 } == true ? .aboveMax : nil
    case (.daterange(let field), .range(let start, let end)):
      guard start != nil || end != nil else {
        return absent()
      }

      guard let start, let end else {
        // One end of a range is no value.
        return .missing
      }

      guard FormClock.isCalendarDay(start), FormClock.isCalendarDay(end) else {
        return .format
      }

      if end < start {
        return .order
      }

      if let min = field.min, start < min {
        return .belowMin
      }

      return field.max.map { end > $0 } == true ? .aboveMax : nil
    case (.choice(let field), .choice(let chosen)):
      guard let chosen, !chosen.isEmpty else {
        return absent()
      }

      return (field.options ?? []).contains { $0.value == chosen } ? nil : .notAnOption
    case (.choice(let field), .choices(let chosen)):
      guard !chosen.isEmpty else {
        return absent()
      }

      let values = Set((field.options ?? []).compactMap(\.value))

      if !chosen.allSatisfy(values.contains) {
        return .notAnOption
      }

      if Set(chosen).count != chosen.count {
        return .duplicate
      }

      if let least = field.minSelected, chosen.count < least {
        return .tooFew
      }

      return field.maxSelected.map { chosen.count > $0 } == true ? .tooMany : nil
    case (.toggle, .toggle):
      return nil
    default:
      // An entry of another kind than its field: nothing the person could have typed.
      return .type
    }
  }

  /// The value `input` makes for `field`, `nil` for no value. Only for an entry without a problem.
  static func value(_ field: FormField, _ input: FormInput, device: TimeZone) -> FormValue? {
    switch (field, input) {
    case (.text(let field), .text(let typed)):
      return text(typed, field: field).map(FormValue.text)
    case (.number, .number(let typed)):
      return FormDecimalText.number(typed).map(FormValue.number)
    case (.amount(let field), .amount(let typed)):
      return FormAmount.canonical(typed, decimals: FormAmount.minorUnit(of: field.currency)).map(FormValue.amount)
    case (.date, .date(let chosen)):
      return chosen.map(FormValue.date)
    case (.time, .time(let chosen)):
      return chosen.map(FormValue.time)
    case (.datetime(let field), .datetime(let chosen)):
      guard let chosen else {
        return nil
      }

      let zone = FormClock.zone(named: field.tz, device: device)
      let name = field.tz.flatMap { TimeZone(identifier: $0) != nil ? $0 : nil } ?? zone.identifier
      return .datetime(instant: FormInstant.format(chosen, in: zone), zone: name)
    case (.daterange, .range(let start?, let end?)):
      return .daterange(start: start, end: end)
    case (.choice(let field), .choice(let chosen)):
      _ = field
      return chosen.flatMap { $0.isEmpty ? nil : FormValue.choice($0) }
    case (.choice(let field), .choices(let chosen)):
      // In the order the options are listed, whatever order they were ticked in.
      let order = (field.options ?? []).compactMap(\.value)
      let sorted = chosen.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }
      return sorted.isEmpty ? nil : FormValue.choices(sorted)
    case (.toggle, .toggle(let on)):
      return .toggle(on)
    default:
      return nil
    }
  }
}
