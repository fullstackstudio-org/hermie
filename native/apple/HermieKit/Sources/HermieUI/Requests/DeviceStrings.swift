import Foundation
import HermieProtocol

/// The app's own words for the device requests (`device.location`, `device.contact`,
/// `device.calendar`): the sheets' chrome and buttons, the notices and the transcript cards. Never
/// what the agent says: that is shown verbatim and marked as the agent's. The strings live in
/// `Native.xcstrings`, next to the other interactive ones.
extension NativeStrings.Interactive {
  // MARK: Titles

  /// {bot} asks for your location
  static func titleLocation(_ bot: String) -> String {
    String(
      localized: "native.interactive.title.location", defaultValue: "\(bot) asks for your location", table: "Native",
      bundle: .module)
  }
  /// {bot} asks you to share a contact
  static func titleContact(_ bot: String) -> String {
    String(
      localized: "native.interactive.title.contact", defaultValue: "\(bot) asks you to share a contact",
      table: "Native", bundle: .module)
  }
  /// {bot} suggests an event for your calendar
  static func titleCalendarEvent(_ bot: String) -> String {
    String(
      localized: "native.interactive.title.calendarEvent",
      defaultValue: "\(bot) suggests an event for your calendar", table: "Native", bundle: .module)
  }
  /// {bot} suggests a reminder
  static func titleCalendarReminder(_ bot: String) -> String {
    String(
      localized: "native.interactive.title.calendarReminder", defaultValue: "\(bot) suggests a reminder",
      table: "Native", bundle: .module)
  }

  // MARK: Notices

  /// Hermie is not allowed to do that on this device, so it told {bot} it could not.
  static func permissionDenied(_ bot: String) -> String {
    String(
      localized: "native.interactive.notice.permissionDenied",
      defaultValue:
        "Hermie is not allowed to do that on this device, so it told \(bot) it could not. You can change this in your device’s settings.",
      table: "Native", bundle: .module)
  }
  /// Hermie could not find your location and told {bot} so.
  static func locationUnavailable(_ bot: String) -> String {
    String(
      localized: "native.interactive.notice.locationUnavailable",
      defaultValue: "Hermie could not find your location and told \(bot) so.", table: "Native", bundle: .module)
  }

  /// The chat's line for a request this app could not show, by the machine reason it told the bot.
  static func cannotShowNotice(reason: String, bot: String) -> String? {
    switch reason {
    case CannotShowReason.permissionDenied: permissionDenied(bot)
    case CannotShowReason.locationUnavailable: locationUnavailable(bot)
    default: nil
    }
  }

  // MARK: Location

  enum Location {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// What will be shared
    static var heading: String { string("native.interactive.location.heading") }
    /// Your approximate location
    static var approximate: String { string("native.interactive.location.approximate") }
    /// Roughly the area you are in, about a kilometre or more.
    static var approximateDetail: String { string("native.interactive.location.approximateDetail") }
    /// Your precise location
    static var precise: String { string("native.interactive.location.precise") }
    /// Your position as exactly as this device can tell.
    static var preciseDetail: String { string("native.interactive.location.preciseDetail") }
    /// Precision
    static var precisionLabel: String { string("native.interactive.location.precisionLabel") }
    /// Precise
    static var optionPrecise: String { string("native.interactive.location.optionPrecise") }
    /// Approximate
    static var optionApproximate: String { string("native.interactive.location.optionApproximate") }
    /// You can share less than was asked, never more.
    static var lowerNote: String { string("native.interactive.location.lowerNote") }
    /// One reading, now. Hermie does not keep tracking you.
    static var oneFix: String { string("native.interactive.location.oneFix") }
    /// The system asks for permission only after you choose to share.
    static var permissionNote: String { string("native.interactive.location.permissionNote") }
    /// Share location
    static var share: String { string("native.interactive.location.share") }
    /// Finding your location…
    static var locating: String { string("native.interactive.location.locating") }
    /// The system may ask for permission next.
    static var shareHint: String { string("native.interactive.location.shareHint") }

    /// What a precision shares, in a heading.
    static func shares(_ precision: LocationPrecision) -> String {
      precision == .precise ? precise : approximate
    }

    /// What a precision shares, in a sentence.
    static func detail(_ precision: LocationPrecision) -> String {
      precision == .precise ? preciseDetail : approximateDetail
    }
  }

  // MARK: Contact

  enum Contact {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Choose a contact
    static var choose: String { string("native.interactive.contact.choose") }
    /// Choose another contact
    static var chooseAnother: String { string("native.interactive.contact.chooseAnother") }
    /// You pick one contact in the system's own picker…
    static var pickerNote: String { string("native.interactive.contact.pickerNote") }
    /// Chosen: {name}
    static func chosen(_ name: String) -> String {
      String(
        localized: "native.interactive.contact.chosen", defaultValue: "Chosen: \(name)", table: "Native",
        bundle: .module)
    }
    /// Contact without a name
    static var unnamed: String { string("native.interactive.contact.unnamed") }
    /// What to share
    static var fieldsHeading: String { string("native.interactive.contact.fieldsHeading") }
    /// Not on this contact
    static var notOnContact: String { string("native.interactive.contact.notOnContact") }
    /// This will be sent
    static var previewHeading: String { string("native.interactive.contact.previewHeading") }
    /// Tick at least one field to share.
    static var nothingTicked: String { string("native.interactive.contact.nothingTicked") }
    /// Share
    static var share: String { string("native.interactive.contact.share") }

    /// The name of a contact field.
    static func field(_ field: ContactField) -> String {
      switch field {
      case .name: string("native.interactive.contact.field.name")
      case .phones: string("native.interactive.contact.field.phones")
      case .emails: string("native.interactive.contact.field.emails")
      case .postal: string("native.interactive.contact.field.postal")
      case .birthday: string("native.interactive.contact.field.birthday")
      case .organization: string("native.interactive.contact.field.organization")
      case .unknown(let raw): raw
      }
    }
  }

  // MARK: Calendar

  enum Calendar {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Event
    static var kindEvent: String { string("native.interactive.calendar.kindEvent") }
    /// Reminder
    static var kindReminder: String { string("native.interactive.calendar.kindReminder") }
    /// When
    static var when: String { string("native.interactive.calendar.when") }
    /// Where
    static var `where`: String { string("native.interactive.calendar.where") }
    /// Link (shown, never opened)
    static var link: String { string("native.interactive.calendar.link") }
    /// Notes
    static var notes: String { string("native.interactive.calendar.notes") }
    /// Alert
    static var alert: String { string("native.interactive.calendar.alert") }
    /// All day
    static var allDay: String { string("native.interactive.calendar.allDay") }
    /// No time given: it will start at the next full hour.
    static var noTimeEvent: String { string("native.interactive.calendar.noTimeEvent") }
    /// No time given.
    static var noTimeReminder: String { string("native.interactive.calendar.noTimeReminder") }
    /// At the time
    static var alertAtStart: String { string("native.interactive.calendar.alertAtStart") }
    /// {duration} before
    static func alertBefore(_ duration: String) -> String {
      String(
        localized: "native.interactive.calendar.alertBefore", defaultValue: "\(duration) before", table: "Native",
        bundle: .module)
    }
    /// Add to calendar
    static var addEvent: String { string("native.interactive.calendar.addEvent") }
    /// Add reminder
    static var addReminder: String { string("native.interactive.calendar.addReminder") }
    /// Nothing is added until you save it in the system's calendar sheet that opens next.
    static var noteEditor: String { string("native.interactive.calendar.noteEditor") }
    /// Add saves this to your default calendar…
    static var noteDirectEvent: String { string("native.interactive.calendar.noteDirectEvent") }
    /// Add saves this to your default Reminders list…
    static var noteReminder: String { string("native.interactive.calendar.noteReminder") }
    /// Saving…
    static var saving: String { string("native.interactive.calendar.saving") }
    /// It could not be saved. Try again.
    static var failed: String { string("native.interactive.calendar.failed") }
    /// It was not saved. Add it again, or choose not to share.
    static var notSaved: String { string("native.interactive.calendar.notSaved") }
    /// It is saved. Only the answer to the agent did not go out: Try again sends that, it does not add it again.
    static var savedNotSent: String { string("native.interactive.calendar.savedNotSent") }
  }
}

extension NativeStrings.Interactive.Card {
  private static func string(_ key: String.LocalizationValue) -> String {
    String(localized: key, table: "Native", bundle: .module)
  }

  /// Location
  static var location: String { string("native.interactive.card.location") }
  /// Contact
  static var contact: String { string("native.interactive.card.contact") }
  /// Calendar
  static var calendar: String { string("native.interactive.card.calendar") }
  /// Shared approximate location
  static var sharedApproximate: String { string("native.interactive.card.sharedApproximate") }
  /// Shared precise location
  static var sharedPrecise: String { string("native.interactive.card.sharedPrecise") }
  /// Shared a contact
  static var sharedContactBare: String { string("native.interactive.card.sharedContactBare") }
  /// Added to calendar
  static var addedToCalendar: String { string("native.interactive.card.addedToCalendar") }
  /// Shared contact: {fields}
  static func sharedContact(_ fields: String) -> String {
    String(
      localized: "native.interactive.card.sharedContact", defaultValue: "Shared contact: \(fields)", table: "Native",
      bundle: .module)
  }
}
