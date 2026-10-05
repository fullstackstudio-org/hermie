import Foundation
import HermieCore

/// The Permissions page's own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Permissions {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Permissions
    static var title: String { string("native.permissions.title") }
    /// What {bot} may do without asking you. The gateway keeps these approvals; Hermie lists them and takes them back.
    static func about(_ bot: String) -> String {
      String(
        localized: "native.permissions.about",
        defaultValue:
          "What \(bot) may do without asking you. The gateway keeps these approvals; Hermie lists them and takes them back.",
        table: "Native", bundle: .module)
    }
    /// Reading the approvals…
    static var loading: String { string("native.permissions.loading") }
    /// This gateway cannot list approvals.
    static var unsupported: String { string("native.permissions.unsupported") }
    /// The approvals cannot be read without a connection.
    static var offline: String { string("native.permissions.offline") }
    /// The gateway does not allow this from here.
    static var refused: String { string("native.permissions.refused") }
    /// The gateway did not answer in time.
    static var loadTimedOut: String { string("native.permissions.loadTimedOut") }
    /// No answer in time. It may have gone through: check the list.
    static var timedOut: String { string("native.permissions.timedOut") }
    /// The gateway does not serve this bot.
    static var unknownProfile: String { string("native.permissions.unknownProfile") }
    /// That session is no longer live.
    static var sessionGone: String { string("native.permissions.sessionGone") }
    /// The approvals could not be read: {reason}
    static func failed(_ reason: String) -> String {
      String(
        localized: "native.permissions.failed", defaultValue: "The approvals could not be read: \(reason)",
        table: "Native", bundle: .module)
    }
    /// That did not work: {reason}
    static func actionFailed(_ reason: String) -> String {
      String(
        localized: "native.permissions.actionFailed", defaultValue: "That did not work: \(reason)", table: "Native",
        bundle: .module)
    }
    /// That did not work.
    static var actionFailedNoReason: String { string("native.permissions.actionFailedNoReason") }

    /// Approval mode
    static var mode: String { string("native.permissions.mode") }
    /// Manual / Smart / Off, or the gateway's own word for a mode this build does not know.
    static func modeName(_ mode: ApprovalMode) -> String {
      switch mode {
      case .manual: string("native.permissions.mode.manual")
      case .smart: string("native.permissions.mode.smart")
      case .off: string("native.permissions.mode.off")
      case .other(let name): name
      }
    }
    /// What the mode means for a dangerous command.
    static func modeNote(_ mode: ApprovalMode) -> String {
      switch mode {
      case .manual: string("native.permissions.mode.manualNote")
      case .smart: string("native.permissions.mode.smartNote")
      case .off: string("native.permissions.mode.offNote")
      case .other: string("native.permissions.mode.otherNote")
      }
    }
    /// The mode is set in the gateway's configuration, not here.
    static var modeFooter: String { string("native.permissions.mode.footer") }

    /// Always allowed
    static var always: String { string("native.permissions.always") }
    /// Allowed in every chat of {bot} until you revoke them.
    static func alwaysNote(_ bot: String) -> String {
      String(
        localized: "native.permissions.alwaysNote",
        defaultValue: "Allowed in every chat of \(bot) until you revoke them.", table: "Native", bundle: .module)
    }
    /// Nothing is always allowed.
    static var alwaysEmpty: String { string("native.permissions.alwaysEmpty") }

    /// Revoke
    static var revoke: String { string("native.permissions.revoke") }
    /// Revoke all
    static var revokeAll: String { string("native.permissions.revokeAll") }
    /// Revoke “{label}”?
    static func revokeTitle(_ label: String) -> String {
      String(
        localized: "native.permissions.revokeTitle", defaultValue: "Revoke “\(label)”?", table: "Native",
        bundle: .module)
    }
    /// {bot} will ask again the next time it needs this.
    static func revokeMessage(_ bot: String) -> String {
      String(
        localized: "native.permissions.revokeMessage",
        defaultValue: "\(bot) will ask again the next time it needs this.", table: "Native", bundle: .module)
    }
    /// Revoke every always-allowed approval?
    static var revokeAllTitle: String { string("native.permissions.revokeAllTitle") }
    /// {bot} will ask again for each one.
    static func revokeAllMessage(_ bot: String) -> String {
      String(
        localized: "native.permissions.revokeAllMessage", defaultValue: "\(bot) will ask again for each one.",
        table: "Native", bundle: .module)
    }
    /// Revoke every approval of this session?
    static var revokeAllSessionTitle: String { string("native.permissions.revokeAllSessionTitle") }
    /// {bot} will ask again in this session.
    static func revokeSessionMessage(_ bot: String) -> String {
      String(
        localized: "native.permissions.revokeSessionMessage", defaultValue: "\(bot) will ask again in this session.",
        table: "Native", bundle: .module)
    }

    /// This session
    static var sessionThis: String { string("native.permissions.sessionThis") }
    /// Another session ({number})
    static func sessionOther(_ number: Int) -> String {
      String(
        localized: "native.permissions.sessionOther", defaultValue: "Another session (\(number))", table: "Native",
        bundle: .module)
    }
    /// Session approvals end when the session is closed.
    static var sessionsFooter: String { string("native.permissions.sessionsFooter") }
    /// No live session holds an approval.
    static var sessionsEmpty: String { string("native.permissions.sessionsEmpty") }
    /// No approvals for this session.
    static var sessionEmpty: String { string("native.permissions.sessionEmpty") }
    /// YOLO
    static var yolo: String { string("native.permissions.yolo") }
    /// On
    static var on: String { string("native.permissions.on") }
    /// Off
    static var off: String { string("native.permissions.off") }
    /// YOLO skips every approval in this session. Turn it off in the chat's options.
    static var yoloNote: String { string("native.permissions.yoloNote") }
    /// Content-security finding
    static var tirith: String { string("native.permissions.tirith") }

    /// A revoke applies on this gateway at once. Other Hermes processes on the same profile follow on their next reload.
    static var scopeNote: String { string("native.permissions.scopeNote") }
  }
}

/// How a failed read or revoke is worded on the Permissions page.
enum PermissionWords {
  static func load(_ failure: PermissionFailure) -> String {
    switch failure {
    case .unsupported: NativeStrings.Permissions.unsupported
    case .offline: NativeStrings.Permissions.offline
    case .timedOut: NativeStrings.Permissions.loadTimedOut
    case .refused: NativeStrings.Permissions.refused
    case .unknownProfile: NativeStrings.Permissions.unknownProfile
    case .sessionGone: NativeStrings.Permissions.sessionGone
    case .failed(let reason):
      reason.isEmpty ? NativeStrings.Permissions.unsupported : NativeStrings.Permissions.failed(reason)
    }
  }

  static func action(_ failure: PermissionFailure) -> String {
    switch failure {
    case .unsupported: NativeStrings.Permissions.unsupported
    case .offline: NativeStrings.Permissions.offline
    case .timedOut: NativeStrings.Permissions.timedOut
    case .refused: NativeStrings.Permissions.refused
    case .unknownProfile: NativeStrings.Permissions.unknownProfile
    case .sessionGone: NativeStrings.Permissions.sessionGone
    case .failed(let reason):
      reason.isEmpty ? NativeStrings.Permissions.actionFailedNoReason : NativeStrings.Permissions.actionFailed(reason)
    }
  }
}
