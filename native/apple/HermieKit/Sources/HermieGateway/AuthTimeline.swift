import Foundation
import HermieProtocol
import Synchronization

// The ring of `packages/gateway-client/src/auth-timeline.ts`: a short,
// replayable account of what the auth layer did, so the next surprise sign-out
// can be read rather than guessed at. The event vocabulary (`AuthEventName`,
// `SignOutReason`, `AuthEvent`, `AuthEventRecorder`) lives in `AuthEvents.swift`;
// this file is the ring that stamps and keeps them, and the one extra thing the
// connection needs from it, attributing a sign-out.
//
// What may be recorded is deliberately narrow, because the ring is meant to be
// pasted into an issue as it stands: no token values, no message text, no host,
// no session or user identifiers. Persisting it is a later task; `sink` and
// `restore(_:)` are the two ends that will plug into.

/// What the connection needs from the timeline (`AuthTimelineSink`): recording,
/// and declaring a sign-out attributed to the cause the ring can account for.
public protocol AuthTimelineSink: AuthEventRecorder {
  func signOut(_ fallback: SignOutReason)
}

/// `NULL_AUTH_TIMELINE`: the sink every code path can talk to unconditionally.
public struct NullAuthTimeline: AuthTimelineSink {
  public init() {}
  public func record(_ event: AuthEvent) {}
  public func signOut(_ fallback: SignOutReason) {}
}

/// One event in the ring, stamped with when it happened.
public struct AuthTimelineEntry: Sendable, Equatable {
  /// Milliseconds since 1970 (`Date.now()`).
  public var at: Double
  public var event: AuthEvent

  public init(at: Double, event: AuthEvent) {
    self.at = at
    self.event = event
  }
}

public struct AuthTimelineSnapshot: Sendable, Equatable {
  /// The reason attached to a `signin.required`, and when.
  public struct SignOut: Sendable, Equatable {
    public var at: Double
    public var reason: SignOutReason

    public init(at: Double, reason: SignOutReason) {
      self.at = at
      self.reason = reason
    }
  }

  public var entries: [AuthTimelineEntry]
  /// The most recent `signin.required` that carried a reason, if there was one.
  public var lastSignOut: SignOut?

  public init(entries: [AuthTimelineEntry] = [], lastSignOut: SignOut? = nil) {
    self.entries = entries
    self.lastSignOut = lastSignOut
  }
}

/// The ring itself. Recording never fails: a full disk is not a reason to lose
/// a connection that works.
public final class AuthTimeline: AuthTimelineSink {
  /// How many events the ring keeps (`AUTH_TIMELINE_SIZE`). Two or three dials' worth.
  public static let defaultSize = 20

  private let state: Mutex<AuthTimelineSnapshot>
  private let size: Int
  private let now: @Sendable () -> Double
  private let sink: (@Sendable (AuthTimelineSnapshot) -> Void)?

  /// - Parameters:
  ///   - now: milliseconds since 1970; the wall clock unless a test injects one.
  ///   - sink: called after every record with the whole snapshot, outside the
  ///     ring's lock. The app persists it.
  public init(
    size: Int = AuthTimeline.defaultSize,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
    sink: (@Sendable (AuthTimelineSnapshot) -> Void)? = nil
  ) {
    self.state = Mutex(AuthTimelineSnapshot())
    self.size = size
    self.now = now
    self.sink = sink
  }

  public func record(_ event: AuthEvent) {
    record(event, at: now())
  }

  /// Record with a time of the caller's (`AuthEventInput.at`).
  public func record(_ event: AuthEvent, at: Double) {
    var event = event
    // `compact` rounds the lifetime as it records it (`Math.round`).
    event.expiresIn = event.expiresIn.map { ($0 + 0.5).rounded(.down) }
    let entry = AuthTimelineEntry(at: at, event: event)

    let snapshot = state.withLock { state in
      state.entries.append(entry)

      if state.entries.count > size {
        state.entries.removeFirst(state.entries.count - size)
      }

      if event.event == .signinRequired, let reason = event.reason {
        state.lastSignOut = .init(at: at, reason: reason)
      }

      return state
    }

    // A Swift sink cannot throw; the reference swallows whatever its sink
    // throws, so a failure to persist is never a second failure here either.
    sink?(snapshot)
  }

  /// Record the sign-out, attributed to the most recent cause the ring can
  /// account for: a `reauth` verdict only says the provider has nothing left
  /// to offer, while why was recorded by the coordinator moments earlier.
  public func signOut(_ fallback: SignOutReason) {
    let attributed = state.withLock { Self.attribute($0.entries) }
    record(AuthEvent(.signinRequired, reason: attributed ?? fallback))
  }

  /// Read backwards to the last decisive event; stop at the last healthy dial,
  /// because anything older belongs to a different story.
  private static func attribute(_ entries: [AuthTimelineEntry]) -> SignOutReason? {
    for entry in entries.reversed() {
      switch entry.event.event {
      case .dialReady:
        return nil
      case .tokenCleared:
        return entry.event.reason
      case .tokenReadFailed:
        return .tokenUnreadable
      case .refreshFailed:
        return entry.event.kind == .auth ? .refreshRejected : .refreshFailed
      default:
        continue
      }
    }

    return nil
  }

  public func snapshot() -> AuthTimelineSnapshot {
    state.withLock { $0 }
  }

  /// The reason for the most recent sign-out, across restarts once restored.
  public var signOutReason: SignOutReason? {
    state.withLock { $0.lastSignOut?.reason }
  }

  /// Adopt a snapshot read back from storage, in the reference's shape
  /// (`{events: [{at, event, …}], lastSignOut: {at, reason}}`). Anything that
  /// does not look like an event (a number `at` and a known `event` name) is
  /// dropped rather than trusted: the blob may have been written by an older build.
  public func restore(_ snapshot: JSONValue?) {
    guard case .object(let object)? = snapshot else {
      return
    }

    state.withLock { state in
      if let events = object["events"]?.arrayValue {
        state.entries = Array(events.compactMap(Self.entry(from:)).suffix(size))
      }

      if let signOut = object["lastSignOut"]?.objectValue,
        let at = signOut["at"]?.doubleValue,
        let reason = signOut["reason"]?.stringValue.flatMap(SignOutReason.init(rawValue:))
      {
        state.lastSignOut = .init(at: at, reason: reason)
      }
    }
  }

  private static func entry(from value: JSONValue) -> AuthTimelineEntry? {
    guard case .object(let object) = value, let at = object["at"]?.doubleValue,
      let name = object["event"]?.stringValue.flatMap(AuthEventName.init(rawValue:))
    else {
      return nil
    }

    let event = AuthEvent(
      name,
      status: object["status"]?.intValue,
      closeCode: object["closeCode"]?.intValue,
      kind: object["kind"]?.stringValue.flatMap(GatewayErrorKind.init(rawValue:)),
      expiresIn: object["expiresIn"]?.doubleValue,
      reason: object["reason"]?.stringValue.flatMap(SignOutReason.init(rawValue:))
    )
    return AuthTimelineEntry(at: at, event: event)
  }
}
