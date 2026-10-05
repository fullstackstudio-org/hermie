import Foundation
import HermieCore

/// The agents overview's sentences, from `Resources/Native.xcstrings` (`native.agents.*`),.
extension NativeStrings {
  enum Agents {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Agents (the screen's title and the toolbar item)
    static var title: String { string("native.agents.title") }
    /// Agents Overview (the Mac's menu command)
    static var command: String { string("native.agents.command") }
    /// What each bot is doing right now.
    static var subtitle: String { string("native.agents.subtitle") }
    /// Waiting for you / Running / Idle
    static func state(_ state: AgentState) -> String {
      switch state {
      case .waiting: string("native.agents.state.waiting")
      case .running: string("native.agents.state.running")
      case .idle: string("native.agents.state.idle")
      }
    }
    /// Bots (the section over the bots' rows)
    static var bots: String { string("native.agents.section.bots") }
    /// Sub-agents
    static var subagents: String { string("native.agents.section.subagents") }
    /// Upcoming crons
    static var crons: String { string("native.agents.section.crons") }
    /// Reading what your bots are doing…
    static var loading: String { string("native.agents.loading") }
    /// Connect to the gateway to see what your bots are doing.
    static var offline: String { string("native.agents.offline") }
    /// No bots yet
    static var emptyTitle: String { string("native.agents.empty.title") }
    /// Add a bot and what it is doing shows up here.
    static var emptyMessage: String { string("native.agents.empty.message") }
    /// The gateway did not say which sessions are running, so this shows only the chats open in this app.
    static var incomplete: String { string("native.agents.incomplete") }
    /// {count} other session(s) running on the gateway: a scheduled run, or another device.
    static func otherRunning(_ count: Int) -> String {
      String(
        localized: "native.agents.otherRunning", defaultValue: "\(count) other sessions are running on the gateway",
        table: "Native", bundle: .module)
    }
    /// Using {tool}
    static func using(_ tool: String) -> String {
      String(localized: "native.agents.row.using", defaultValue: "Using \(tool)", table: "Native", bundle: .module)
    }
    /// Started {when}
    static func started(_ when: String) -> String {
      String(localized: "native.agents.row.started", defaultValue: "Started \(when)", table: "Native", bundle: .module)
    }
    /// Next cron: {name}, {when}
    static func nextCron(_ name: String, _ when: String) -> String {
      String(
        localized: "native.agents.row.nextCron", defaultValue: "Next cron: \(name), \(when)", table: "Native",
        bundle: .module)
    }
    /// Opens the chat with this bot. (the hint of a row)
    static var rowHint: String { string("native.agents.row.hint") }
    /// {count} sub-agent(s) running
    static func subagentsRunning(_ count: Int) -> String {
      String(
        localized: "native.agents.row.subagents", defaultValue: "\(count) sub-agents running", table: "Native",
        bundle: .module)
    }
    /// {count} tool call(s)
    static func toolCalls(_ count: Int) -> String {
      String(
        localized: "native.agents.subagent.toolCalls", defaultValue: "\(count) tool calls", table: "Native",
        bundle: .module)
    }
    /// Queued
    static var queued: String { string("native.agents.subagent.queued") }
    /// Sub-agent (for one that has no goal)
    static var unnamedSubagent: String { string("native.agents.subagent.unnamed") }
    /// Nothing is scheduled.
    static var noCrons: String { string("native.agents.crons.none") }
    /// The crons could not be read.
    static var cronsUnknown: String { string("native.agents.crons.unknown") }
  }
}
