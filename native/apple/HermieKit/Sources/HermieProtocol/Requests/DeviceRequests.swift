import Foundation

// `device.location`, `device.contact` and `device.calendar` (contract/requests/README.md §9 to §11):
// the agent asks for one thing only this device has: where it is now, one picked contact, or one
// calendar entry the person saves themselves.
//
// These are the wire views, read as tolerantly as every wire type here. The strict reading, the one
// that decides whether this app can show a request at all, is `DeviceLocationRequest.read`,
// `DeviceContactRequest.read` and `DeviceCalendarRequest.read` in HermieCore: a frame the gateway
// would never send is declined rather than shown in part.

// MARK: - device.location (contract §9)

/// How exactly the agent asks for the position. The person may share less, never more.
public enum LocationPrecision: OpenStringEnum {
  case approximate, precise
  case unknown(String)

  public static let knownCases: [LocationPrecision] = [.approximate, .precise]

  public var rawValue: String {
    switch self {
    case .approximate: "approximate"
    case .precise: "precise"
    case .unknown(let raw): raw
    }
  }
}

/// `device.location` params: the envelope plus `precision`.
public struct DeviceLocationParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  public var precision: LocationPrecision? { get { json[field: "precision"] } set { json[field: "precision"] = newValue } }
}

/// `device.location` result: `{status: answered, lat, lon, accuracy_m, at, precision}` or
/// `{status: skipped}`. All numbers are JSON numbers, never text; `precision` is what was shared.
public struct DeviceLocationResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// `lat` in [-90, 90], `lon` in [-180, 180], `accuracy_m` in [0, 10,000,000] metres, `at` the
  /// client's clock in Unix seconds (at most 2^53).
  public static func answered(
    lat: Double, lon: Double, accuracyMeters: Double, at: Int, precision: LocationPrecision
  ) -> DeviceLocationResult {
    DeviceLocationResult(json: [
      "status": InputStatus.answered.jsonValue,
      "lat": .number(lat),
      "lon": .number(lon),
      "accuracy_m": .number(accuracyMeters),
      "at": .number(Double(at)),
      "precision": precision.jsonValue
    ])
  }

  /// Only for a request whose `optional` is true; otherwise the gateway refuses it (`not_optional`).
  public static var skipped: DeviceLocationResult {
    DeviceLocationResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var lat: Double? { json[field: "lat"] }
  public var lon: Double? { json[field: "lon"] }
  public var accuracyMeters: Double? { json[field: "accuracy_m"] }
  public var at: Int? { json[field: "at"] }
  public var precision: LocationPrecision? { json[field: "precision"] }
}

// MARK: - device.contact (contract §10)

/// A field of a contact the agent may ask for.
public enum ContactField: OpenStringEnum {
  case name, phones, emails, postal, birthday, organization
  case unknown(String)

  public static let knownCases: [ContactField] = [.name, .phones, .emails, .postal, .birthday, .organization]

  public var rawValue: String {
    switch self {
    case .name: "name"
    case .phones: "phones"
    case .emails: "emails"
    case .postal: "postal"
    case .birthday: "birthday"
    case .organization: "organization"
    case .unknown(let raw): raw
    }
  }
}

/// `device.contact` params: the envelope plus `fields`, 1 to 6 without repeats.
public struct DeviceContactParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  /// The fields as sent, unknown names kept; `DeviceContactRequest.read` refuses the request instead.
  public var fields: [ContactField]? { get { json[field: "fields"] } set { json[field: "fields"] = newValue } }
}

/// The contact an answer carries: only the keys the person left ticked. Every key is optional.
public struct ContactCard: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// 1 to 200 characters.
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// Up to 5 strings of 1 to 40 characters.
  public var phones: [String]? { get { json[field: "phones"] } set { json[field: "phones"] = newValue } }
  /// Up to 5 strings of 1 to 254 characters.
  public var emails: [String]? { get { json[field: "emails"] } set { json[field: "emails"] = newValue } }
  /// Up to 3 strings of 1 to 300 characters, an address per entry (line breaks allowed).
  public var postal: [String]? { get { json[field: "postal"] } set { json[field: "postal"] = newValue } }
  /// `YYYY-MM-DD`, or `--MM-DD` without a year.
  public var birthday: String? { get { json[field: "birthday"] } set { json[field: "birthday"] = newValue } }
  /// 1 to 200 characters.
  public var organization: String? { get { json[field: "organization"] } set { json[field: "organization"] = newValue } }
}

/// `device.contact` result: `{status: answered, contact}` or `{status: skipped}`.
public struct DeviceContactResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static func answered(contact: ContactCard) -> DeviceContactResult {
    DeviceContactResult(json: ["status": InputStatus.answered.jsonValue, "contact": contact.jsonValue])
  }

  public static var skipped: DeviceContactResult {
    DeviceContactResult(json: ["status": InputStatus.skipped.jsonValue])
  }

  public var status: InputStatus? { json[field: "status"] }
  public var contact: ContactCard? { json[field: "contact"] }
}

// MARK: - device.calendar (contract §11)

/// What the agent wants added.
public enum CalendarKind: OpenStringEnum {
  case event, reminder
  case unknown(String)

  public static let knownCases: [CalendarKind] = [.event, .reminder]

  public var rawValue: String {
    switch self {
    case .event: "event"
    case .reminder: "reminder"
    case .unknown(let raw): raw
    }
  }
}

/// The item of a `device.calendar` request. Dates `2026-10-12` when `all_day` (`end` inclusive),
/// else instants with an offset `2026-10-12T09:30+02:00` (seconds optional, no `Z`, no fractions).
public struct CalendarItemParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// 1 to 120 characters, one line.
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  /// 1 to 2,000 characters.
  public var notes: String? { get { json[field: "notes"] } set { json[field: "notes"] = newValue } }
  public var start: String? { get { json[field: "start"] } set { json[field: "start"] = newValue } }
  public var end: String? { get { json[field: "end"] } set { json[field: "end"] = newValue } }
  public var allDay: Bool? { get { json[field: "all_day"] } set { json[field: "all_day"] = newValue } }
  /// 1 to 200 characters, one line.
  public var location: String? { get { json[field: "location"] } set { json[field: "location"] = newValue } }
  /// `http` or `https`, at most 300 characters: SHOWN to the person, never opened.
  public var url: String? { get { json[field: "url"] } set { json[field: "url"] = newValue } }
  /// 0 to 40,320 minutes before `start`; needs `start`.
  public var alarmMinutes: Int? { get { json[field: "alarm_minutes"] } set { json[field: "alarm_minutes"] = newValue } }
}

/// `device.calendar` params: the envelope plus `kind` and `item`.
public struct DeviceCalendarParams: InteractiveRequestParams {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static let optionalByDefault = true

  public var kind: CalendarKind? { get { json[field: "kind"] } set { json[field: "kind"] = newValue } }
  public var item: CalendarItemParams? { get { json[field: "item"] } set { json[field: "item"] = newValue } }
}

/// The closed enum a `device.calendar` result starts with.
public enum CalendarStatus: OpenStringEnum {
  case done, skipped
  case unknown(String)

  public static let knownCases: [CalendarStatus] = [.done, .skipped]

  public var rawValue: String {
    switch self {
    case .done: "done"
    case .skipped: "skipped"
    case .unknown(let raw): raw
    }
  }
}

/// `device.calendar` result: `{status: done}` when the person saved, `{status: skipped}` when they
/// did not. No identifier travels back.
public struct DeviceCalendarResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public static var done: DeviceCalendarResult {
    DeviceCalendarResult(json: ["status": CalendarStatus.done.jsonValue])
  }

  public static var skipped: DeviceCalendarResult {
    DeviceCalendarResult(json: ["status": CalendarStatus.skipped.jsonValue])
  }

  public var status: CalendarStatus? { json[field: "status"] }
}

extension CannotShowReason {
  /// The device has no usable position right now (Location Services off, no fix): contract §3.
  public static let locationUnavailable = "location_unavailable"
}
