import Foundation
import HermieCore

/// The Crons and Activity screens' own sentences, from `Resources/Native.xcstrings`. What the Expo app
/// says in the same words (titles, the editor's labels, the confirmations, the relative times) is read
/// from the shared catalogue through `Strings.Cron` and `Strings.App.Activity`.
extension NativeStrings {
  enum Cron {
    /// Every {count} minute(s)
    static func everyMinutes(_ count: Int) -> String {
      String(localized: "native.cron.schedule.everyMinutes", defaultValue: "Every \(count) minutes", table: "Native", bundle: .module)
    }
    /// Every {count} hour(s)
    static func everyHours(_ count: Int) -> String {
      String(localized: "native.cron.schedule.everyHours", defaultValue: "Every \(count) hours", table: "Native", bundle: .module)
    }
    /// Every {count} day(s)
    static func everyDays(_ count: Int) -> String {
      String(localized: "native.cron.schedule.everyDays", defaultValue: "Every \(count) days", table: "Native", bundle: .module)
    }
    /// Once, in {delay}
    static func onceIn(_ delay: String) -> String {
      String(localized: "native.cron.schedule.onceIn", defaultValue: "Once, in \(delay)", table: "Native", bundle: .module)
    }
    /// Once, at {when}
    static func onceAt(_ when: String) -> String {
      String(localized: "native.cron.schedule.onceAt", defaultValue: "Once, at \(when)", table: "Native", bundle: .module)
    }
    /// Every day at {time}
    static func dailyAt(_ time: String) -> String {
      String(localized: "native.cron.schedule.dailyAt", defaultValue: "Every day at \(time)", table: "Native", bundle: .module)
    }
    /// Weekdays at {time}
    static func weekdaysAt(_ time: String) -> String {
      String(localized: "native.cron.schedule.weekdaysAt", defaultValue: "Weekdays at \(time)", table: "Native", bundle: .module)
    }
    /// Weekends at {time}
    static func weekendsAt(_ time: String) -> String {
      String(localized: "native.cron.schedule.weekendsAt", defaultValue: "Weekends at \(time)", table: "Native", bundle: .module)
    }
    /// {days} at {time}
    static func daysAt(_ days: String, _ time: String) -> String {
      String(localized: "native.cron.schedule.daysAt", defaultValue: "\(days) at \(time)", table: "Native", bundle: .module)
    }

    /// The name of a cron expression's field, in "The {field} field does not accept …".
    static func field(_ field: CronField) -> String {
      switch field {
      case .minute: String(localized: "native.cron.field.minute", table: "Native", bundle: .module)
      case .hour: String(localized: "native.cron.field.hour", table: "Native", bundle: .module)
      case .dayOfMonth: String(localized: "native.cron.field.dayOfMonth", table: "Native", bundle: .module)
      case .month: String(localized: "native.cron.field.month", table: "Native", bundle: .module)
      case .dayOfWeek: String(localized: "native.cron.field.dayOfWeek", table: "Native", bundle: .module)
      }
    }
  }

  enum ActivityStatus {
    /// Replied
    static var replied: String { String(localized: "native.activity.status.replied", table: "Native", bundle: .module) }
    /// Sending
    static var sending: String { String(localized: "native.activity.status.sending", table: "Native", bundle: .module) }
    /// Queued
    static var queued: String { String(localized: "native.activity.status.queued", table: "Native", bundle: .module) }
    /// Sent
    static var sent: String { String(localized: "native.activity.status.sent", table: "Native", bundle: .module) }
    /// Ambiguous target
    static var ambiguous: String { String(localized: "native.activity.status.ambiguous", table: "Native", bundle: .module) }
  }
}
