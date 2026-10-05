import Foundation
import HermieCore

/// The decision log's own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Decisions {
    /// Decision log (the Settings category, the bot settings row, the page)
    static var title: String { String(localized: "native.decisions.title", table: "Native", bundle: .module) }
    /// What you approved, denied, confirmed or entered, kept on this device only. (under the Settings category)
    static var blurb: String { String(localized: "native.decisions.blurb", table: "Native", bundle: .module) }
    /// No decisions yet. …
    static var empty: String { String(localized: "native.decisions.empty", table: "Native", bundle: .module) }
    /// Nothing matches.
    static var noMatch: String { String(localized: "native.decisions.noMatch", table: "Native", bundle: .module) }
    /// Search the log
    static var searchPrompt: String {
      String(localized: "native.decisions.searchPrompt", table: "Native", bundle: .module)
    }
    /// All bots
    static var allBots: String { String(localized: "native.decisions.allBots", table: "Native", bundle: .module) }
    /// All kinds
    static var allKinds: String { String(localized: "native.decisions.allKinds", table: "Native", bundle: .module) }
    /// Bot
    static var filterBot: String { String(localized: "native.decisions.filterBot", table: "Native", bundle: .module) }
    /// Kind
    static var filterKind: String { String(localized: "native.decisions.filterKind", table: "Native", bundle: .module) }
    /// Kept on this device only, for 90 days or 5,000 entries. …
    static var note: String { String(localized: "native.decisions.note", table: "Native", bundle: .module) }
    /// Export
    static var export: String { String(localized: "native.decisions.export", table: "Native", bundle: .module) }
    /// Export as CSV / Export as JSON
    static func exportAs(_ format: DecisionExportFormat) -> String {
      switch format {
      case .csv: String(localized: "native.decisions.exportCSV", table: "Native", bundle: .module)
      case .json: String(localized: "native.decisions.exportJSON", table: "Native", bundle: .module)
      }
    }
    /// Clear the log…
    static var clear: String { String(localized: "native.decisions.clear", table: "Native", bundle: .module) }
    /// Clear the decision log?
    static var clearTitle: String { String(localized: "native.decisions.clearTitle", table: "Native", bundle: .module) }
    /// This removes every entry from this device. It cannot be undone.
    static var clearMessage: String {
      String(localized: "native.decisions.clearMessage", table: "Native", bundle: .module)
    }
    /// Clear
    static var clearConfirm: String {
      String(localized: "native.decisions.clearConfirm", table: "Native", bundle: .module)
    }

    /// Approval, Question, Confirmation, …
    static func kind(_ kind: DecisionKind) -> String {
      switch kind {
      case .approval: String(localized: "native.decisions.kind.approval", table: "Native", bundle: .module)
      case .clarify: String(localized: "native.decisions.kind.clarify", table: "Native", bundle: .module)
      case .confirm: String(localized: "native.decisions.kind.confirm", table: "Native", bundle: .module)
      case .secure: String(localized: "native.decisions.kind.secure", table: "Native", bundle: .module)
      case .device: String(localized: "native.decisions.kind.device", table: "Native", bundle: .module)
      case .input: String(localized: "native.decisions.kind.input", table: "Native", bundle: .module)
      case .review: String(localized: "native.decisions.kind.review", table: "Native", bundle: .module)
      case .connector: String(localized: "native.decisions.kind.connector", table: "Native", bundle: .module)
      case .permissionRevoked:
        String(localized: "native.decisions.kind.permissionRevoked", table: "Native", bundle: .module)
      }
    }

    /// Allowed, Denied, Confirmed, …
    static func outcome(_ outcome: DecisionOutcome) -> String {
      switch outcome {
      case .approved: String(localized: "native.decisions.outcome.approved", table: "Native", bundle: .module)
      case .approvedSession:
        String(localized: "native.decisions.outcome.approvedSession", table: "Native", bundle: .module)
      case .approvedAlways:
        String(localized: "native.decisions.outcome.approvedAlways", table: "Native", bundle: .module)
      case .denied: String(localized: "native.decisions.outcome.denied", table: "Native", bundle: .module)
      case .answered: String(localized: "native.decisions.outcome.answered", table: "Native", bundle: .module)
      case .confirmed: String(localized: "native.decisions.outcome.confirmed", table: "Native", bundle: .module)
      case .declined: String(localized: "native.decisions.outcome.declined", table: "Native", bundle: .module)
      case .entered: String(localized: "native.decisions.outcome.entered", table: "Native", bundle: .module)
      case .shared: String(localized: "native.decisions.outcome.shared", table: "Native", bundle: .module)
      case .authorised: String(localized: "native.decisions.outcome.authorised", table: "Native", bundle: .module)
      case .skipped: String(localized: "native.decisions.outcome.skipped", table: "Native", bundle: .module)
      case .revoked: String(localized: "native.decisions.outcome.revoked", table: "Native", bundle: .module)
      }
    }

    /// Tap, Passkey, Notification, Keyboard
    static func method(_ method: DecisionMethod) -> String {
      switch method {
      case .tap: String(localized: "native.decisions.method.tap", table: "Native", bundle: .module)
      case .passkey: String(localized: "native.decisions.method.passkey", table: "Native", bundle: .module)
      case .notification:
        String(localized: "native.decisions.method.notification", table: "Native", bundle: .module)
      case .keyboard: String(localized: "native.decisions.method.keyboard", table: "Native", bundle: .module)
      }
    }

    /// What a secure, device, input or review request was about, from the request's method; nil for a method
    /// without a name here.
    static func subject(request: String) -> String? {
      switch request {
      case "secret": String(localized: "native.decisions.subject.secret", table: "Native", bundle: .module)
      case "sudo": String(localized: "native.decisions.subject.sudo", table: "Native", bundle: .module)
      case "vault.unlock_prompt":
        String(localized: "native.decisions.subject.vaultUnlock", table: "Native", bundle: .module)
      case "vault.code": String(localized: "native.decisions.subject.vaultCode", table: "Native", bundle: .module)
      case "vault.save_login":
        String(localized: "native.decisions.subject.vaultSaveLogin", table: "Native", bundle: .module)
      case "device.location": String(localized: "native.decisions.subject.location", table: "Native", bundle: .module)
      case "device.contact": String(localized: "native.decisions.subject.contact", table: "Native", bundle: .module)
      case "device.calendar": String(localized: "native.decisions.subject.calendar", table: "Native", bundle: .module)
      case "device.scan": String(localized: "native.decisions.subject.scan", table: "Native", bundle: .module)
      case "input.form": String(localized: "native.decisions.subject.form", table: "Native", bundle: .module)
      case "input.file": String(localized: "native.decisions.subject.file", table: "Native", bundle: .module)
      case "input.signature": String(localized: "native.decisions.subject.signature", table: "Native", bundle: .module)
      case "review.draft": String(localized: "native.decisions.subject.draft", table: "Native", bundle: .module)
      case "review.diff": String(localized: "native.decisions.subject.diff", table: "Native", bundle: .module)
      default: nil
      }
    }

    /// What an entry says about its request: the subject for the kinds that have one, the command or the
    /// connector's name for the others.
    static func summary(of entry: DecisionEntry) -> String? {
      guard let summary = entry.summary, !summary.isEmpty else {
        return nil
      }

      switch entry.kind {
      case .secure, .device, .input, .review: return subject(request: summary) ?? summary
      case .approval, .clarify, .confirm, .connector, .permissionRevoked: return summary
      }
    }
  }
}
