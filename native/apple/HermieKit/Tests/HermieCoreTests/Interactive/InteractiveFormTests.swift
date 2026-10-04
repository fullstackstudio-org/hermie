import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The form's rules and model: the gateway's own checks of `contract/requests/README.md` §4 on the
/// client side, driven by the contract's own examples, plus what the sheet adds (defaults, zones,
/// the order of values, the gateway's refusals next to the field).
private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

private func examples() throws -> [JSONValue] {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  return try #require(root["form_fields"]?.arrayValue)
}

private func params(_ fields: JSONValue...) -> InputFormParams {
  InputFormParams(json: ["v": 1, "title": "t", "summary": "s", "fields": .array(fields)])
}

/// The entry a person would have made to give `value` to `field`, `nil` when no entry can make
/// that value (a JSON type the control cannot produce: the wire's `type` problem).
private func entry(_ value: JSONValue, field: FormField) -> FormInput? {
  switch (field, value) {
  case (.text, .string(let text)): return .text(text)
  case (.number, .number(let number)): return .number(FormDecimalText.text(number))
  case (.amount, .string(let text)): return .amount(text)
  case (.date, .string(let text)): return .date(text.isEmpty ? nil : text)
  case (.time, .string(let text)): return .time(text.isEmpty ? nil : text)
  case (.datetime, .string(let text)):
    guard let split = FormDateTime.split(text), let instant = FormInstant.parse(split.instant) else {
      return nil
    }

    return .datetime(instant)
  case (.daterange, .object(let object)):
    return .range(start: object["start"]?.stringValue, end: object["end"]?.stringValue)
  case (.choice(let field), .string(let text)) where !field.isMultiple: return .choice(text.isEmpty ? nil : text)
  case (.choice(let field), .array(let list)) where field.isMultiple: return .choices(list.compactMap(\.stringValue))
  case (.toggle, .bool(let on)): return .toggle(on)
  default: return nil
  }
}

@MainActor
@Suite("Form rules and model")
struct InteractiveFormTests {
  // MARK: The contract's examples

  @Test("every valid example value of the contract is a value of its field, and builds that value")
  func validExamples() throws {
    for example in try examples() {
      let fieldJSON = try #require(example["field"])
      let name = example["name"]?.stringValue ?? "?"
      let field = try #require(FormField(jsonValue: fieldJSON))
      let id = try #require(field.id)

      for value in try #require(example["valid"]?.arrayValue) {
        // The zone of the value, so a field without a `tz` is answered in it.
        var device = TimeZone(identifier: "Europe/Amsterdam") ?? .current

        if let text = value.stringValue, let zone = FormDateTime.split(text)?.zone, let named = TimeZone(identifier: zone) {
          device = named
        }

        let form = InteractiveFormModel(params: params(fieldJSON), device: device)

        guard let input = entry(value, field: field) else {
          Issue.record("\(name): no entry makes \(value)")
          continue
        }

        form.set(input, for: id)
        #expect(form.problem(of: id) == nil, "\(name): \(value) should be a value")

        // "" is no value: the field is left out of the answer.
        let built = form.values()[id]

        if value == "" {
          #expect(built == nil, "\(name): \"\" is no value")
        } else if let text = value.stringValue, FormDateTime.split(text) != nil {
          // Seconds are written only when there are some: `14:30:00` and `14:30` are one instant.
          let expected = text.replacingOccurrences(of: ":00+", with: "+").replacingOccurrences(of: ":00-", with: "-")
          #expect(built?.jsonValue == .string(expected), "\(name): \(value)")
        } else {
          #expect(built?.jsonValue == value, "\(name): \(value)")
        }
      }
    }
  }

  @Test("every invalid example a control can make is refused with the contract's own problem")
  func invalidExamples() throws {
    var checked = 0

    for example in try examples() {
      let fieldJSON = try #require(example["field"])
      let name = example["name"]?.stringValue ?? "?"
      let field = try #require(FormField(jsonValue: fieldJSON))
      let id = try #require(field.id)
      let form = InteractiveFormModel(params: params(fieldJSON), device: TimeZone(identifier: "Europe/Amsterdam") ?? .current)

      for invalid in example["invalid"]?.arrayValue ?? [] {
        let reason = try #require(invalid["reason"]?.stringValue)
        let problem = String(try #require(reason.split(separator: ":").last))

        // A picker cannot get a datetime's zone, offset or format wrong: only its bounds.
        if case .datetime = field, !["below_min", "above_max"].contains(problem) {
          continue
        }

        guard let value = invalid["value"], let input = entry(value, field: field) else {
          // A value no control makes: the wire's `type` (and a datetime's format, which a date
          // picker cannot get wrong).
          continue
        }

        form.set(input, for: id)
        #expect(form.problem(of: id)?.wire == problem, "\(name): \(value) should be refused as \(reason)")
        checked += 1
      }
    }

    #expect(checked >= 25, "the examples exercised: \(checked)")
  }

  // MARK: Fields

  @Test("defaults fill the form: text, number, choices, a toggle, a range, a datetime")
  func defaults() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "name", "kind": "text", "label": "n", "default": "Ada"],
        ["id": "guests", "kind": "number", "label": "g", "integer": true, "default": 2],
        ["id": "extras", "kind": "choice", "label": "e", "multiple": true,
          "options": [["value": "a", "label": "A"], ["value": "b", "label": "B"]], "default": ["b"]],
        ["id": "room", "kind": "choice", "label": "r", "options": [["value": "x", "label": "X"]], "default": "x"],
        ["id": "news", "kind": "toggle", "label": "t", "default": true],
        ["id": "stay", "kind": "daterange", "label": "s", "default": ["start": "2026-10-03", "end": "2026-10-05"]],
        ["id": "call", "kind": "datetime", "label": "c", "tz": "Europe/Amsterdam", "default": "2026-10-07T14:30:00+02:00"]
      ))

    #expect(
      form.values() == [
        "name": .text("Ada"), "guests": .number(2), "extras": .choices(["b"]), "room": .choice("x"),
        "news": .toggle(true), "stay": .daterange(start: "2026-10-03", end: "2026-10-05"),
        "call": .datetime(instant: "2026-10-07T14:30+02:00", zone: "Europe/Amsterdam")
      ])
  }

  @Test("an untouched toggle answers false, and an empty optional field is left out")
  func emptyFields() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "news", "kind": "toggle", "label": "t"],
        ["id": "note", "kind": "text", "label": "n"],
        ["id": "budget", "kind": "amount", "label": "b", "currency": "EUR"],
        ["id": "day", "kind": "date", "label": "d"]))

    #expect(form.isComplete)
    #expect(form.values() == ["news": .toggle(false)])
    #expect(form.submit() == ["news": .toggle(false)])
  }

  @Test("whitespace alone is no value; an address loses the whitespace around it, plain text keeps its own")
  func whitespace() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "who", "kind": "text", "label": "w", "required": true],
        ["id": "mail", "kind": "text", "label": "m", "input": "email"],
        ["id": "note", "kind": "text", "label": "n"]))

    form.set(.text("   \n"), for: "who")
    #expect(form.problem(of: "who") == .missing)
    form.set(.text("  me@example.com \n"), for: "mail")
    form.set(.text("  two  spaces "), for: "note")
    form.set(.text("Ada"), for: "who")
    #expect(form.values() == ["who": .text("Ada"), "mail": .text("me@example.com"), "note": .text("  two  spaces ")])
  }

  @Test("max_length counts code points, and a one-line field takes no line break")
  func textLimits() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "t", "kind": "text", "label": "t", "max_length": 3],
        ["id": "m", "kind": "text", "label": "m", "multiline": true]))

    // One family emoji is one character to a person and five code points to the gateway.
    form.set(.text("👨‍👩‍👧"), for: "t")
    #expect(form.problem(of: "t") == .tooLong)
    form.set(.text("abc"), for: "t")
    #expect(form.problem(of: "t") == nil)
    form.set(.text("a\u{2028}b"), for: "t")
    #expect(form.problem(of: "t") == .format)
    form.set(.text("a\nb"), for: "m")
    #expect(form.problem(of: "m") == nil)
  }

  @Test("numbers: a comma is a decimal separator, steps count from min, and a whole number is whole")
  func numbers() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "n", "kind": "number", "label": "n", "min": 1, "max": 10, "step": 0.5],
        ["id": "w", "kind": "number", "label": "w", "integer": true]))

    form.set(.number("2,5"), for: "n")
    #expect(form.problem(of: "n") == nil)
    #expect(form.values()["n"] == .number(2.5))
    form.set(.number("2,3"), for: "n")
    #expect(form.problem(of: "n") == .step)
    form.set(.number("abc"), for: "n")
    #expect(form.problem(of: "n") == .format)
    form.set(.number("1,2,3"), for: "n")
    #expect(form.problem(of: "n") == .format)
    form.set(.number("-3"), for: "w")
    #expect(form.problem(of: "w") == nil)
    form.set(.number("3.0"), for: "w")
    #expect(form.problem(of: "w") == nil)
    #expect(form.values()["w"] == .number(3))
    form.set(.number("3.5"), for: "w")
    #expect(form.problem(of: "w") == .notInteger)
  }

  @Test("amounts are decimal strings with at most the currency's decimals, never numbers")
  func amounts() throws {
    #expect(FormAmount.minorUnit(of: "EUR") == 2)
    #expect(FormAmount.minorUnit(of: "JPY") == 0)
    #expect(FormAmount.minorUnit(of: "KWD") == 3)
    #expect(FormAmount.minorUnit(of: nil) == 2)
    #expect(FormAmount.canonical("180", decimals: 2) == "180")
    #expect(FormAmount.canonical("180,50", decimals: 2) == "180.50")
    #expect(FormAmount.canonical("007.5", decimals: 2) == "7.5")
    #expect(FormAmount.canonical(".5", decimals: 2) == "0.5")
    #expect(FormAmount.canonical("5.", decimals: 2) == "5")
    #expect(FormAmount.canonical("-0.00", decimals: 2) == "0.00")
    #expect(FormAmount.canonical("-12.5", decimals: 2) == "-12.5")
    #expect(FormAmount.canonical("1.234", decimals: 2) == nil)
    #expect(FormAmount.canonical("1.5", decimals: 0) == nil)
    #expect(FormAmount.canonical("1,250.50", decimals: 2) == nil)
    #expect(FormAmount.canonical("12e3", decimals: 2) == nil)
    #expect(FormAmount.canonical("1234567890123456", decimals: 2) == nil)
    #expect(FormAmount.canonical("123456789012345", decimals: 2) == "123456789012345")

    let form = InteractiveFormModel(
      params: params(["id": "b", "kind": "amount", "label": "b", "currency": "EUR", "min": "0", "max": "5000"]))
    form.set(.amount("1250,50"), for: "b")
    #expect(form.values()["b"] == .amount("1250.50"))
    #expect(form.values()["b"]?.jsonValue == .string("1250.50"))
    form.set(.amount("5000.01"), for: "b")
    #expect(form.problem(of: "b") == .aboveMax)
    form.set(.amount("-1"), for: "b")
    #expect(form.problem(of: "b") == .belowMin)
  }

  @Test("a datetime is answered in the field's zone, with the zone's offset at that instant")
  func datetimes() throws {
    let form = InteractiveFormModel(
      params: params(["id": "c", "kind": "datetime", "label": "c", "tz": "Europe/Amsterdam"]),
      device: TimeZone(identifier: "America/New_York") ?? .current)
    let summer = try #require(FormInstant.parse("2026-10-07T12:30:00+00:00"))
    let winter = try #require(FormInstant.parse("2026-11-07T08:00:00+00:00"))

    form.set(.datetime(summer), for: "c")
    #expect(form.values()["c"] == .datetime(instant: "2026-10-07T14:30+02:00", zone: "Europe/Amsterdam"))
    form.set(.datetime(winter), for: "c")
    #expect(form.values()["c"] == .datetime(instant: "2026-11-07T09:00+01:00", zone: "Europe/Amsterdam"))

    // No `tz`: the device's zone.
    let device = InteractiveFormModel(
      params: params(["id": "r", "kind": "datetime", "label": "r"]),
      device: TimeZone(identifier: "America/New_York") ?? .current)
    device.set(.datetime(summer), for: "r")
    #expect(device.values()["r"] == .datetime(instant: "2026-10-07T08:30-04:00", zone: "America/New_York"))
  }

  @Test("instants parse and print as the contract writes them")
  func instants() throws {
    let utc = try #require(FormInstant.parse("2026-10-07T12:30+00:00"))
    #expect(FormInstant.parse("2026-10-07T14:30:00+02:00") == utc)
    #expect(FormInstant.parse("2026-10-07T08:30:00-04:00") == utc)
    #expect(FormInstant.parse("2026-10-07T12:30:00Z") == utc, "a Z is read as +00:00")
    #expect(FormInstant.parse("2026-10-07T14:30") == nil, "no offset")
    #expect(FormInstant.parse("2026-02-30T10:00+00:00") == nil)
    #expect(FormInstant.parse("2026-10-07T24:00+00:00") == nil)
    #expect(FormInstant.parse("2026-10-07T12:30:61+00:00") == nil)
    #expect(FormInstant.format(utc, in: TimeZone(identifier: "Asia/Kolkata") ?? .gmt) == "2026-10-07T18:00+05:30")
    #expect(FormInstant.format(utc.addingTimeInterval(15), in: .gmt) == "2026-10-07T12:30:15+00:00")
  }

  @Test("days and times of day are strict, and read in the field's zone")
  func clock() throws {
    let amsterdam = FormClock(zone: TimeZone(identifier: "Europe/Amsterdam") ?? .gmt)
    let tokyo = FormClock(zone: TimeZone(identifier: "Asia/Tokyo") ?? .gmt)
    let instant = try #require(FormInstant.parse("2026-10-07T23:30:00+00:00"))

    // The same instant is two different days.
    #expect(amsterdam.day(of: instant) == "2026-10-08")
    #expect(tokyo.day(of: instant) == "2026-10-08")
    #expect(FormClock(zone: .gmt).day(of: instant) == "2026-10-07")
    #expect(amsterdam.time(of: instant) == "01:30")

    let day = try #require(amsterdam.date(day: "2026-10-04"))
    #expect(amsterdam.day(of: day) == "2026-10-04")
    #expect(FormClock.isCalendarDay("2026-02-28"))
    #expect(!FormClock.isCalendarDay("2026-02-30"))
    #expect(!FormClock.isCalendarDay("2026-2-3"))
    #expect(!FormClock.isCalendarDay("14-11-2026"))
    #expect(FormClock.minutes(time: "14:30") == 870)
    #expect(FormClock.minutes(time: "24:00") == nil)
    #expect(FormClock.minutes(time: "2:30") == nil)
    #expect(FormClock.minutes(time: "14:30:00") == nil)
    #expect(FormClock.zone(named: "Mars/Olympus_Mons", device: tokyo.zone) == tokyo.zone)
  }

  @Test("choosing a date puts today in the field's zone, moved into its bounds")
  func choosingADate() throws {
    let now = try #require(FormInstant.parse("2026-10-07T23:30:00+00:00"))
    let form = InteractiveFormModel(
      params: params(
        ["id": "d", "kind": "date", "label": "d", "tz": "Asia/Tokyo"],
        ["id": "e", "kind": "date", "label": "e", "min": "2026-12-01"],
        ["id": "t", "kind": "time", "label": "t", "tz": "Europe/Amsterdam", "max": "00:30"],
        ["id": "r", "kind": "daterange", "label": "r", "max": "2026-10-01"]),
      now: { now })

    form.choose("d")
    form.choose("e")
    form.choose("t")
    form.choose("r")
    #expect(form.input("d") == .date("2026-10-08"))
    #expect(form.input("e") == .date("2026-12-01"))
    #expect(form.input("t") == .time("00:30"))
    #expect(form.input("r") == .range(start: "2026-10-01", end: "2026-10-01"))
    form.clear("d")
    #expect(form.input("d") == .date(nil))
  }

  @Test("a datetime is chosen and set in whole minutes, and choosing never lands outside the bounds")
  func wholeMinutes() throws {
    let now = try #require(FormInstant.parse("2026-10-07T12:30:45+00:00"))
    let form = InteractiveFormModel(
      params: params(
        ["id": "a", "kind": "datetime", "label": "a", "tz": "Europe/Amsterdam"],
        ["id": "capped", "kind": "datetime", "label": "c", "tz": "Europe/Amsterdam", "max": "2026-10-07T14:00:30+02:00"],
        ["id": "late", "kind": "datetime", "label": "l", "tz": "Europe/Amsterdam", "min": "2026-10-07T15:00:30+02:00"],
        ["id": "kept", "kind": "datetime", "label": "k", "tz": "Europe/Amsterdam", "default": "2026-10-07T14:30:15+02:00"]),
      now: { now })

    form.choose("a")
    #expect(form.values()["a"] == .datetime(instant: "2026-10-07T14:30+02:00", zone: "Europe/Amsterdam"), "no seconds")

    // Now (14:30:45) is past the cap (14:00:30): the last whole minute before it.
    form.choose("capped")
    #expect(form.values()["capped"] == .datetime(instant: "2026-10-07T14:00+02:00", zone: "Europe/Amsterdam"))
    #expect(form.problem(of: "capped") == nil, "picking the maximum does not show above_max")

    // Before the earliest (15:00:30): the first whole minute after it.
    form.choose("late")
    #expect(form.values()["late"] == .datetime(instant: "2026-10-07T15:01+02:00", zone: "Europe/Amsterdam"))
    #expect(form.problem(of: "late") == nil)

    // What the picker hands over loses its seconds; what the agent defaulted keeps them.
    form.set(.datetime(now), for: "a")
    let floored = try #require(FormInstant.parse("2026-10-07T12:30:00+00:00") as Date?)
    #expect(form.input("a") == .datetime(floored))
    #expect(form.values()["kept"] == .datetime(instant: "2026-10-07T14:30:15+02:00", zone: "Europe/Amsterdam"))
  }

  @Test("a date range with one end is no value; an end before the start is an order problem")
  func ranges() throws {
    let form = InteractiveFormModel(
      params: params(["id": "r", "kind": "daterange", "label": "r", "min": "2026-10-05", "max": "2026-12-31"]))

    #expect(form.problem(of: "r") == nil, "not required, empty")
    form.set(.range(start: "2026-11-14", end: nil), for: "r")
    #expect(form.problem(of: "r") == .missing)
    form.set(.range(start: "2026-11-16", end: "2026-11-14"), for: "r")
    #expect(form.problem(of: "r") == .order)
    form.set(.range(start: "2026-11-14", end: "2026-11-14"), for: "r")
    #expect(form.problem(of: "r") == nil)
  }

  @Test("a multiple choice: ticked options come out in the options' order, and ticking past max_selected does nothing")
  func multipleChoice() throws {
    let form = InteractiveFormModel(
      params: params([
        "id": "x", "kind": "choice", "label": "x", "multiple": true, "min_selected": 2, "max_selected": 2,
        "options": [["value": "a", "label": "A"], ["value": "b", "label": "B"], ["value": "c", "label": "C"]]
      ]))

    form.toggle(option: "c", in: "x")
    #expect(form.problem(of: "x") == .tooFew)
    form.toggle(option: "a", in: "x")
    form.toggle(option: "b", in: "x")
    #expect(form.input("x") == .choices(["c", "a"]), "full: b was not ticked")
    #expect(form.values()["x"] == .choices(["a", "c"]))
    form.toggle(option: "c", in: "x")
    #expect(form.input("x") == .choices(["a"]))
    // An entry of another kind than the field's is ignored.
    form.set(.text("a"), for: "x")
    #expect(form.input("x") == .choices(["a"]))
  }

  @Test("a required field with no value is missing, and an entry of the wrong kind never answers")
  func required() throws {
    let form = InteractiveFormModel(
      params: params(
        ["id": "a", "kind": "text", "label": "a", "required": true],
        ["id": "d", "kind": "date", "label": "d", "required": true],
        ["id": "c", "kind": "choice", "label": "c", "required": true, "options": [["value": "x", "label": "X"]]]))

    #expect(form.firstProblemID == "a")
    #expect(form.problem(of: "d") == .missing)
    #expect(form.problem(of: "c") == .missing)
    #expect(form.submit() == nil)
    form.set(.text("x"), for: "a")
    #expect(form.firstProblemID == "d")
  }

  // MARK: What is shown, and when

  @Test("problems show after the first try to send, then live; the values come back only when there are none")
  func attemptedProblems() throws {
    let form = InteractiveFormModel(params: params(["id": "a", "kind": "text", "label": "a", "required": true]))

    #expect(form.shownProblem(of: "a") == nil)
    #expect(form.submit() == nil)
    #expect(form.attempted)
    #expect(form.shownProblem(of: "a") == .missing)
    form.set(.text("Ada"), for: "a")
    #expect(form.shownProblem(of: "a") == nil)
    #expect(form.submit() == ["a": .text("Ada")])
  }

  @Test("the gateway's refusal shows next to its field until the entry changes; one that names no field is general")
  func refusals() throws {
    let form = InteractiveFormModel(
      params: params(["id": "guests", "kind": "number", "label": "g", "integer": true]))

    form.set(.number("0"), for: "guests")
    form.noteRefusal("field:guests:below_min")
    #expect(form.shownProblem(of: "guests") == .belowMin)
    #expect(form.generalRefusal == nil)
    form.set(.number("2"), for: "guests")
    #expect(form.shownProblem(of: "guests") == nil, "the entry the gateway refused is gone")
    form.set(.number("0"), for: "guests")
    #expect(form.shownProblem(of: "guests") == .belowMin, "and back: refused again")

    form.noteRefusal("bad_shape")
    #expect(form.generalRefusal == "bad_shape")
    #expect(form.shownProblem(of: "guests") == nil)
    form.noteRefusal(nil)
    #expect(form.generalRefusal == nil)

    #expect(FormRefusal(reason: "field:guests:below_min") == FormRefusal(reason: "field:guests:below_min"))
    #expect(FormRefusal(reason: "field:x:brand_new")?.problem == .other("brand_new"))
    #expect(FormRefusal(reason: "files:too_many") == nil)
    #expect(FormRefusal(reason: "field::missing") == nil)
    #expect(FormProblem(wire: "too_many").wire == "too_many")
  }

  @Test("wiping empties what was typed and brings the defaults back")
  func wipe() throws {
    let form = InteractiveFormModel(
      params: params(["id": "a", "kind": "text", "label": "a", "default": "Ada", "required": true]))

    form.set(.text("a secret nobody should keep"), for: "a")
    _ = form.submit()
    form.noteRefusal("field:a:too_long")
    form.wipe()
    #expect(form.input("a") == .text("Ada"))
    #expect(!form.attempted)
    #expect(form.shownProblem(of: "a") == nil)
  }
}
