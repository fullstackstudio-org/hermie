import Foundation
import HermieCore
import HermieTranscript

/// The agents bar's own sentences, from `Resources/Native.xcstrings`. What the Expo app says in the same
/// words (the title, Steer, Stop, the statuses, the notices) is read from the shared catalogue through
/// `Strings.Chat.Subagents`.
extension NativeStrings {
  enum Subagents {
    /// Opens the list of agents, where each can be steered or stopped. (the bar's hint)
    static var barHint: String { String(localized: "native.subagents.barHint", table: "Native", bundle: .module) }
    /// Steer {goal} (what VoiceOver says for a row's Steer button)
    static func steerFor(_ goal: String) -> String {
      String(localized: "native.subagents.steerFor", defaultValue: "Steer \(goal)", table: "Native", bundle: .module)
    }
    /// Stop {goal}
    static func stopFor(_ goal: String) -> String {
      String(localized: "native.subagents.stopFor", defaultValue: "Stop \(goal)", table: "Native", bundle: .module)
    }
    /// Open the transcript of {goal}
    static func transcriptFor(_ goal: String) -> String {
      String(
        localized: "native.subagents.transcriptFor", defaultValue: "Open the transcript of \(goal)", table: "Native",
        bundle: .module)
    }
    /// Send (the button that hands a correction to an agent)
    static var send: String { String(localized: "native.subagents.send", table: "Native", bundle: .module) }
    /// That agent has already finished.
    static var finished: String { String(localized: "native.subagents.finished", table: "Native", bundle: .module) }
    /// The agent could not be reached: {reason}
    static func failed(_ reason: String) -> String {
      String(
        localized: "native.subagents.failed", defaultValue: "The agent could not be reached: \(reason)",
        table: "Native", bundle: .module)
    }
    /// Level {depth} (what VoiceOver adds to a row that hangs under another agent)
    static func level(_ depth: Int) -> String {
      String(localized: "native.subagents.level", defaultValue: "Level \(depth)", table: "Native", bundle: .module)
    }
  }
}

/// What the agents sheet says about a child and about what was just done to one.
enum SubagentText {
  static func status(_ status: Subagent.Status) -> String {
    switch status {
    case .queued: Strings.Chat.Subagents.Status.queued
    case .running: Strings.Chat.Subagents.Status.running
    case .completed: Strings.Chat.Subagents.Status.completed
    case .failed: Strings.Chat.Subagents.Status.failed
    case .interrupted: Strings.Chat.Subagents.Status.interrupted
    case .other(let raw): raw
    }
  }

  static func symbol(_ status: Subagent.Status) -> String {
    switch status {
    case .queued: "clock"
    case .running: "circle.dotted"
    case .completed: "checkmark.circle"
    case .failed: "xmark.circle"
    case .interrupted: "stop.circle"
    case .other: "circle"
    }
  }

  static func notice(_ notice: SubagentPanelModel.Notice) -> String {
    switch notice {
    case .steerQueued: Strings.Chat.Subagents.steerQueued
    case .steerRejected: Strings.Chat.Subagents.steerRejected
    case .stopping: Strings.Chat.Subagents.stopped
    case .finished: NativeStrings.Subagents.finished
    case .failed(let reason): NativeStrings.Subagents.failed(reason)
    }
  }
}
