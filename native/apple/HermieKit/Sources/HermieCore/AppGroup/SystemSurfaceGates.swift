import Foundation
import Synchronization

/**
 Whether the app lock is on, for everything that acts on the owner's behalf outside the app's own
 screens: the share outbox, the Shortcuts queue, and the App Intents that answer from the snapshot.

 A Shortcut's `perform()` runs inside the app behind the privacy cover, and Siri can run one on a
 locked device; without this, "Send to" would send and "Ask" would speak a bot's reply without the
 app lock ever being passed. So every such path asks here first and does nothing while locked.

 **Locked until told otherwise.** The session layer installs the real provider (the app lock's
 state, `HermieCore/Lock`) at launch; until it does, every surface behaves as locked. A missing
 wiring step then shows up as Shortcuts that wait, never as a lock that is bypassed.
 */
public enum SystemSurfaceLock {
  private static let provider = Mutex<@Sendable () -> Bool>({ true })

  /// Whether the app lock currently covers the app.
  public static var isLocked: Bool {
    provider.withLock { $0 }()
  }

  /// Install the app lock's state. Call once at launch, before draining anything.
  public static func install(_ isLocked: @escaping @Sendable () -> Bool) {
    provider.withLock { $0 = isLocked }
  }
}

/**
 Which gateways exist, for deciding whether a queued item is the active gateway's.

 Every share and Shortcut request records the gateway its bot was picked from. One for the active
 gateway is delivered; one for another configured gateway waits for that gateway to become active;
 one for a gateway that no longer exists is purged. An item from before the key was recorded is
 delivered only when exactly one gateway is configured, and purged otherwise: a bot name means
 nothing without its gateway.
 */
public struct GatewayScope: Sendable, Equatable {
  /// The active gateway's key, or nil when none is active.
  public var active: String?
  /// Every configured gateway's key, the active one included.
  public var known: Set<String>

  public init(active: String?, known: Set<String>) {
    self.active = active
    self.known = known
  }

  public enum Route: Sendable, Equatable {
    case deliver
    case wait
    case purge
  }

  /// What to do with an item recorded for `gatewayKey`.
  public func route(_ gatewayKey: String?) -> Route {
    guard let gatewayKey else {
      if let active, known == [active] {
        return .deliver
      }

      return .purge
    }

    if gatewayKey == active {
      return .deliver
    }

    return known.contains(gatewayKey) ? .wait : .purge
  }
}

/**
 One drain at a time per queue, across every instance that names the same directory.

 A deep link and "the gateway is ready" routinely arrive together; two drains over the same files
 would hand the same share or request to the session twice. A drain that starts while one is
 running does not run beside it: it asks the running one to go round once more, and returns.
 */
final class DrainGate: Sendable {
  private static let gates = Mutex<[String: DrainGate]>([:])

  private struct State {
    var running = false
    var again = false
  }

  private let state = Mutex(State())

  /// The gate for one directory.
  static func gate(for directory: URL) -> DrainGate {
    gates.withLock { gates in
      let key = directory.standardizedFileURL.path

      if let gate = gates[key] {
        return gate
      }

      let gate = DrainGate()

      gates[key] = gate

      return gate
    }
  }

  /// Run `body`, or, when a run is in flight, have that run go round once more. Answers whether
  /// this call ran it.
  func run(_ body: () async -> Void) async -> Bool {
    let start = state.withLock { state in
      if state.running {
        state.again = true

        return false
      }

      state.running = true

      return true
    }

    guard start else {
      return false
    }

    var repeating = true

    while repeating {
      state.withLock { $0.again = false }
      await body()
      repeating = state.withLock { state in
        if state.again {
          return true
        }

        state.running = false

        return false
      }
    }

    return true
  }
}
