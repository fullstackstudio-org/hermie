import Foundation
import HermieProtocol

/// `session.interrupt_all`'s answer as the wire sends it: the turns it stopped, and how many sessions it found
/// idle, may not stop, or failed to stop. Every text is the gateway's: cleaned and bounded.
public struct InterruptAllResult: Sendable, Equatable {
  public struct Stopped: Sendable, Equatable {
    /// The runtime session id (`session.active_list`'s `id`).
    public var sessionID: String
    /// The stored session id.
    public var sessionKey: String
    /// The profile the session belongs to.
    public var profile: String
    /// What the session is titled; empty while it has none.
    public var title: String
    /// Where the turn was started from.
    public var source: String

    public init(
      sessionID: String, sessionKey: String = "", profile: String = "", title: String = "", source: String = ""
    ) {
      self.sessionID = sessionID
      self.sessionKey = sessionKey
      self.profile = profile
      self.title = title
      self.source = source
    }
  }

  public var stopped: [Stopped]
  /// Sessions the caller may act on with no turn running, or whose turn ended during the call.
  public var alreadyIdle: Int
  /// Running turns it may not stop: another person's, in a chat more than one person is in.
  public var notAllowed: Int
  /// Turns whose stop failed on the gateway.
  public var failed: Int

  public init(stopped: [Stopped] = [], alreadyIdle: Int = 0, notAllowed: Int = 0, failed: Int = 0) {
    self.stopped = stopped
    self.alreadyIdle = alreadyIdle
    self.notAllowed = notAllowed
    self.failed = failed
  }

  /// The most turns kept: more than any person has running, so a runaway answer costs the same.
  static let stoppedLimit = 200

  /// Nil for an answer that says nothing of this call (not an object, none of its fields).
  public static func parse(_ result: JSONValue?) -> InterruptAllResult? {
    guard case .object(let object)? = result,
      object["stopped"] != nil || object["already_idle"] != nil || object["not_allowed"] != nil
        || object["failed"] != nil
    else {
      return nil
    }

    var stopped: [Stopped] = []

    for row in (object["stopped"]?.arrayValue ?? []).prefix(stoppedLimit) {
      guard case .object(let fields) = row, let id = fields["session_id"]?.stringValue, !id.isEmpty else {
        continue
      }

      stopped.append(
        Stopped(
          sessionID: id,
          sessionKey: fields["session_key"]?.stringValue ?? "",
          profile: line(fields["profile"]?.stringValue, limit: 60),
          title: line(fields["title"]?.stringValue, limit: 60),
          source: line(fields["source"]?.stringValue, limit: 40)
        ))
    }

    return InterruptAllResult(
      stopped: stopped,
      alreadyIdle: DailyUsage.count(object["already_idle"]),
      notAllowed: DailyUsage.count(object["not_allowed"]),
      failed: DailyUsage.count(object["failed"]))
  }

  /// One line of the gateway's text: control and format characters become spaces, the ends are trimmed, and it is
  /// cut at `limit`.
  private static func line(_ text: String?, limit: Int) -> String {
    String(UsageText.line(text).prefix(limit))
  }
}
