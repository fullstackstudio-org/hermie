import Foundation
import HermieCore

/// The "Needs you" inbox's and the emergency stop's sentences, from `Resources/Native.xcstrings`
/// (`native.needsYou.*`, `native.emergencyStop.*`, `native.commands.needsYou` and
/// `native.commands.stopAll`).
extension NativeStrings {
  enum NeedsYou {
    /// Needs you (the inbox's title, its toolbar item and its menu command)
    static var title: String { String(localized: "native.needsYou.title", table: "Native", bundle: .module) }
    /// Nothing is waiting for you (the empty inbox)
    static var emptyTitle: String { String(localized: "native.needsYou.empty.title", table: "Native", bundle: .module) }
    /// When a bot needs an approval, an answer or a decision, it shows up here.
    static var emptyMessage: String {
      String(localized: "native.needsYou.empty.message", table: "Native", bundle: .module)
    }
    /// {count} thing(s) waiting for you (what VoiceOver says for the toolbar item, and the list's header)
    static func count(_ count: Int) -> String {
      String(
        localized: "native.needsYou.count", defaultValue: "\(count) things waiting for you", table: "Native",
        bundle: .module)
    }
    /// Waiting (before how long: "Waiting 3 min")
    static var waiting: String { String(localized: "native.needsYou.waiting", table: "Native", bundle: .module) }
    /// Opens the chat with this request. (the hint of a row)
    static var rowHint: String { String(localized: "native.needsYou.rowHint", table: "Native", bundle: .module) }
    /// Hermie is connected to one gateway at a time. What waits on your other gateways is not listed.
    static var otherGateways: String {
      String(localized: "native.needsYou.otherGateways", table: "Native", bundle: .module)
    }
    /// Connect an account to continue (a connector card's title)
    static var connectorTitle: String {
      String(localized: "native.needsYou.connectorTitle", table: "Native", bundle: .module)
    }

    /// What kind of request a row is.
    static func kind(_ kind: NeedsYouKind) -> String {
      switch kind {
      case .approval: String(localized: "native.needsYou.kind.approval", table: "Native", bundle: .module)
      case .question: String(localized: "native.needsYou.kind.question", table: "Native", bundle: .module)
      case .secureInput: String(localized: "native.needsYou.kind.secureInput", table: "Native", bundle: .module)
      case .confirmation: String(localized: "native.needsYou.kind.confirmation", table: "Native", bundle: .module)
      case .input: String(localized: "native.needsYou.kind.input", table: "Native", bundle: .module)
      case .review: String(localized: "native.needsYou.kind.review", table: "Native", bundle: .module)
      case .device: String(localized: "native.needsYou.kind.device", table: "Native", bundle: .module)
      case .connector: String(localized: "native.needsYou.kind.connector", table: "Native", bundle: .module)
      case .other: String(localized: "native.needsYou.kind.other", table: "Native", bundle: .module)
      }
    }
  }

  enum EmergencyStop {
    /// Stop All Running Turns… (the menu command)
    static var command: String { String(localized: "native.commands.stopAll", table: "Native", bundle: .module) }
    /// Stop all (the inbox's toolbar button and the confirming button)
    static var button: String { String(localized: "native.emergencyStop.button", table: "Native", bundle: .module) }
    /// Looking for running turns… (while the gateway is asked what runs)
    static var looking: String { String(localized: "native.emergencyStop.looking", table: "Native", bundle: .module) }
    /// Stop all {count} running turns? (the question; one: "Stop the running turn?")
    static func confirmTitle(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.confirmTitle", defaultValue: "Stop all \(count) running turns?",
        table: "Native", bundle: .module)
    }
    /// Every bot is interrupted at once. What a bot has written so far is kept.
    static var confirmMessage: String {
      String(localized: "native.emergencyStop.confirmMessage", table: "Native", bundle: .module)
    }
    /// Stopping… (while the turns are interrupted)
    static var stopping: String { String(localized: "native.emergencyStop.stopping", table: "Native", bundle: .module) }
    /// Nothing is running (the summary when no turn could be stopped)
    static var idleTitle: String {
      String(localized: "native.emergencyStop.idle.title", table: "Native", bundle: .module)
    }
    /// No bot has a turn that can be stopped from here.
    static var idleMessage: String {
      String(localized: "native.emergencyStop.idle.message", table: "Native", bundle: .module)
    }
    /// Everything is stopped (the summary's title)
    static var allStopped: String {
      String(localized: "native.emergencyStop.summary.allStopped", table: "Native", bundle: .module)
    }
    /// Some turns could not be stopped (the summary's title when one failed)
    static var someFailed: String {
      String(localized: "native.emergencyStop.summary.someFailed", table: "Native", bundle: .module)
    }
    /// Stopped: {count}
    static func stoppedCount(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.summary.stopped", defaultValue: "Stopped: \(count)", table: "Native",
        bundle: .module)
    }
    /// Already finished: {count}
    static func alreadyDoneCount(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.summary.alreadyDone", defaultValue: "Already finished: \(count)",
        table: "Native", bundle: .module)
    }
    /// Could not be stopped: {count}
    static func failedCount(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.summary.failed", defaultValue: "Could not be stopped: \(count)",
        table: "Native", bundle: .module)
    }
    /// Already idle: {count} (sessions with no turn running, in the summary of a stop made in one call)
    static func alreadyIdleCount(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.summary.alreadyIdle", defaultValue: "Already idle: \(count)",
        table: "Native", bundle: .module)
    }
    /// Left running, not yours: {count} (other people's turns in shared chats)
    static func notAllowedCount(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.summary.notAllowed", defaultValue: "Left running, not yours: \(count)",
        table: "Native", bundle: .module)
    }
    /// Scheduled (cron) runs are not stopped by this.
    static var cronNote: String {
      String(localized: "native.emergencyStop.cronNote", table: "Native", bundle: .module)
    }
    /// Another session (a running turn the gateway does not say whose it is)
    static var unnamed: String { String(localized: "native.emergencyStop.unnamed", table: "Native", bundle: .module) }
    /// {count} other running turn(s) on the gateway cannot be stopped from here.
    static func unreachable(_ count: Int) -> String {
      String(
        localized: "native.emergencyStop.unreachable",
        defaultValue: "\(count) other running turns on the gateway cannot be stopped from here.", table: "Native",
        bundle: .module)
    }
    /// Not connected from here, so not touched: {names}
    static func notAsked(_ names: String) -> String {
      String(
        localized: "native.emergencyStop.notAsked", defaultValue: "Not connected from here, so not touched: \(names)",
        table: "Native", bundle: .module)
    }
    /// The gateway's list of running turns could not be read, so turns started elsewhere may still be running.
    static var incomplete: String {
      String(localized: "native.emergencyStop.incomplete", table: "Native", bundle: .module)
    }

    /// How stopping one turn went.
    static func outcome(_ outcome: StopOutcome) -> String {
      switch outcome {
      case .stopped:
        String(localized: "native.emergencyStop.outcome.stopped", table: "Native", bundle: .module)
      case .alreadyDone:
        String(localized: "native.emergencyStop.outcome.alreadyDone", table: "Native", bundle: .module)
      case .notConnected:
        String(localized: "native.emergencyStop.outcome.notConnected", table: "Native", bundle: .module)
      case .failed(let reason):
        String(
          localized: "native.emergencyStop.outcome.failed", defaultValue: "Failed: \(reason)", table: "Native",
          bundle: .module)
      }
    }
  }
}
