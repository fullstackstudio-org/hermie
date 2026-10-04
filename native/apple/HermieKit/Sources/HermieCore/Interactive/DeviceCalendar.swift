import Foundation
import HermieProtocol
import Observation

// `device.calendar` (contract/requests/README.md §11): one event or reminder the agent suggests,
// which the person saves themselves.
//
// Nothing is written until the person presses Add on this app's sheet and, for an event on iPhone
// and iPad, saves it in the system's own edit sheet (`EKEventEditViewController`: the answer is
// `done` only when that sheet saved, `skipped` otherwise). Where the system offers no event editor
// (the Mac) or there is none for the kind (a reminder), the sheet's Add is the save, after the
// system's access prompt: write-only for events, and full access to reminders, which the sheet says
// before it asks. No identifier of what was saved travels back.

// MARK: - Days and instants

/// A day of the Gregorian calendar, as the contract writes it: `YYYY-MM-DD`.
public struct CalendarDay: Sendable, Equatable, Comparable {
  public var year: Int
  public var month: Int
  public var day: Int

  public init(year: Int, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }

  /// How many days `month` of `year` has.
  public static func daysIn(month: Int, year: Int) -> Int {
    switch month {
    case 2: (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
  }

  /// `YYYY-MM-DD` exactly (ASCII digits, a day that exists, a year from 1 to 9999); `nil` otherwise.
  public static func parse(_ text: String) -> CalendarDay? {
    let bytes = Array(text.utf8)

    guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
      let year = number(bytes[0..<4]), let month = number(bytes[5..<7]), let day = number(bytes[8..<10]),
      (1...9_999).contains(year), (1...12).contains(month), (1...daysIn(month: month, year: year)).contains(day)
    else {
      return nil
    }

    return CalendarDay(year: year, month: month, day: day)
  }

  /// The value of ASCII digits, nil if any byte is not one.
  static func number(_ digits: ArraySlice<UInt8>) -> Int? {
    var value = 0

    for digit in digits {
      guard digit >= 48, digit <= 57 else {
        return nil
      }

      value = value * 10 + Int(digit - 48)
    }

    return value
  }

  /// Days since 1970-01-01 (Howard Hinnant's civil-date algorithm), so two days compare and an
  /// instant becomes a `Date` without a calendar or a locale.
  public var daysSinceEpoch: Int {
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  public static func < (lhs: CalendarDay, rhs: CalendarDay) -> Bool {
    lhs.daysSinceEpoch < rhs.daysSinceEpoch
  }
}

/// An instant with the offset the agent wrote it in: `2026-10-12T09:30+02:00` (seconds optional, no
/// `Z`, no fractions).
public struct CalendarInstant: Sendable, Equatable {
  public var day: CalendarDay
  public var hour: Int
  public var minute: Int
  public var second: Int
  /// The offset from UTC, in seconds (`+02:00` is 7,200).
  public var offsetSeconds: Int

  public init(day: CalendarDay, hour: Int, minute: Int, second: Int = 0, offsetSeconds: Int) {
    self.day = day
    self.hour = hour
    self.minute = minute
    self.second = second
    self.offsetSeconds = offsetSeconds
  }

  /// `YYYY-MM-DDTHH:MM[:SS]±HH:MM` exactly; `nil` for anything else (`Z`, no offset, a fraction, a
  /// day that does not exist, a time of 24:00).
  public static func parse(_ text: String) -> CalendarInstant? {
    let bytes = Array(text.utf8)

    guard bytes.count == 22 || bytes.count == 25, bytes[10] == UInt8(ascii: "T"),
      let day = CalendarDay.parse(String(decoding: bytes[0..<10], as: UTF8.self)),
      bytes[13] == UInt8(ascii: ":"), let hour = CalendarDay.number(bytes[11..<13]),
      let minute = CalendarDay.number(bytes[14..<16]), hour < 24, minute < 60
    else {
      return nil
    }

    var second = 0
    var cursor = 16

    if bytes.count == 25 {
      guard bytes[16] == UInt8(ascii: ":"), let value = CalendarDay.number(bytes[17..<19]), value < 60 else {
        return nil
      }

      second = value
      cursor = 19
    }

    let sign = bytes[cursor]

    guard sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-"), bytes[cursor + 3] == UInt8(ascii: ":"),
      let offsetHours = CalendarDay.number(bytes[(cursor + 1)..<(cursor + 3)]),
      let offsetMinutes = CalendarDay.number(bytes[(cursor + 4)..<(cursor + 6)]), offsetHours < 24, offsetMinutes < 60
    else {
      return nil
    }

    let offset = (offsetHours * 3_600 + offsetMinutes * 60) * (sign == UInt8(ascii: "-") ? -1 : 1)
    return CalendarInstant(day: day, hour: hour, minute: minute, second: second, offsetSeconds: offset)
  }

  /// Unix seconds.
  public var unix: Int {
    day.daysSinceEpoch * 86_400 + hour * 3_600 + minute * 60 + second - offsetSeconds
  }

  public var date: Date {
    Date(timeIntervalSince1970: TimeInterval(unix))
  }
}

/// When something starts or ends: a day (all-day items) or an instant (timed ones).
public enum CalendarMoment: Sendable, Equatable {
  case day(CalendarDay)
  case instant(CalendarInstant)
}

// MARK: - The item

/// The event or reminder of a request, read strictly: what the sheet shows and what is saved.
public struct CalendarItem: Sendable, Equatable {
  public var title: String
  public var notes: String?
  public var location: String?
  /// Shown as plain text, never opened.
  public var url: String?
  public var allDay: Bool
  public var start: CalendarMoment?
  public var end: CalendarMoment?
  /// Minutes before `start`; needs `start`.
  public var alarmMinutes: Int?

  /// The keys of the contract's `item`.
  static let knownKeys: Set<String> = [
    "title", "notes", "start", "end", "all_day", "location", "url", "alarm_minutes"
  ]

  public static let titleLimit = 120
  public static let notesLimit = 2_000
  public static let locationLimit = 200
  public static let urlLimit = 300
  public static let alarmLimit = 40_320

  public init(
    title: String, notes: String? = nil, location: String? = nil, url: String? = nil, allDay: Bool = false,
    start: CalendarMoment? = nil, end: CalendarMoment? = nil, alarmMinutes: Int? = nil
  ) {
    self.title = title
    self.notes = notes
    self.location = location
    self.url = url
    self.allDay = allDay
    self.start = start
    self.end = end
    self.alarmMinutes = alarmMinutes
  }

  /// The item of `raw`, or `nil` for one the gateway never sends: a key of the wrong type, a text
  /// over its bound or with a line break where there is one line, a URL that is not a plain
  /// `http(s)` address, a date that does not exist, a date for a timed item or an instant for an
  /// all-day one, an `end` before `start` or without one, a reminder with an `end`, an alarm without
  /// a `start`, a key this build does not know.
  public static func read(_ raw: JSONObject, kind: CalendarKind) -> CalendarItem? {
    // A key of the contract's item this build does not have is something it would drop: it says so
    // (`not_supported_on_device`) rather than show less than the agent asked (§13).
    guard raw.keys.allSatisfy(knownKeys.contains) else {
      return nil
    }

    guard let title = text(raw["title"], limit: titleLimit, oneLine: true, required: true).flatMap(\.self) else {
      return nil
    }

    guard case .ok(let notes) = optionalText(raw["notes"], limit: notesLimit, oneLine: false),
      case .ok(let location) = optionalText(raw["location"], limit: locationLimit, oneLine: true),
      case .ok(let url) = optionalText(raw["url"], limit: urlLimit, oneLine: false)
    else {
      return nil
    }

    if let url, !isPlainWebAddress(url) {
      return nil
    }

    var allDay = false

    switch raw["all_day"] {
    case nil, .null?: break
    case .bool(let value)?: allDay = value
    default: return nil
    }

    var alarm: Int?

    switch raw["alarm_minutes"] {
    case nil, .null?: break
    case .number(let value)?:
      guard let whole = Int(exactly: value), (0...alarmLimit).contains(whole) else {
        return nil
      }

      alarm = whole
    default: return nil
    }

    guard case .ok(let startText) = optionalText(raw["start"], limit: 40, oneLine: true),
      case .ok(let endText) = optionalText(raw["end"], limit: 40, oneLine: true)
    else {
      return nil
    }

    guard let start = moment(startText, allDay: allDay), let end = moment(endText, allDay: allDay) else {
      return nil
    }

    // `end` needs `start` and is not before it; a reminder has one time.
    if let last = end.value {
      guard let first = start.value, kind == .event, !isBefore(last, first) else {
        return nil
      }
    }

    if alarm != nil, start.value == nil {
      return nil
    }

    return CalendarItem(
      title: title, notes: notes, location: location, url: url, allDay: allDay, start: start.value, end: end.value,
      alarmMinutes: alarm)
  }

  /// A moment that may be absent: `nil` outside is a text that is not one.
  private struct Moment {
    var value: CalendarMoment?
  }

  /// `text` as a day (all-day) or an instant; absent stays absent, anything else that does not parse is `nil`.
  private static func moment(_ text: String?, allDay: Bool) -> Moment? {
    guard let text else {
      return Moment(value: nil)
    }

    if allDay {
      return CalendarDay.parse(text).map { Moment(value: .day($0)) }
    }

    return CalendarInstant.parse(text).map { Moment(value: .instant($0)) }
  }

  private static func isBefore(_ end: CalendarMoment, _ start: CalendarMoment) -> Bool {
    switch (end, start) {
    case (.day(let end), .day(let start)): end < start
    case (.instant(let end), .instant(let start)): end.unix < start.unix
    default: true
    }
  }

  // MARK: Text rules

  /// Whether `scalar` ends a line (CR, LF, VT, FF, NEL, U+2028, U+2029).
  static func isLineBreak(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029: true
    default: false
    }
  }

  private enum Read<Value> {
    case ok(Value?)
    case refused
  }

  /// A present key must be a string of 1 to `limit` code points (one line when asked).
  private static func text(_ value: JSONValue?, limit: Int, oneLine: Bool, required: Bool) -> String?? {
    switch value {
    case nil, .null?:
      return required ? nil : .some(nil)
    case .string(let string)?:
      let count = string.unicodeScalars.count

      guard count >= 1, count <= limit, !oneLine || !string.unicodeScalars.contains(where: isLineBreak) else {
        return nil
      }

      return .some(string)
    default:
      return nil
    }
  }

  private static func optionalText(_ value: JSONValue?, limit: Int, oneLine: Bool) -> Read<String> {
    guard let read = text(value, limit: limit, oneLine: oneLine, required: false) else {
      return .refused
    }

    return .ok(read)
  }

  /// A plain `http` or `https` address, as the contract has it: at most 300 characters, nothing
  /// that is whitespace, a control or an invisible character, no user information (`https://user@host/`
  /// is refused: no `@` before the first `/`, `?` or `#`) and no backslash there (a browser reads `\`
  /// as `/`), and something after the scheme.
  public static func isPlainWebAddress(_ text: String) -> Bool {
    let lowered = text.lowercased()
    let schemeLength: Int

    if lowered.hasPrefix("https://") {
      schemeLength = 8
    } else if lowered.hasPrefix("http://") {
      schemeLength = 7
    } else {
      return false
    }

    guard text.unicodeScalars.count <= urlLimit, text.unicodeScalars.count > schemeLength else {
      return false
    }

    for scalar in text.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .control, .format, .spaceSeparator, .lineSeparator, .paragraphSeparator, .privateUse, .unassigned,
        .surrogate:
        return false
      default:
        break
      }

      if scalar.properties.isDefaultIgnorableCodePoint || scalar.properties.isWhitespace {
        return false
      }
    }

    let rest = text.unicodeScalars.dropFirst(schemeLength)
    let authority = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }

    return !authority.isEmpty && !authority.contains("@") && !authority.contains("\\")
  }
}

/// A `device.calendar` request, read strictly (`DeviceCalendarRequest.read`).
public struct DeviceCalendarRequest: Sendable, Equatable {
  public var kind: CalendarKind
  public var item: CalendarItem

  /// `nil` for a kind this build does not know, or an item that is not wholly in the contract.
  public static func read(_ params: DeviceCalendarParams) -> DeviceCalendarRequest? {
    guard let kind = params.kind, kind == .event || kind == .reminder,
      case .object(let item)? = params.json["item"], let read = CalendarItem.read(item, kind: kind)
    else {
      return nil
    }

    return DeviceCalendarRequest(kind: kind, item: read)
  }
}

// MARK: - Saving

/// How saving an entry directly came to.
public enum CalendarSaveOutcome: Sendable, Equatable {
  /// Written.
  case saved
  /// The person (or a restriction) refused access to the calendar or reminders.
  case denied
  /// The system could not write it.
  case failed
  /// Access was given but the system has no default calendar (or Reminders list) to put it in, so
  /// the entry can never be saved here: retrying cannot help.
  case noCalendar
}

/// The system's calendar and reminders, behind a seam so the sheet's rules can be tested: the model
/// never touches EventKit.
@MainActor
public protocol DeviceCalendarStore: Sendable {
  /// Ask for the access this kind needs (write-only for an event, full for a reminder; the system's
  /// prompt comes the first time) and write `item` to the default calendar. Only called after the
  /// person pressed Add on the sheet that showed it.
  func save(_ item: CalendarItem, kind: CalendarKind) async -> CalendarSaveOutcome
}

/// The state of one `device.calendar` sheet.
@MainActor
@Observable
public final class InteractiveCalendarModel {
  /// How the entry gets written.
  public enum Route: Sendable, Equatable {
    /// The system's own edit sheet, prefilled: the person saves there, and only that is `done`.
    case systemEditor
    /// This app writes it after the system's access prompt, when Add is pressed.
    case directSave
  }

  public enum Phase: Sendable, Equatable {
    case ready
    /// The system's edit sheet is up.
    case editing
    /// Access is being asked for, or the entry written.
    case saving
    /// Writing failed; the person can press Add again.
    case failed
    /// The entry is in the system's calendar (saved by this app, or in the system's edit sheet).
    /// Only the answer to the agent is left: Add from here sends that again and never writes (or
    /// opens the system's sheet) a second time, so a failed send cannot make a duplicate.
    case saved
  }

  public let request: DeviceCalendarRequest
  public let route: Route
  public private(set) var phase = Phase.ready

  @ObservationIgnored private let store: any DeviceCalendarStore
  @ObservationIgnored private let offersSkip: Bool

  /// `hasEventEditor`: this device has the system's event edit sheet (iPhone and iPad).
  public init(
    request: DeviceCalendarRequest, store: any DeviceCalendarStore, hasEventEditor: Bool, offersSkip: Bool
  ) {
    self.request = request
    self.store = store
    self.offersSkip = offersSkip
    self.route = request.kind == .event && hasEventEditor ? .systemEditor : .directSave
  }

  /// Something is happening that must not be cut off (a system sheet is up, or an entry is written).
  public var isBusy: Bool {
    phase == .editing || phase == .saving
  }

  /// The entry is saved and only the answer is left to send.
  public var isSaved: Bool {
    phase == .saved
  }

  /// The person pressed Add. For the system editor route the sheet then presents it
  /// (`isEditing`) and reports back with `editorFinished(saved:)`; otherwise the entry is written
  /// now and the step to take is answered. Once saved, Add only gives the answer again.
  public func add() async -> DeviceStep? {
    if phase == .saved {
      return .answer(.calendarSaved)
    }

    guard phase == .ready || phase == .failed else {
      return nil
    }

    switch route {
    case .systemEditor:
      phase = .editing
      return nil
    case .directSave:
      phase = .saving
      let outcome = await store.save(request.item, kind: request.kind)

      switch outcome {
      case .saved:
        phase = .saved
        return .answer(.calendarSaved)
      case .denied:
        phase = .ready
        return .cannotShow(reason: CannotShowReason.permissionDenied)
      case .failed:
        phase = .failed
        return nil
      case .noCalendar:
        // Not a failure to try again: this device cannot save it. Said to the agent with a reason of its own.
        phase = .ready
        return .cannotShow(reason: CannotShowReason.notSupportedOnDevice)
      }
    }
  }

  /// The system edit sheet is up.
  public var isEditing: Bool {
    phase == .editing
  }

  /// The system edit sheet went away. `done` only when it saved; when it did not, the answer is
  /// `skipped` if the request offers a skip, and otherwise the sheet is back with Add (the gateway
  /// refuses a skip for a request that does not allow one).
  public func editorFinished(saved: Bool) -> DeviceStep? {
    guard phase == .editing else {
      return nil
    }

    if saved {
      phase = .saved
      return .answer(.calendarSaved)
    }

    phase = .ready
    return offersSkip ? .answer(.skip) : nil
  }
}

#if canImport(EventKit)
  import EventKit

  extension CalendarItem {
    /// How long an event with a start and no end lasts.
    static let defaultDuration: TimeInterval = 3_600

    /// A new event in `store` filled from this item, not saved: what the system edit sheet shows, and
    /// what the Mac writes. An item without a start starts at the next full hour.
    public func makeEvent(in store: EKEventStore, now: Date = Date()) -> EKEvent {
      let event = EKEvent(eventStore: store)
      apply(to: event, now: now)
      return event
    }

    func apply(to event: EKEvent, now: Date = Date()) {
      event.title = title
      event.notes = notes
      event.location = location
      event.url = url.flatMap(URL.init(string:))
      event.isAllDay = allDay

      let calendar = Calendar.current

      switch (start, end) {
      case (.day(let first)?, let last):
        let begin = Self.localDay(first, calendar)
        var finish = begin

        if case .day(let day)? = last {
          finish = Self.localDay(day, calendar)
        }

        event.startDate = begin
        event.endDate = finish
      case (.instant(let first)?, let last):
        event.startDate = first.date
        event.endDate = if case .instant(let end)? = last { end.date } else { first.date.addingTimeInterval(Self.defaultDuration) }
      case (nil, _):
        let hour = calendar.dateInterval(of: .hour, for: now)?.end ?? now
        event.isAllDay = false
        event.startDate = hour
        event.endDate = hour.addingTimeInterval(Self.defaultDuration)
      }

      for alarm in event.alarms ?? [] {
        event.removeAlarm(alarm)
      }

      if let alarmMinutes, start != nil {
        event.addAlarm(EKAlarm(relativeOffset: -TimeInterval(alarmMinutes) * 60))
      }
    }

    /// Fill a reminder from this item. EventKit has no location on a reminder, so it goes into the notes.
    func apply(to reminder: EKReminder) {
      reminder.title = title
      reminder.notes = [notes, location.map { "\($0)" }].compactMap(\.self).joined(separator: "\n\n").nilIfEmpty
      reminder.url = url.flatMap(URL.init(string:))

      switch start {
      case .day(let day)?:
        reminder.dueDateComponents = DateComponents(
          calendar: Calendar(identifier: .gregorian), year: day.year, month: day.month, day: day.day)

        if let alarmMinutes {
          let begin = Self.localDay(day, Calendar.current)
          reminder.addAlarm(EKAlarm(absoluteDate: begin.addingTimeInterval(-TimeInterval(alarmMinutes) * 60)))
        }
      case .instant(let instant)?:
        var gregorian = Calendar(identifier: .gregorian)
        let zone = TimeZone(secondsFromGMT: instant.offsetSeconds) ?? .current
        gregorian.timeZone = zone
        reminder.dueDateComponents = gregorian.dateComponents(
          in: zone, from: instant.date)

        if let alarmMinutes {
          reminder.addAlarm(EKAlarm(relativeOffset: -TimeInterval(alarmMinutes) * 60))
        }
      case nil:
        break
      }
    }

    private static func localDay(_ day: CalendarDay, _ calendar: Calendar) -> Date {
      calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day)) ?? Date()
    }
  }

  extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
  }

  /// EventKit's calendar and reminders: write-only access to events, full access to reminders, the
  /// default calendar of each, one entry per call.
  @MainActor
  public final class EventKitCalendarStore: DeviceCalendarStore {
    /// One store for the app, made on the first Add, never before.
    public static let shared = EventKitCalendarStore()

    private lazy var store = EKEventStore()

    public init() {}

    public func save(_ item: CalendarItem, kind: CalendarKind) async -> CalendarSaveOutcome {
      do {
        switch kind {
        case .event:
          guard try await store.requestWriteOnlyAccessToEvents() else {
            return .denied
          }

          // Under write-only access a Mac may hand out no default calendar: say so rather than fail again.
          guard let calendar = store.defaultCalendarForNewEvents else {
            return .noCalendar
          }

          let event = item.makeEvent(in: store)
          event.calendar = calendar
          try store.save(event, span: .thisEvent, commit: true)
        case .reminder:
          guard try await store.requestFullAccessToReminders() else {
            return .denied
          }

          guard let calendar = store.defaultCalendarForNewReminders() else {
            return .noCalendar
          }

          let reminder = EKReminder(eventStore: store)
          item.apply(to: reminder)
          reminder.calendar = calendar
          try store.save(reminder, commit: true)
        case .unknown:
          return .failed
        }

        return .saved
      } catch let error as EKError where error.code == .eventStoreNotAuthorized {
        return .denied
      } catch {
        return .failed
      }
    }
  }
#endif
