import Foundation
import HermieProtocol
import Observation

/// What the person has typed into an `input.form`, field by field, and what of it is a value.
///
/// This is the sheet's own state: it lives as long as the sheet and goes nowhere but into the
/// answer it builds (`submit()`), which the caller sends through `InteractiveModel.answer`. Nothing
/// here is stored, logged or handed to the center; `wipe()` empties it once the answer went out.
///
/// Problems are the gateway's own (`FormProblem`), found before the answer goes out, and shown next
/// to the field once the person tried to send (`attempted`), or at once for a problem the gateway
/// named in a refusal and the field still has the entry it refused (`noteRefusal`).
@MainActor
@Observable
public final class InteractiveFormModel {
  /// The fields in order.
  public let fields: [FormField]
  /// What the fields hold, by id.
  public private(set) var inputs: [String: FormInput]
  /// The person tried to send: problems show from now on, live.
  public private(set) var attempted = false
  /// The gateway's last refusal that names no field (`bad_shape`, `not_optional`, ...).
  public private(set) var generalRefusal: String?

  @ObservationIgnored private let device: TimeZone
  @ObservationIgnored private let now: @Sendable () -> Date
  /// The gateway's refusal of one field, and what that field held when it was refused.
  private var refused: (refusal: FormRefusal, entry: FormInput?)?

  public init(
    params: InputFormParams,
    device: TimeZone = .current,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    let fields = params.fields ?? []
    self.fields = fields
    self.device = device
    self.now = now
    self.inputs = Dictionary(
      fields.compactMap { field in field.id.map { ($0, Self.initial(field, device: device)) } },
      uniquingKeysWith: { first, _ in first })
  }

  // MARK: - What the fields hold

  /// The entry a field starts with: its default, or nothing.
  static func initial(_ field: FormField, device: TimeZone) -> FormInput {
    switch field {
    case .text(let field): return .text(field.default ?? "")
    case .number(let field): return .number(field.default.map(FormDecimalText.text) ?? "")
    case .amount(let field): return .amount(field.default ?? "")
    case .date(let field): return .date(field.default)
    case .time(let field): return .time(field.default)
    case .datetime(let field): return .datetime(field.default.flatMap(FormInstant.parse))
    case .daterange(let field): return .range(start: field.default?.start, end: field.default?.end)
    case .choice(let field):
      if field.isMultiple {
        if case .list(let values)? = field.default {
          return .choices(values)
        }

        return .choices([])
      }

      if case .string(let value)? = field.default {
        return .choice(value)
      }

      return .choice(nil)
    case .toggle(let field): return .toggle(field.default ?? false)
    case .unknown: return .text("")
    }
  }

  public func field(_ id: String) -> FormField? {
    fields.first { $0.id == id }
  }

  public func input(_ id: String) -> FormInput? {
    inputs[id]
  }

  /// Put an entry in a field. An entry of another kind than the field's is ignored.
  public func set(_ input: FormInput, for id: String) {
    guard let field = field(id), Self.fits(input, field) else {
      return
    }

    // A person picks minutes: no hidden seconds ride along with the picker's own clock.
    if case .datetime(let instant?) = input {
      inputs[id] = .datetime(Self.wholeMinute(instant))
      return
    }

    inputs[id] = input
  }

  /// The instant at the start of its minute.
  static func wholeMinute(_ instant: Date) -> Date {
    Date(timeIntervalSince1970: (instant.timeIntervalSince1970 / 60).rounded(.down) * 60)
  }

  private static func fits(_ input: FormInput, _ field: FormField) -> Bool {
    switch (field, input) {
    case (.text, .text), (.number, .number), (.amount, .amount), (.date, .date), (.time, .time),
      (.datetime, .datetime), (.daterange, .range), (.toggle, .toggle):
      true
    case (.choice(let field), .choice):
      !field.isMultiple
    case (.choice(let field), .choices):
      field.isMultiple
    default:
      false
    }
  }

  /// The zone a date, time or datetime field is in: its `tz`, else the device's.
  public func clock(for id: String) -> FormClock {
    let name: String? =
      switch field(id) {
      case .date(let field)?: field.tz
      case .time(let field)?: field.tz
      case .datetime(let field)?: field.tz
      case .daterange(let field)?: field.tz
      default: nil
      }

    return FormClock(zone: FormClock.zone(named: name, device: device))
  }

  /// What a date, time or datetime field shows when the person first chooses a value: now (today),
  /// moved into the field's bounds.
  public func choose(_ id: String) {
    guard let field = field(id) else {
      return
    }

    let clock = clock(for: id)
    let current = now()

    switch field {
    case .date(let field):
      set(.date(Self.clamp(clock.day(of: current), field.min, field.max)), for: id)
    case .time(let field):
      set(.time(Self.clamp(clock.time(of: current), field.min, field.max)), for: id)
    case .datetime(let field):
      // Now, to the minute; inside the bounds, which may themselves have seconds: the earliest
      // minute at or after `min`, the latest at or before `max`.
      var chosen = Self.wholeMinute(current)

      if let min = field.min.flatMap(FormInstant.parse), chosen < min {
        chosen = Self.wholeMinute(min) < min ? Self.wholeMinute(min).addingTimeInterval(60) : min
      }

      if let max = field.max.flatMap(FormInstant.parse), chosen > max {
        chosen = Self.wholeMinute(max)
      }

      set(.datetime(chosen), for: id)
    case .daterange(let field):
      let day = Self.clamp(clock.day(of: current), field.min, field.max)
      set(.range(start: day, end: day), for: id)
    default:
      break
    }
  }

  /// Take a date, time or datetime field's value away again.
  public func clear(_ id: String) {
    switch field(id) {
    case .date?: set(.date(nil), for: id)
    case .time?: set(.time(nil), for: id)
    case .datetime?: set(.datetime(nil), for: id)
    case .daterange?: set(.range(start: nil, end: nil), for: id)
    case .choice(let field)?: set(field.isMultiple ? .choices([]) : .choice(nil), for: id)
    case .text?: set(.text(""), for: id)
    case .number?: set(.number(""), for: id)
    case .amount?: set(.amount(""), for: id)
    default: break
    }
  }

  private static func clamp(_ value: String, _ min: String?, _ max: String?) -> String {
    if let min, value < min {
      return min
    }

    if let max, value > max {
      return max
    }

    return value
  }

  // MARK: - Choices

  /// Tick or untick an option of a multiple choice. Ticking past `max_selected` does nothing.
  public func toggle(option: String, in id: String) {
    guard case .choice(let field)? = field(id), case .choices(var chosen)? = inputs[id] else {
      return
    }

    if let index = chosen.firstIndex(of: option) {
      chosen.remove(at: index)
    } else {
      if let most = field.maxSelected, chosen.count >= most {
        return
      }

      chosen.append(option)
    }

    inputs[id] = .choices(chosen)
  }

  // MARK: - Problems

  /// The problem of a field's entry as it stands, whether or not it is shown yet.
  public func problem(of id: String) -> FormProblem? {
    guard let field = field(id), let input = inputs[id] else {
      return nil
    }

    return FormRules.problem(field, input, device: device)
  }

  /// The problem to show next to a field: its own once the person tried to send, or the gateway's
  /// for the entry it refused.
  public func shownProblem(of id: String) -> FormProblem? {
    if attempted, let problem = problem(of: id) {
      return problem
    }

    if let refused, refused.refusal.fieldID == id, inputs[id] == refused.entry {
      return refused.refusal.problem
    }

    return nil
  }

  /// The id of the first field, in order, that has a problem.
  public var firstProblemID: String? {
    fields.compactMap(\.id).first { problem(of: $0) != nil }
  }

  /// Every field is a value or no value where none is needed.
  public var isComplete: Bool {
    firstProblemID == nil
  }

  /// The values of the fields that have one, by id: a field without a value is left out.
  public func values() -> [String: FormValue] {
    var values: [String: FormValue] = [:]

    for field in fields {
      if let id = field.id, let input = inputs[id], let value = FormRules.value(field, input, device: device) {
        values[id] = value
      }
    }

    return values
  }

  /// The person tries to send: problems show from now on, and the values come back when there is
  /// none.
  public func submit() -> [String: FormValue]? {
    attempted = true
    generalRefusal = nil

    guard isComplete else {
      return nil
    }

    return values()
  }

  /// The gateway refused the last answer (`InteractiveModel.refusal`), or no longer does.
  public func noteRefusal(_ reason: String?) {
    guard let reason else {
      refused = nil
      generalRefusal = nil
      return
    }

    if let refusal = FormRefusal(reason: reason) {
      refused = (refusal, inputs[refusal.fieldID])
      generalRefusal = nil
    } else {
      refused = nil
      generalRefusal = reason
    }
  }

  /// Empty the form: what was typed leaves with the sheet.
  public func wipe() {
    for field in fields {
      if let id = field.id {
        inputs[id] = Self.initial(field, device: device)
      }
    }

    attempted = false
    refused = nil
    generalRefusal = nil
  }
}
