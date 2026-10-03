import Foundation
import os

/**
 The last things that happened to the chat screens, in order: which screen appeared and went
 away, which feed started and stopped, which lease was taken and given back, what the router
 selected. Kept in memory (the newest 60) for the diagnostics the chat title copies, and written to
 the unified log (`dev.hermie.app`, category `chat`) as it happens.

 Nothing here holds a transcript or a message: bot names, counts and states only.
 */
@MainActor
enum ChatLifecycleLog {
  static let logger = Logger(subsystem: "dev.hermie.app", category: "chat")
  static let capacity = 60

  private(set) static var events: [String] = []
  private static let start = ContinuousClock.now

  static func note(_ event: String) {
    let origin = start
    let elapsed = ContinuousClock.now - origin
    let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    let line = String(format: "%.3f ", seconds) + event

    events.append(line)

    if events.count > capacity {
      events.removeFirst(events.count - capacity)
    }

    logger.notice("\(event, privacy: .public)")
  }
}
