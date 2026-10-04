import Foundation
import Testing

@testable import HermieProtocol

/// `device.location`, `device.contact` and `device.calendar` of `contract/requests/` (§9 to §11): every
/// valid frame reads into its typed params and re-encodes unchanged, and every valid answer is what the
/// typed constructors build.
@Suite("Device requests contract") struct DeviceRequestsContractTests {
  static func frame(_ method: String, id: String) throws -> ServerRequest {
    try InteractiveContractTests.frame(method, id: id)
  }

  static func section(_ method: String, _ key: String) throws -> [JSONValue] {
    try InteractiveContractTests.section(method, key)
  }

  // MARK: Frames

  @Test("the location frames read their precision, and the lowered one is still an approximate answer")
  func locationFrames() throws {
    guard case .deviceLocation(let approximate) = try Self.frame("device.location", id: "req_loc_approx").body,
      case .deviceLocation(let precise) = try Self.frame("device.location", id: "req_loc_precise").body,
      case .deviceLocation(let required) = try Self.frame("device.location", id: "req_loc_required").body
    else {
      Issue.record("not device.location")
      return
    }

    #expect(approximate.precision == .approximate && precise.precision == .precise)
    #expect(approximate.offersSkip && precise.offersSkip && !required.offersSkip)
    #expect(LocationPrecision.knownCases.map(\.rawValue) == ["approximate", "precise"])
    #expect(LocationPrecision.named("exact") == .unknown("exact"))
    #expect(DeviceLocationParams(json: [:]).precision == nil)
    #expect(DeviceLocationParams.optionalByDefault)
  }

  @Test("the contact frames read their fields in the order they were asked")
  func contactFrames() throws {
    guard case .deviceContact(let phone) = try Self.frame("device.contact", id: "req_contact_phone").body,
      case .deviceContact(let birthday) = try Self.frame("device.contact", id: "req_contact_birthday").body,
      case .deviceContact(let required) = try Self.frame("device.contact", id: "req_contact_required").body
    else {
      Issue.record("not device.contact")
      return
    }

    #expect(phone.fields == [.name, .phones] && birthday.fields == [.name, .birthday])
    #expect(required.fields == [.name, .postal] && !required.offersSkip)
    #expect(ContactField.knownCases.map(\.rawValue) == ["name", "phones", "emails", "postal", "birthday", "organization"])
    #expect(ContactField.named("nickname") == .unknown("nickname"))
    #expect(DeviceContactParams(json: ["fields": ["name", "nickname"]]).fields == [.name, .unknown("nickname")])
  }

  @Test("the calendar frames read the kind and every key of the item")
  func calendarFrames() throws {
    guard case .deviceCalendar(let event) = try Self.frame("device.calendar", id: "req_cal_event").body,
      case .deviceCalendar(let reminder) = try Self.frame("device.calendar", id: "req_cal_reminder").body,
      case .deviceCalendar(let allDay) = try Self.frame("device.calendar", id: "req_cal_allday").body
    else {
      Issue.record("not device.calendar")
      return
    }

    #expect(event.kind == .event && reminder.kind == .reminder && allDay.kind == .event)
    #expect(event.item?.title == "Dentist" && event.item?.notes == "Bring the insurance card.")
    #expect(event.item?.start == "2026-10-12T09:30+02:00" && event.item?.end == "2026-10-12T10:00+02:00")
    #expect(event.item?.location == "Tandarts Jansen, Prinsengracht 4")
    #expect(event.item?.url == "https://example.com/appointments/4711" && event.item?.alarmMinutes == 30)
    #expect(event.item?.allDay == nil)
    #expect(reminder.item?.start == "2026-10-09T17:00+02:00" && reminder.item?.alarmMinutes == 0)
    #expect(allDay.item?.allDay == true && allDay.item?.start == "2026-11-14" && allDay.item?.end == "2026-11-16")
    #expect(!allDay.offersSkip)
    #expect(CalendarKind.named("task") == .unknown("task"))
  }

  // MARK: Answers

  @Test("every valid location answer is what the typed constructor builds")
  func locationAnswers() throws {
    let answers = try Self.section("device.location", "answers")
    #expect(answers.count == 5)

    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")

      if result["status"]?.stringValue == "skipped" {
        #expect(try canonical(DeviceLocationResult.skipped) == canonical(result), "\(name)")
        continue
      }

      let built = DeviceLocationResult.answered(
        lat: try #require(result["lat"]?.doubleValue),
        lon: try #require(result["lon"]?.doubleValue),
        accuracyMeters: try #require(result["accuracy_m"]?.doubleValue),
        at: try #require(result["at"]?.intValue),
        precision: LocationPrecision.named(try #require(result["precision"]?.stringValue)))
      #expect(try canonical(built) == canonical(result), "\(name)")

      let reread = try #require(DeviceLocationResult(jsonValue: result), "\(name)")
      #expect(reread.status == .answered && reread.lat == built.lat && reread.lon == built.lon, "\(name)")
      #expect(reread.accuracyMeters == built.accuracyMeters && reread.at == built.at && reread.precision == built.precision)
    }
  }

  @Test("a location answer's numbers are JSON numbers, never text")
  func locationNumbers() throws {
    let built = DeviceLocationResult.answered(lat: -33.8688, lon: 151.2093, accuracyMeters: 35, at: 1_791_119_300, precision: .approximate)
    #expect(built.json["lat"] == .number(-33.8688) && built.json["at"] == .number(1_791_119_300))
    #expect(
      try canonical(built)
        == #"{"accuracy_m":35,"at":1791119300,"lat":-33.8688,"lon":151.2093,"precision":"approximate","status":"answered"}"#)
    #expect(DeviceLocationResult(json: ["lat": "52.3"]).lat == nil)
  }

  @Test("every valid contact answer is what the typed constructor builds, and only carries keys of the contract")
  func contactAnswers() throws {
    let answers = try Self.section("device.contact", "answers")
    #expect(answers.count == 6)

    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")

      if result["status"]?.stringValue == "skipped" {
        #expect(try canonical(DeviceContactResult.skipped) == canonical(result), "\(name)")
        continue
      }

      let raw = try #require(result["contact"], "\(name)")
      var card = ContactCard()
      card.name = raw["name"]?.stringValue
      card.phones = raw["phones"]?.arrayValue?.compactMap(\.stringValue)
      card.emails = raw["emails"]?.arrayValue?.compactMap(\.stringValue)
      card.postal = raw["postal"]?.arrayValue?.compactMap(\.stringValue)
      card.birthday = raw["birthday"]?.stringValue
      card.organization = raw["organization"]?.stringValue
      #expect(try canonical(DeviceContactResult.answered(contact: card)) == canonical(result), "\(name)")
      #expect(DeviceContactResult(jsonValue: result)?.contact == card, "\(name)")
    }
  }

  @Test("every valid calendar answer is done or skipped, and carries nothing else")
  func calendarAnswers() throws {
    let answers = try Self.section("device.calendar", "answers")
    #expect(answers.count == 3)

    for answer in answers {
      let name = answer["name"]?.stringValue ?? "?"
      let result = try #require(answer["result"], "\(name)")
      let built = result["status"]?.stringValue == "done" ? DeviceCalendarResult.done : .skipped
      #expect(try canonical(built) == canonical(result), "\(name)")
      #expect(DeviceCalendarResult(jsonValue: result)?.status == built.status, "\(name)")
    }

    #expect(CalendarStatus.knownCases.map(\.rawValue) == ["done", "skipped"])
    #expect(DeviceCalendarResult.done.json == ["status": "done"])
  }

  @Test("the device.* refusals the client may send are the contract's")
  func cannotShowReasons() throws {
    let reasons = try #require(try InteractiveContractTests.examples()["errors"]?.arrayValue)
      .compactMap { $0["frame"]?["error"]?["data"]?["reason"]?.stringValue }
    #expect(reasons.contains(CannotShowReason.permissionDenied))
    #expect(reasons.contains(CannotShowReason.locationUnavailable))
    #expect(CannotShowReason.locationUnavailable == "location_unavailable")
  }

  // MARK: Typed copies (a key without a typed property shows up as a difference)

  static func copy(_ params: DeviceLocationParams) -> DeviceLocationParams {
    with(DeviceLocationParams()) {
      InteractiveContractTests.envelope(params, into: &$0)
      $0.precision = params.precision
    }
  }

  static func copy(_ params: DeviceContactParams) -> DeviceContactParams {
    with(DeviceContactParams()) {
      InteractiveContractTests.envelope(params, into: &$0)
      $0.fields = params.fields
    }
  }

  static func copy(_ params: DeviceCalendarParams) -> DeviceCalendarParams {
    with(DeviceCalendarParams()) {
      InteractiveContractTests.envelope(params, into: &$0)
      $0.kind = params.kind
      $0.item = params.item.map { item in
        with(CalendarItemParams()) {
          $0.title = item.title
          $0.notes = item.notes
          $0.start = item.start
          $0.end = item.end
          $0.allDay = item.allDay
          $0.location = item.location
          $0.url = item.url
          $0.alarmMinutes = item.alarmMinutes
        }
      }
    }
  }
}
