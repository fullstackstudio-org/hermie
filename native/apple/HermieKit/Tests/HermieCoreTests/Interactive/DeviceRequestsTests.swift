import Contacts
import EventKit
import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// The contract's examples for one device method.
private func examples(_ method: String, _ key: String) throws -> [JSONValue] {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  return try #require(root["methods"]?[method]?[key]?.arrayValue, "\(method).\(key)")
}

private func params(_ frame: JSONValue) throws -> JSONObject {
  try #require(frame["params"]?.objectValue)
}

private func frame(_ method: String, _ id: String) throws -> JSONObject {
  let match = try #require(try examples(method, "frames").first { $0["id"]?.stringValue == id }, "\(id)")
  return try params(match)
}

private func reading(_ method: String, _ params: JSONObject) -> InteractiveReading {
  InteractivePrompt.read(ServerRequestBody(method: method, params: params))
}

private func prompt(_ method: String, _ params: JSONObject) throws -> InteractivePrompt {
  guard case .content(let content) = reading(method, params) else {
    throw ReadFailure()
  }

  return InteractivePrompt(id: "srq-1", content: content, chatKey: "ada", sessionID: "s", deadline: nil)
}

private struct ReadFailure: Error {}

private func fix(
  _ lat: Double = 52.373123, _ lon: Double = 4.892201, accuracy: Double = 8.5, reduced: Bool = false
) -> LocationFix {
  LocationFix(
    latitude: lat, longitude: lon, accuracyMeters: accuracy, time: Date(timeIntervalSince1970: 1_791_119_300),
    isReduced: reduced)
}

@Suite("Device requests: reading the frames", .timeLimit(.minutes(1))) @MainActor
struct DeviceFrameTests {
  @Test("every valid frame of the three methods is a prompt for its sheet, with the agent's words")
  func validFrames() throws {
    var count = 0

    for method in ["device.location", "device.contact", "device.calendar"] {
      for raw in try examples(method, "frames") {
        count += 1
        let id = raw["id"]?.stringValue ?? "?"
        let request = try prompt(method, try params(raw))
        #expect(request.method == method, "\(id)")
        #expect(request.actingUser == "Ada", "\(id)")
        #expect(request.offersSkip == (raw["params"]?["optional"]?.boolValue ?? true), "\(id)")
        #expect(!request.title.isEmpty && !request.summary.isEmpty, "\(id)")
      }
    }

    #expect(count == 9)
  }

  @Test("the location, contact and calendar frames carry what they ask")
  func readsTheBodies() throws {
    guard case .location(let approximate) = try prompt("device.location", try frame("device.location", "req_loc_approx")).body,
      case .location(let precise) = try prompt("device.location", try frame("device.location", "req_loc_precise")).body,
      case .contact(let phone) = try prompt("device.contact", try frame("device.contact", "req_contact_phone")).body,
      case .calendar(let event) = try prompt("device.calendar", try frame("device.calendar", "req_cal_event")).body,
      case .calendar(let reminder) = try prompt("device.calendar", try frame("device.calendar", "req_cal_reminder")).body,
      case .calendar(let allDay) = try prompt("device.calendar", try frame("device.calendar", "req_cal_allday")).body
    else {
      Issue.record("a frame is not the body its method names")
      return
    }

    #expect(approximate.precision == .approximate && precise.precision == .precise)
    #expect(phone.fields == [.name, .phones])

    #expect(event.kind == .event && event.item.title == "Dentist")
    #expect(event.item.location == "Tandarts Jansen, Prinsengracht 4")
    #expect(event.item.url == "https://example.com/appointments/4711" && event.item.alarmMinutes == 30)
    #expect(event.item.start == .instant(CalendarInstant(day: .init(year: 2026, month: 10, day: 12), hour: 9, minute: 30, offsetSeconds: 7_200)))
    #expect(!event.item.allDay)

    #expect(reminder.kind == .reminder && reminder.item.end == nil && reminder.item.alarmMinutes == 0)
    #expect(allDay.item.allDay && allDay.item.start == .day(CalendarDay(year: 2026, month: 11, day: 14)))
    #expect(allDay.item.end == .day(CalendarDay(year: 2026, month: 11, day: 16)))
  }

  @Test("a frame the gateway never sends is declined with not_supported_on_device, whatever layer refuses it")
  func invalidFramesAreDeclined() throws {
    var count = 0

    for method in ["device.location", "device.contact", "device.calendar"] {
      for entry in try examples(method, "invalid_frames") {
        count += 1
        let name = "\(method) \(entry["name"]?.stringValue ?? "?")"
        var invalid = try params(entry)
        invalid["session_id"] = "s"
        #expect(
          reading(method, invalid) == .cannotShow(reason: CannotShowReason.notSupportedOnDevice), "\(name)")
      }
    }

    #expect(count == 32)
  }

  @Test("another contract version is declined with unsupported_version, and a missing key with not_supported_on_device")
  func versionsAndMissingKeys() throws {
    for method in ["device.location", "device.contact", "device.calendar"] {
      let id = ["device.location": "req_loc_approx", "device.contact": "req_contact_phone", "device.calendar": "req_cal_event"][method]!
      var other = try frame(method, id)
      other["v"] = 2
      #expect(reading(method, other) == .cannotShow(reason: CannotShowReason.unsupportedVersion), "\(method)")
      other["v"] = nil
      #expect(reading(method, other) == .cannotShow(reason: CannotShowReason.unsupportedVersion), "\(method) without v")
    }

    var noItem = try frame("device.calendar", "req_cal_event")
    noItem["item"] = nil
    #expect(reading("device.calendar", noItem) == .cannotShow(reason: CannotShowReason.notSupportedOnDevice))

    var otherKind = try frame("device.calendar", "req_cal_event")
    otherKind["kind"] = "task"
    #expect(reading("device.calendar", otherKind) == .cannotShow(reason: CannotShowReason.notSupportedOnDevice))
  }

  @Test("the agent's words on a device request are cleaned like any other request's")
  func cleansTheEnvelope() throws {
    var raw = try frame("device.location", "req_loc_approx")
    raw["title"] = "Share\u{202E}gnp\u{0007} now"
    let request = try prompt("device.location", raw)
    #expect(request.title == "Sharegnp now")
  }

  @Test("the calendar item's one-line texts refuse every kind of line break, its URL every way of hiding where it goes")
  func itemRules() {
    func item(_ title: String = "T", _ more: JSONObject = [:]) -> JSONObject {
      var raw: JSONObject = ["title": .string(title)]
      raw.merge(more) { _, new in new }
      return raw
    }

    for lineBreak in ["\n", "\r", "\u{0B}", "\u{0C}", "\u{85}", "\u{2028}", "\u{2029}"] {
      #expect(CalendarItem.read(item("A\(lineBreak)B"), kind: .event) == nil, "title \(lineBreak.unicodeScalars.first!.value)")
      #expect(CalendarItem.read(item("A", ["location": .string("L\(lineBreak)M")]), kind: .event) == nil)
    }

    #expect(CalendarItem.read(item("A", ["notes": "line one\nline two"]), kind: .event)?.notes == "line one\nline two")
    #expect(CalendarItem.read(item(""), kind: .event) == nil)
    #expect(CalendarItem.read(item(String(repeating: "a", count: 120)), kind: .event) != nil)
    #expect(CalendarItem.read(item(String(repeating: "a", count: 121)), kind: .event) == nil)
    #expect(CalendarItem.read(item("A", ["notes": .string(String(repeating: "n", count: 2_001))]), kind: .event) == nil)
    #expect(CalendarItem.read(item("A", ["notes": 5]), kind: .event) == nil)
    #expect(CalendarItem.read(["notes": "no title"], kind: .event) == nil)
    #expect(CalendarItem.read(item("A", ["attendees": ["a@example.com"]]), kind: .event) == nil, "never shown in part")

    let good = [
      "https://example.com/appointments/4711", "http://example.com", "HTTPS://Example.com/x?y=1#z",
      "https://example.com/path@with-at", "https://example.com?u=a@b"
    ]

    for url in good {
      #expect(CalendarItem.isPlainWebAddress(url), "\(url)")
    }

    let bad = [
      "javascript:alert(1)", "ftp://example.com", "https://", "http://", "example.com", "https://user@example.com/",
      "https://user:pw@example.com/", "https://example.com\\evil.com", "https://example.com @x", "https://example.com/a b",
      "https://example.com/\u{202E}gpj", "https://exa\u{200B}mple.com", "https://example.com/\u{0007}",
      "https://example.com/\u{E000}", "https://example.com/\u{00A0}x", "https://@example.com/",
      "https://" + String(repeating: "a", count: 300)
    ]

    for url in bad {
      #expect(!CalendarItem.isPlainWebAddress(url), "\(url.debugDescription)")
    }
  }

  @Test("days and instants are read exactly as the contract writes them, and agree with the system's reading")
  func daysAndInstants() throws {
    #expect(CalendarDay.parse("2026-10-12") == CalendarDay(year: 2026, month: 10, day: 12))
    #expect(CalendarDay.parse("2028-02-29") != nil && CalendarDay.parse("2026-02-29") == nil)
    #expect(CalendarDay.parse("1900-02-29") == nil && CalendarDay.parse("2000-02-29") != nil)

    for bad in ["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "2026-1-01", "26-10-01", "2026/10/01", "2026-10-01 ", "٢٠٢٦-١٠-٠١", ""] {
      #expect(CalendarDay.parse(bad) == nil, "\(bad)")
    }

    for text in [
      "2026-10-12T09:30+02:00", "2026-10-12T09:30:15+02:00", "2026-01-01T00:00-08:00", "2026-12-31T23:59:59+05:30",
      "2024-02-29T12:00+00:00", "1970-01-01T00:00+00:00", "2026-03-29T02:30+01:00"
    ] {
      let instant = try #require(CalendarInstant.parse(text), "\(text)")
      let reference = ISO8601DateFormatter()
      reference.formatOptions = [.withInternetDateTime]
      let seconds = text.count == 22 ? text.prefix(16) + ":00" + text.suffix(6) : Substring(text)
      #expect(instant.date == reference.date(from: String(seconds)), "\(text)")
    }

    for bad in [
      "2026-10-12T09:30", "2026-10-12T09:30Z", "2026-10-12T07:30:00Z", "2026-10-12T09:30:00.123+02:00",
      "2026-10-12T24:00+02:00", "2026-10-12T09:60+02:00", "2026-10-12T09:30:60+02:00", "2026-10-12 09:30+02:00",
      "2026-10-12T09:30+0200", "2026-10-12T09:30+24:00", "2026-10-12T09:30+02:60", "2026-10-12", "2026-02-30T09:30+02:00",
      "2026-10-12T9:30+02:00"
    ] {
      #expect(CalendarInstant.parse(bad) == nil, "\(bad)")
    }
  }

  @Test("an alarm needs a start, an end needs a start and is not before it, a reminder has no end")
  func crossFieldRules() {
    func read(_ kind: CalendarKind, _ fields: JSONObject) -> CalendarItem? {
      var raw: JSONObject = ["title": "T"]
      raw.merge(fields) { _, new in new }
      return CalendarItem.read(raw, kind: kind)
    }

    #expect(read(.event, ["alarm_minutes": 10]) == nil)
    #expect(read(.event, ["alarm_minutes": 10, "start": "2026-10-12T09:30+02:00"]) != nil)
    #expect(read(.event, ["alarm_minutes": 40_321, "start": "2026-10-12T09:30+02:00"]) == nil)
    #expect(read(.event, ["alarm_minutes": -1, "start": "2026-10-12T09:30+02:00"]) == nil)
    #expect(read(.event, ["alarm_minutes": 1.5, "start": "2026-10-12T09:30+02:00"]) == nil)
    #expect(read(.event, ["end": "2026-10-12T10:00+02:00"]) == nil)
    #expect(read(.event, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T10:00+02:00"]) != nil, "not before")
    #expect(read(.event, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T09:59+02:00"]) == nil)
    #expect(read(.event, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T08:30+00:00"]) != nil, "across offsets: later")
    #expect(read(.event, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T08:00+00:00"]) != nil, "the same instant")
    #expect(read(.event, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T07:59+00:00"]) == nil)
    #expect(read(.reminder, ["start": "2026-10-12T10:00+02:00", "end": "2026-10-12T11:00+02:00"]) == nil)
    #expect(read(.reminder, ["start": "2026-10-12T10:00+02:00"]) != nil)

    #expect(read(.event, ["all_day": true, "start": "2026-11-14", "end": "2026-11-16"]) != nil)
    #expect(read(.event, ["all_day": true, "start": "2026-11-14", "end": "2026-11-14"]) != nil, "one day, inclusive")
    #expect(read(.event, ["all_day": true, "start": "2026-11-14", "end": "2026-11-13"]) == nil)
    #expect(read(.event, ["all_day": true, "start": "2026-11-14T00:00+01:00"]) == nil, "an instant for an all-day item")
    #expect(read(.event, ["start": "2026-11-14"]) == nil, "a date for a timed item")
    #expect(read(.event, ["all_day": "yes", "start": "2026-11-14"]) == nil)
    #expect(read(.event, ["all_day": true]) != nil && read(.event, ["all_day": true])?.start == nil)
    #expect(read(.event, ["start": .null, "end": .null])?.start == nil, "null reads as absent")
  }
}

@Suite("Device requests: the location answer", .timeLimit(.minutes(1))) @MainActor
struct DeviceLocationAnswerTests {
  @Test("a precise position keeps six decimals, an approximate one is cut to two with an accuracy of at least 1,000 m")
  func cutsToThePrecisionChosen() throws {
    let precise = try #require(SharedLocation(fix: fix(52.3731234567, 4.8922019999), chose: .precise))
    #expect(precise.precision == .precise)
    #expect(precise.latitude == 52.373123 && precise.longitude == 4.892202)
    #expect(precise.accuracyMeters == 8.5)
    #expect(precise.at == 1_791_119_300)

    let approximate = try #require(SharedLocation(fix: fix(52.3731234567, 4.8922019999), chose: .approximate))
    #expect(approximate.precision == .approximate)
    #expect(approximate.latitude == 52.37 && approximate.longitude == 4.89, "never finer than the grid, whatever the OS gave")
    #expect(approximate.accuracyMeters == 1_000)

    let wide = try #require(SharedLocation(fix: fix(accuracy: 4_200), chose: .approximate))
    #expect(wide.accuracyMeters == 4_200, "a worse accuracy is kept")

    let south = try #require(SharedLocation(fix: fix(-33.8688, 151.2093, accuracy: 35), chose: .approximate))
    #expect(south.latitude == -33.87 && south.longitude == 151.21)

    let zero = try #require(SharedLocation(fix: fix(0.001, -0.001), chose: .approximate))
    #expect(zero.latitude == 0 && zero.longitude == 0 && zero.latitude.sign == .plus && zero.longitude.sign == .plus)
  }

  @Test("a position the system reduced is approximate, whatever the person chose")
  func reducedIsApproximate() throws {
    let shared = try #require(SharedLocation(fix: fix(reduced: true), chose: .precise))
    #expect(shared.precision == .approximate)
    #expect(shared.latitude == 52.37)
  }

  @Test("what is not a position is not an answer")
  func refusesNonPositions() {
    #expect(SharedLocation(fix: fix(91, 4), chose: .precise) == nil)
    #expect(SharedLocation(fix: fix(52, 180.5), chose: .precise) == nil)
    #expect(SharedLocation(fix: fix(.nan, 4), chose: .precise) == nil)
    #expect(SharedLocation(fix: fix(52, .infinity), chose: .precise) == nil)
    #expect(SharedLocation(fix: fix(accuracy: -1), chose: .precise) == nil, "the system's negative accuracy means no fix")
    #expect(SharedLocation(fix: fix(accuracy: .nan), chose: .precise) == nil)
    #expect(SharedLocation(fix: fix(accuracy: 1e12), chose: .precise)?.accuracyMeters == 10_000_000)
    #expect(SharedLocation(fix: fix(90, -180), chose: .precise) != nil)
  }

  @Test("the contract's precise answer is what the client builds, and its other answers are ones the client may send")
  func contractAnswers() throws {
    let frames = try examples("device.location", "frames")

    for answer in try examples("device.location", "answers") {
      let name = answer["name"]?.stringValue ?? "?"
      let id = try #require(answer["request"]?.stringValue)
      let raw = try #require(frames.first { $0["id"]?.stringValue == id })
      let request = try prompt("device.location", try params(raw))
      let result = try #require(answer["result"])

      if result["status"]?.stringValue == "skipped" {
        let reply = try #require(request.reply(to: .skip), "\(name)")
        #expect(reply.result == ["status": "skipped"] && reply.summary == ["status": "skipped"])
        continue
      }

      let chosen = LocationPrecision.named(try #require(result["precision"]?.stringValue))
      let lat = try #require(result["lat"]?.doubleValue)
      let lon = try #require(result["lon"]?.doubleValue)
      let accuracy = try #require(result["accuracy_m"]?.doubleValue)
      let shared = try #require(SharedLocation(fix: fix(lat, lon, accuracy: accuracy), chose: chosen), "\(name)")
      let reply = try #require(request.reply(to: .location(shared)), "\(name)")
      #expect(reply.result["status"] == "answered" && reply.result["precision"]?.stringValue == chosen.rawValue, "\(name)")
      #expect(reply.summary == ["status": "answered", "precision": .string(chosen.rawValue)], "\(name): a coarse key only")

      if name == "precise" {
        #expect(JSONValue.object(reply.result) == result, "the precise example, exactly")
      }
    }
  }

  @Test("a precise answer for an approximate request is never sent, a skip only where it is offered")
  func neverMoreThanAsked() throws {
    let approximate = try prompt("device.location", try frame("device.location", "req_loc_approx"))
    let precise = try #require(SharedLocation(fix: fix(), chose: .precise))
    let lowered = try #require(SharedLocation(fix: fix(), chose: .approximate))
    #expect(approximate.reply(to: .location(precise)) == nil, "precision:too_precise")
    #expect(approximate.reply(to: .location(lowered)) != nil)

    let asked = try prompt("device.location", try frame("device.location", "req_loc_precise"))
    #expect(asked.reply(to: .location(precise)) != nil)
    #expect(asked.reply(to: .location(lowered)) != nil, "the person may share less")

    let required = try prompt("device.location", try frame("device.location", "req_loc_required"))
    #expect(required.reply(to: .skip) == nil, "not_optional")
    #expect(required.reply(to: .location(lowered)) != nil)

    #expect(approximate.reply(to: .calendarSaved) == nil && approximate.reply(to: .files([], text: nil)) == nil)
  }
}

// MARK: - The location model

@MainActor
private final class FakeLocation: DeviceLocationProvider {
  var outcome: LocationOutcome
  private(set) var asked: [LocationPrecision] = []
  private var held: CheckedContinuation<Void, Never>?
  var holds = false

  init(_ outcome: LocationOutcome = .fix(fix())) {
    self.outcome = outcome
  }

  func locate(precision: LocationPrecision) async -> LocationOutcome {
    asked.append(precision)

    if holds {
      await withCheckedContinuation { held = $0 }
    }

    return outcome
  }

  func release() {
    held?.resume()
    held = nil
  }
}

@Suite("Device requests: the location sheet's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveLocationModelTests {
  private func model(_ precision: LocationPrecision, _ provider: FakeLocation) -> InteractiveLocationModel {
    InteractiveLocationModel(request: DeviceLocationRequest(precision: precision), provider: provider)
  }

  @Test("the system is asked nothing until the person shares, and then for the precision chosen")
  func asksAfterShare() async throws {
    let provider = FakeLocation()
    let location = model(.precise, provider)
    #expect(provider.asked.isEmpty && location.phase == .ready && location.precision == .precise)

    location.choose(.approximate)
    #expect(location.precision == .approximate && provider.asked.isEmpty, "choosing asks nothing")

    let step = await location.share()
    #expect(provider.asked == [.approximate], "reduced accuracy at the OS level")

    guard case .answer(.location(let shared))? = step else {
      Issue.record("not a location answer: \(String(describing: step))")
      return
    }

    #expect(shared.precision == .approximate && shared.latitude == 52.37 && shared.longitude == 4.89)
    #expect(location.phase == .ready)
  }

  @Test("the person may choose less than asked and never more")
  func lowersOnly() {
    let precise = model(.precise, FakeLocation())
    #expect(precise.canChoosePrecision)
    precise.choose(.approximate)
    #expect(precise.precision == .approximate)
    precise.choose(.precise)
    #expect(precise.precision == .precise)
    precise.choose(.unknown("exact"))
    #expect(precise.precision == .precise)

    let approximate = model(.approximate, FakeLocation())
    #expect(!approximate.canChoosePrecision)
    approximate.choose(.precise)
    #expect(approximate.precision == .approximate, "never more than asked")
  }

  @Test("a precise request shared as precise asks the OS for the best and answers six decimals")
  func precise() async throws {
    let provider = FakeLocation()
    let location = model(.precise, provider)
    guard case .answer(.location(let shared))? = await location.share() else {
      Issue.record("no answer")
      return
    }

    #expect(provider.asked == [.precise])
    #expect(shared.precision == .precise && shared.latitude == 52.373123)
  }

  @Test("a refused permission is permission_denied, no position is location_unavailable")
  func refusals() async {
    let denied = model(.precise, FakeLocation(.denied))
    #expect(await denied.share() == .cannotShow(reason: CannotShowReason.permissionDenied))
    #expect(denied.phase == .ready)

    let unavailable = model(.precise, FakeLocation(.unavailable))
    #expect(await unavailable.share() == .cannotShow(reason: CannotShowReason.locationUnavailable))

    let nonsense = model(.precise, FakeLocation(.fix(fix(accuracy: -1))))
    #expect(await nonsense.share() == .cannotShow(reason: CannotShowReason.locationUnavailable))
  }

  @Test("sharing again while the position is being taken does nothing, and the choice is frozen")
  func oneAtATime() async throws {
    let provider = FakeLocation()
    provider.holds = true
    let location = model(.precise, provider)

    let first = Task { @MainActor in await location.share() }
    try await eventuallyTrue { location.isLocating }
    #expect(await location.share() == nil)
    location.choose(.approximate)
    #expect(location.precision == .precise, "not while the system is asked")
    #expect(provider.asked == [.precise])

    provider.release()
    #expect(await first.value != nil)
    #expect(!location.isLocating)
  }

  @Test("when the sheet goes while the system is asked, nothing is answered")
  func cancelledShareAnswersNothing() async throws {
    let provider = FakeLocation()
    provider.holds = true
    let location = model(.precise, provider)

    let task = Task { @MainActor in await location.share() }
    try await eventuallyTrue { location.isLocating }
    task.cancel()
    provider.release()

    #expect(await task.value == nil, "the person decided nothing: no position, no cannot_show")
    #expect(!location.isLocating)
  }

  @Test("a fix without a time is stamped with the device's clock")
  func stampsTheClock() async throws {
    var bare = fix()
    bare.time = Date(timeIntervalSince1970: 0)
    let location = InteractiveLocationModel(
      request: DeviceLocationRequest(precision: .precise), provider: FakeLocation(.fix(bare)),
      now: { Date(timeIntervalSince1970: 1_791_000_000) })
    guard case .answer(.location(let shared))? = await location.share() else {
      Issue.record("no answer")
      return
    }

    #expect(shared.at == 1_791_000_000)
  }

  @Test("the strict reading refuses a precision this build does not know")
  func readsOnlyKnownPrecisions() {
    #expect(DeviceLocationRequest.read(DeviceLocationParams(json: ["precision": "exact"])) == nil)
    #expect(DeviceLocationRequest.read(DeviceLocationParams(json: [:])) == nil)
    #expect(DeviceLocationRequest.read(DeviceLocationParams(json: ["precision": "precise"]))?.precision == .precise)
  }
}

/// Waits for `condition`, for as long as the main actor takes to get to it (`waitUntil`).
@MainActor
private func eventuallyTrue(_ condition: @MainActor () -> Bool) async throws {
  await waitUntil("the condition to hold") { condition() }
}

// MARK: - Contacts

private let bram = ContactSnapshot(
  name: "Bram de Vries",
  phones: ["+31 6 12345678", "+31 20 5551234"],
  emails: ["bram@example.com"],
  postal: ["Keizersgracht 12\n1015 CS Amsterdam\nNetherlands"],
  birthday: ContactBirthday(year: 1984, month: 3, day: 17),
  organization: "Loodgieterbedrijf De Vries"
)

@Suite("Device requests: the contact sheet's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveContactModelTests {
  private func model(_ fields: [ContactField]) -> InteractiveContactModel {
    InteractiveContactModel(request: DeviceContactRequest(fields: fields))
  }

  @Test("nothing is ticked before a contact is chosen, and then every requested field it has starts ticked")
  func ticksWhatIsThere() {
    let contact = model([.name, .phones, .birthday])
    #expect(!contact.hasChosen && contact.ticked.isEmpty && contact.answer == nil && !contact.canShare)

    contact.choose(bram)
    #expect(contact.hasChosen)
    #expect(contact.ticked == [.name, .phones, .birthday])
    #expect(contact.canShare)

    // A field the contact has nothing for is not offered, let alone ticked.
    let sparse = model([.name, .emails, .postal])
    sparse.choose(ContactSnapshot(name: "Ada"))
    #expect(sparse.ticked == [.name])
    #expect(sparse.isAvailable(.name) && !sparse.isAvailable(.emails) && !sparse.isAvailable(.postal))
    sparse.set(.emails, ticked: true)
    #expect(sparse.ticked == [.name], "a field with nothing in it cannot be ticked")
  }

  @Test("only what is ticked is in the answer, and the preview is that answer")
  func onlyTickedGoes() throws {
    let contact = model([.name, .phones])
    contact.choose(bram)
    contact.set(.name, ticked: false)

    let shared = try #require(contact.shared)
    #expect(shared.name == nil && shared.phones == ["+31 6 12345678", "+31 20 5551234"])
    #expect(shared.fields == [.phones])

    guard case .contact(let answer)? = contact.answer else {
      Issue.record("no answer")
      return
    }

    #expect(answer == shared)
    #expect(JSONValue.object(answer.card.json) == ["phones": ["+31 6 12345678", "+31 20 5551234"]], "one key, as the contract's example")

    contact.set(.phones, ticked: false)
    #expect(contact.answer == nil && !contact.canShare && contact.shared?.isEmpty == true)
    contact.set(.name, ticked: true)
    #expect(contact.shared?.fields == [.name])
  }

  @Test("a field nobody asked for is never offered, ticked or sent, even when the contact has it")
  func neverMoreThanAsked() throws {
    let contact = model([.name])
    contact.choose(bram)
    #expect(contact.ticked == [.name])
    #expect(!contact.isAvailable(.emails) || !contact.request.fields.contains(.emails))
    contact.set(.emails, ticked: true)
    contact.set(.birthday, ticked: true)
    #expect(contact.ticked == [.name])

    let shared = try #require(contact.shared)
    #expect(shared.emails.isEmpty && shared.phones.isEmpty && shared.postal.isEmpty && shared.birthday == nil && shared.organization == nil)
    #expect(JSONValue.object(shared.card.json) == ["name": "Bram de Vries"])

    // Even a hand-built answer with an extra key is refused by the client.
    var forged = shared
    forged.emails = ["bram@example.com"]
    let request = try prompt("device.contact", try frame("device.contact", "req_contact_phone"))
    #expect(request.reply(to: .contact(forged)) == nil)
  }

  @Test("wiping forgets the contact")
  func wipes() {
    let contact = model([.name])
    contact.choose(bram)
    contact.wipe()
    #expect(contact.snapshot == nil && contact.ticked.isEmpty && !contact.hasChosen && contact.shared == nil)
    contact.choose(bram)
    contact.reset()
    #expect(!contact.hasChosen)
  }

  @Test("values are cleaned, bounded and counted the way the contract says, and a phone number is never cut short")
  func bounds() {
    let many = ContactSnapshot(
      name: "  Bram\u{202E}\u{0007}  de   Vries ",
      phones: (0..<7).map { "+31 6 1234567\($0)" } + ["+31 6 1234567" + String(repeating: "0", count: 40), "", "  "],
      emails: ["a@example.com", "a@example.com", "b@example.com"],
      postal: ["A\n\n\nB", "C", "D", "E"],
      birthday: ContactBirthday(year: nil, month: 2, day: 29),
      organization: String(repeating: "o", count: 400)
    )
    let shared = SharedContact(
      snapshot: many, ticked: Set(ContactField.knownCases), requested: ContactField.knownCases)
    #expect(shared.name == "Bram de Vries")
    #expect(shared.phones.count == 5 && shared.phones.first == "+31 6 12345670")
    #expect(shared.emails == ["a@example.com", "b@example.com"], "no repeats")
    #expect(shared.postal == ["A\nB", "C", "D"], "line breaks kept, at most three")
    #expect(shared.birthday == "--02-29")
    #expect(shared.organization?.unicodeScalars.count == 200)

    let tooLong = ContactSnapshot(phones: ["+31 6 " + String(repeating: "1", count: 40)])
    #expect(SharedContact(snapshot: tooLong, ticked: [.phones], requested: [.phones]).phones.isEmpty)

    let blank = ContactSnapshot(name: "\u{200B}\u{202E}", phones: [" "], organization: "")
    #expect(SharedContact(snapshot: blank, ticked: Set(ContactField.knownCases), requested: ContactField.knownCases).isEmpty)
  }

  @Test("a birthday is a day that exists, with or without a year")
  func birthdays() {
    #expect(ContactBirthday(year: 1984, month: 3, day: 17).text == "1984-03-17")
    #expect(ContactBirthday(year: 984, month: 3, day: 7).text == "0984-03-07")
    #expect(ContactBirthday(year: nil, month: 2, day: 29).text == "--02-29")
    #expect(ContactBirthday(year: nil, month: 12, day: 1).text == "--12-01")
    #expect(ContactBirthday(year: 2026, month: 2, day: 29).text == nil)
    #expect(ContactBirthday(year: 2024, month: 2, day: 29).text == "2024-02-29")
    #expect(ContactBirthday(year: nil, month: 2, day: 30).text == nil)
    #expect(ContactBirthday(year: nil, month: 13, day: 1).text == nil)
    #expect(ContactBirthday(year: nil, month: 0, day: 1).text == nil)
    #expect(ContactBirthday(year: nil, month: 1, day: 0).text == nil)
    #expect(ContactBirthday(year: 0, month: 1, day: 1).text == nil)
    #expect(ContactBirthday(year: 10_000, month: 1, day: 1).text == nil)
  }

  @Test("the contract's valid contact answers are what the model builds from the same contact")
  func contractAnswers() throws {
    let frames = try examples("device.contact", "frames")
    let contacts: [String: ContactSnapshot] = [
      "name_and_phones": bram,
      "one_field_ticked": ContactSnapshot(name: "Bram de Vries", phones: ["+31 6 12345678"]),
      "birthday_without_year": ContactSnapshot(name: "Bram de Vries", birthday: ContactBirthday(year: nil, month: 2, day: 29)),
      "birthday_with_year": ContactSnapshot(name: "Bram de Vries", birthday: ContactBirthday(year: 1984, month: 3, day: 17)),
      "postal_address": bram
    ]

    for answer in try examples("device.contact", "answers") {
      let name = answer["name"]?.stringValue ?? "?"
      let id = try #require(answer["request"]?.stringValue)
      let raw = try #require(frames.first { $0["id"]?.stringValue == id })
      let request = try prompt("device.contact", try params(raw))
      let result = try #require(answer["result"])

      if result["status"]?.stringValue == "skipped" {
        #expect(request.reply(to: .skip)?.result == ["status": "skipped"], "\(name)")
        continue
      }

      guard case .contact(let wanted) = request.body, let snapshot = contacts[name] else {
        Issue.record("\(name): no contact")
        continue
      }

      let contact = InteractiveContactModel(request: wanted)
      contact.choose(snapshot)

      // The person unticks what the example leaves out.
      for field in wanted.fields where result["contact"]?[field.rawValue] == nil {
        contact.set(field, ticked: false)
      }

      let built = try #require(contact.answer, "\(name)")
      let reply = try #require(request.reply(to: built), "\(name)")
      #expect(JSONValue.object(reply.result) == result, "\(name)")

      let keys = result["contact"]?.objectValue?.keys.sorted() ?? []
      #expect(
        reply.summary["fields"]?.arrayValue?.compactMap(\.stringValue).sorted() == keys,
        "\(name): the summary names the fields, never a value")
      #expect(reply.summary["status"] == "answered")
      #expect(!"\(reply.summary)".contains("Bram"), "\(name): no value in the summary")
    }
  }

  @Test("the strict reading refuses an empty list, a repeat, an unknown name and seven fields")
  func readsFields() {
    func read(_ fields: JSONValue?) -> DeviceContactRequest? {
      var raw: JSONObject = [:]
      raw["fields"] = fields
      return DeviceContactRequest.read(DeviceContactParams(json: raw))
    }

    #expect(read(["name", "phones"])?.fields == [.name, .phones])
    #expect(read(["organization", "name"])?.fields == [.organization, .name], "the order asked")
    #expect(read(["name", "phones", "emails", "postal", "birthday", "organization"])?.fields.count == 6)
    #expect(read([]) == nil && read(nil) == nil && read("name") == nil)
    #expect(read(["name", "name"]) == nil)
    #expect(read(["name", "nickname"]) == nil)
    #expect(read(["name", 5]) == nil)
    #expect(read(["name", "phones", "emails", "postal", "birthday", "organization", "name"]) == nil)
  }

  @Test("a contact the system hands over becomes plain values: name, numbers, addresses, a birthday without a year")
  func snapshotFromTheSystem() {
    let contact = CNMutableContact()
    contact.givenName = "Bram"
    contact.familyName = "de Vries"
    contact.organizationName = "De Vries BV"
    contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: "+31 6 12345678"))]
    contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: "bram@example.com" as NSString)]
    let address = CNMutablePostalAddress()
    address.street = "Keizersgracht 12"
    address.postalCode = "1015 CS"
    address.city = "Amsterdam"
    contact.postalAddresses = [CNLabeledValue(label: CNLabelHome, value: address)]
    contact.birthday = DateComponents(year: 1_604, month: 2, day: 29)

    let snapshot = ContactSnapshot(contact)
    #expect(snapshot.name?.contains("Bram") == true && snapshot.name?.contains("Vries") == true)
    #expect(snapshot.phones == ["+31 6 12345678"] && snapshot.emails == ["bram@example.com"])
    #expect(snapshot.organization == "De Vries BV")
    #expect(snapshot.postal.count == 1 && snapshot.postal[0].contains("Keizersgracht 12") && snapshot.postal[0].contains("Amsterdam"))
    #expect(snapshot.birthday == ContactBirthday(year: nil, month: 2, day: 29), "1604 is the address book's no-year")

    contact.birthday = DateComponents(year: 1_984, month: 3, day: 17)
    #expect(ContactSnapshot(contact).birthday == ContactBirthday(year: 1_984, month: 3, day: 17))
    contact.birthday = DateComponents(month: 12, day: 24)
    #expect(ContactSnapshot(contact).birthday == ContactBirthday(year: nil, month: 12, day: 24))
    contact.birthday = DateComponents(year: 1_984)
    #expect(ContactSnapshot(contact).birthday == nil)

    // Only what was asked is copied out of the system's contact; the name is kept to show whom was picked.
    contact.birthday = DateComponents(year: 1_984, month: 3, day: 17)
    let minimal = ContactSnapshot(contact, requested: [.phones])
    #expect(minimal.name?.contains("Bram") == true)
    #expect(minimal.phones == ["+31 6 12345678"])
    #expect(minimal.emails.isEmpty && minimal.postal.isEmpty && minimal.birthday == nil && minimal.organization == nil)
    let nothing = ContactSnapshot(contact, requested: [])
    #expect(nothing.phones.isEmpty && nothing.emails.isEmpty && nothing.organization == nil)
  }
}

// MARK: - Calendar

@MainActor
private final class FakeCalendarStore: DeviceCalendarStore {
  var outcome: CalendarSaveOutcome
  private(set) var saved: [(CalendarItem, CalendarKind)] = []

  init(_ outcome: CalendarSaveOutcome = .saved) {
    self.outcome = outcome
  }

  func save(_ item: CalendarItem, kind: CalendarKind) async -> CalendarSaveOutcome {
    saved.append((item, kind))
    return outcome
  }
}

private func calendarRequest(_ id: String = "req_cal_event") throws -> DeviceCalendarRequest {
  guard case .calendar(let request) = try prompt("device.calendar", try frame("device.calendar", id)).body else {
    throw ReadFailure()
  }

  return request
}

@Suite("Device requests: the calendar sheet's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveCalendarModelTests {
  @Test("an event on a device with the system's edit sheet opens it, and nothing is saved by the app")
  func eventUsesTheSystemSheet() async throws {
    let store = FakeCalendarStore()
    let model = InteractiveCalendarModel(request: try calendarRequest(), store: store, hasEventEditor: true, offersSkip: true)
    #expect(model.route == .systemEditor && model.phase == .ready && !model.isBusy)

    #expect(await model.add() == nil)
    #expect(model.isEditing && model.isBusy)
    #expect(await model.add() == nil, "not twice while the sheet is up")
    #expect(store.saved.isEmpty, "the system's sheet saves, not the app")

    #expect(model.editorFinished(saved: true) == .answer(.calendarSaved))
    #expect(model.phase == .saved && model.isSaved && !model.isBusy)
    #expect(model.editorFinished(saved: true) == nil, "once")

    // The answer did not go out and Try again presses Add: only the answer, the system's sheet stays shut.
    #expect(await model.add() == .answer(.calendarSaved))
    #expect(!model.isEditing && store.saved.isEmpty)
  }

  @Test("cancelling the system's sheet is a skip, and where there is no skip the sheet is back with Add")
  func cancelling() async throws {
    let store = FakeCalendarStore()
    let optional = InteractiveCalendarModel(request: try calendarRequest(), store: store, hasEventEditor: true, offersSkip: true)
    _ = await optional.add()
    #expect(optional.editorFinished(saved: false) == .answer(.skip))

    let required = InteractiveCalendarModel(request: try calendarRequest("req_cal_allday"), store: store, hasEventEditor: true, offersSkip: false)
    _ = await required.add()
    #expect(required.editorFinished(saved: false) == nil && required.phase == .ready)
    #expect(await required.add() == nil && required.isEditing, "it can be tried again")
    #expect(required.editorFinished(saved: true) == .answer(.calendarSaved))
    #expect(store.saved.isEmpty)
  }

  @Test("a reminder, and an event where there is no edit sheet, are saved by Add after the system's access question")
  func directSave() async throws {
    let store = FakeCalendarStore()
    let reminder = InteractiveCalendarModel(request: try calendarRequest("req_cal_reminder"), store: store, hasEventEditor: true, offersSkip: true)
    #expect(reminder.route == .directSave, "there is no system sheet for a reminder")
    #expect(await reminder.add() == .answer(.calendarSaved))
    #expect(store.saved.count == 1 && store.saved[0].1 == .reminder && store.saved[0].0.title == "Renew passport")
    #expect(reminder.phase == .saved)
    #expect(await reminder.add() == .answer(.calendarSaved), "Add after a failed send answers again")
    #expect(store.saved.count == 1, "and never writes a second entry")

    let mac = InteractiveCalendarModel(request: try calendarRequest(), store: store, hasEventEditor: false, offersSkip: true)
    #expect(mac.route == .directSave)
    #expect(await mac.add() == .answer(.calendarSaved))
    #expect(store.saved.count == 2 && store.saved[1].1 == .event && store.saved[1].0.title == "Dentist")
  }

  @Test("a refused access is permission_denied; a write that failed leaves Add to try again")
  func refusalsAndFailures() async throws {
    let denied = FakeCalendarStore(.denied)
    let refused = InteractiveCalendarModel(request: try calendarRequest("req_cal_reminder"), store: denied, hasEventEditor: true, offersSkip: true)
    #expect(await refused.add() == .cannotShow(reason: CannotShowReason.permissionDenied))
    #expect(refused.phase == .ready)

    // No default calendar to save into (a Mac under write-only access): said, not tried again.
    let none = FakeCalendarStore(.noCalendar)
    let stuck = InteractiveCalendarModel(request: try calendarRequest("req_cal_event"), store: none, hasEventEditor: false, offersSkip: true)
    #expect(await stuck.add() == .cannotShow(reason: CannotShowReason.notSupportedOnDevice))
    #expect(stuck.phase == .ready && !stuck.isSaved)

    let flaky = FakeCalendarStore(.failed)
    let model = InteractiveCalendarModel(request: try calendarRequest("req_cal_reminder"), store: flaky, hasEventEditor: false, offersSkip: true)
    #expect(await model.add() == nil && model.phase == .failed && !model.isBusy)
    flaky.outcome = .saved
    #expect(await model.add() == .answer(.calendarSaved))
    #expect(flaky.saved.count == 2)
  }

  @Test("the calendar answer is done, and the transcript's summary says answered")
  func answers() throws {
    let request = try prompt("device.calendar", try frame("device.calendar", "req_cal_event"))
    let reply = try #require(request.reply(to: .calendarSaved))
    #expect(reply.result == ["status": "done"] && reply.summary == ["status": "answered"])
    #expect(request.reply(to: .skip)?.result == ["status": "skipped"])

    let required = try prompt("device.calendar", try frame("device.calendar", "req_cal_allday"))
    #expect(required.reply(to: .skip) == nil && required.reply(to: .calendarSaved) != nil)
    #expect(request.reply(to: .location(try #require(SharedLocation(fix: fix(), chose: .approximate)))) == nil)
  }
}

@Suite("Device requests: what is written to the system's calendar and reminders", .timeLimit(.minutes(1))) @MainActor
struct CalendarMappingTests {
  @Test("a timed event keeps its instant, its place, notes and link, and gets the alert before its start")
  func timedEvent() throws {
    let item = try calendarRequest().item
    let event = item.makeEvent(in: EKEventStore())
    #expect(event.title == "Dentist" && event.notes == "Bring the insurance card.")
    #expect(event.location == "Tandarts Jansen, Prinsengracht 4")
    #expect(event.url?.absoluteString == "https://example.com/appointments/4711")
    #expect(!event.isAllDay)
    #expect(event.startDate == Date(timeIntervalSince1970: 1_791_790_200), "09:30 at +02:00 is 07:30 UTC")
    #expect(event.endDate.timeIntervalSince(event.startDate) == 1_800)
    #expect(event.alarms?.count == 1 && event.alarms?.first?.relativeOffset == -1_800)
  }

  @Test("an event with only a start lasts an hour, an all-day one covers its days, and one without a time starts at the next full hour")
  func otherEvents() throws {
    let store = EKEventStore()
    let start = CalendarInstant(day: CalendarDay(year: 2026, month: 10, day: 12), hour: 9, minute: 30, offsetSeconds: 7_200)

    let open = CalendarItem(title: "T", start: .instant(start)).makeEvent(in: store)
    #expect(open.endDate.timeIntervalSince(open.startDate) == 3_600 && open.alarms?.isEmpty != false)

    let days = CalendarItem(
      title: "Trip", allDay: true, start: .day(CalendarDay(year: 2026, month: 11, day: 14)),
      end: .day(CalendarDay(year: 2026, month: 11, day: 16))
    ).makeEvent(in: store)
    let calendar = Foundation.Calendar.current
    #expect(days.isAllDay)
    #expect(calendar.dateComponents([.year, .month, .day, .hour], from: days.startDate) == DateComponents(year: 2026, month: 11, day: 14, hour: 0))
    #expect(calendar.dateComponents([.year, .month, .day], from: days.endDate) == DateComponents(year: 2026, month: 11, day: 16), "end is inclusive")

    let undated = CalendarItem(title: "Someday").makeEvent(
      in: store, now: calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 9, minute: 41))!)
    #expect(!undated.isAllDay)
    #expect(calendar.dateComponents([.hour, .minute], from: undated.startDate) == DateComponents(hour: 10, minute: 0))
    #expect(undated.endDate.timeIntervalSince(undated.startDate) == 3_600)
  }

  @Test("a reminder is due at its start, in the agent's offset, with the place in its notes and the alert before the due time")
  func reminder() throws {
    let store = EKEventStore()
    let reminder = EKReminder(eventStore: store)
    let item = CalendarItem(
      title: "Renew passport", notes: "Bring photos.", location: "Town hall", url: "https://example.com/p",
      start: .instant(CalendarInstant(day: CalendarDay(year: 2026, month: 10, day: 9), hour: 17, minute: 0, offsetSeconds: 7_200)),
      alarmMinutes: 0)
    item.apply(to: reminder)

    #expect(reminder.title == "Renew passport")
    #expect(reminder.notes == "Bring photos.\n\nTown hall", "EventKit has no place on a reminder")
    #expect(reminder.url?.absoluteString == "https://example.com/p")
    let due = try #require(reminder.dueDateComponents)
    #expect(due.year == 2026 && due.month == 10 && due.day == 9 && due.hour == 17 && due.minute == 0)
    #expect(due.timeZone?.secondsFromGMT() == 7_200)
    #expect(reminder.alarms?.count == 1 && reminder.alarms?.first?.relativeOffset == 0)

    let allDay = EKReminder(eventStore: store)
    CalendarItem(title: "Plan", allDay: true, start: .day(CalendarDay(year: 2026, month: 11, day: 1)), alarmMinutes: 60).apply(to: allDay)
    #expect(allDay.dueDateComponents?.day == 1 && allDay.dueDateComponents?.hour == nil)
    #expect(allDay.alarms?.first?.absoluteDate != nil && allDay.notes == nil)
  }
}

@Suite("Device requests: what this device offers", .timeLimit(.minutes(1))) @MainActor
struct DeviceAvailabilityTests {
  @Test("the list a device announces holds a device request only where the device offers it, in the contract's order")
  func announcesWhatItOffers() {
    let base = ["input.form", "input.file", "review.draft", "review.diff"]
    #expect(InteractiveCapabilities.deviceMethods(availability: .none) == base)
    #expect(
      InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(location: true, contact: true, calendar: true))
        == base + ["device.location", "device.contact", "device.calendar"])
    #expect(
      InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(location: false, contact: true, calendar: false))
        == base + ["device.contact"], "Location Services off: no location request")
    #expect(InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(calendar: true)) == base + ["device.calendar"])
    #expect(DeviceAvailability.none.offers("input.form") && !DeviceAvailability.none.offers("device.location"))
  }

  @Test("this device reads its own availability; the contact picker is offered on iPhone and iPad, not on the Mac")
  func systemAvailability() {
    #if os(macOS)
      let offersContact = false
    #else
      let offersContact = true
    #endif
    #expect(DeviceAvailability.system.contact == offersContact)
    #expect(InteractiveCapabilities.deviceMethods().contains("device.contact") == offersContact)
    #expect(Set(InteractiveCapabilities.deviceMethods()).isSubset(of: Set(ServerRequestBody.Method.interactive)))
  }

  @Test("the Mac's contact picker is not offered until it has been verified on a Mac")
  func macContactPicker() {
    #expect(DeviceAvailability.contactPickerOffered(onMac: false))
    #expect(!DeviceAvailability.contactPickerOffered(onMac: true))
    #expect(!DeviceAvailability.macContactPickerVerified)
    #expect(DeviceAvailability.contactPickerOffered(onMac: true, macVerified: true))
  }

  @Test("a code scan is offered with a camera AND a reader; Vision reads QR here, so the Mac has one")
  func scanNeedsACameraAndAReader() {
    #expect(DeviceAvailability.scanOffered(camera: true, reader: true))
    #expect(!DeviceAvailability.scanOffered(camera: true, reader: false))
    #expect(!DeviceAvailability.scanOffered(camera: false, reader: true))
    #expect(CodeReaders.isAvailable && CodeReaders.visionReads().contains(.qr))
  }

  @Test("the calendar is offered unless both events and reminders are restricted; on the Mac a granted store with no default calendar is not")
  func calendarGates() {
    func offered(
      _ event: EKAuthorizationStatus, _ reminder: EKAuthorizationStatus = .notDetermined, onMac: Bool = false,
      hasCalendar: Bool = true
    ) -> Bool {
      DeviceAvailability.calendarOffered(event: event, reminder: reminder, onMac: onMac, hasDefaultEventCalendar: { hasCalendar })
    }

    #expect(offered(.notDetermined) && offered(.denied) && offered(.writeOnly) && offered(.fullAccess))
    #expect(!offered(.restricted, .restricted), "nothing could ever be saved")
    #expect(offered(.restricted, .notDetermined) && offered(.notDetermined, .restricted), "the other kind still can")

    #expect(!offered(.writeOnly, onMac: true, hasCalendar: false))
    #expect(!offered(.fullAccess, onMac: true, hasCalendar: false))
    #expect(offered(.writeOnly, onMac: true, hasCalendar: true))
    #expect(offered(.notDetermined, onMac: true, hasCalendar: false), "before a grant it cannot be known")
    #expect(offered(.writeOnly, onMac: false, hasCalendar: false), "the system's edit sheet saves it elsewhere")
  }
}
