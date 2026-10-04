import Foundation
import Observation

/// The three calls the agents sheet makes, as functions: a test hands in closures, production a chat's
/// store (`ChatModel.subagentPanel()`).
public struct SubagentGateway: Sendable {
  public var steer: @Sendable (_ id: String, _ text: String) async throws -> SubagentSteerOutcome
  public var interrupt: @Sendable (_ id: String) async throws -> Bool
  public var tail: @Sendable (_ id: String) async throws -> SubagentTail

  public init(
    steer: @escaping @Sendable (_ id: String, _ text: String) async throws -> SubagentSteerOutcome,
    interrupt: @escaping @Sendable (_ id: String) async throws -> Bool,
    tail: @escaping @Sendable (_ id: String) async throws -> SubagentTail
  ) {
    self.steer = steer
    self.interrupt = interrupt
    self.tail = tail
  }
}

/**
 What the agents sheet does to a running child (`AgentsSheet` in the Expo app): steer it, stop it, and
 read the live tail of its transcript.

 - **Steer** hands the words to the child as written (`subagent.steer`); the gateway answers `queued`
   or `rejected` (a child past its last tool batch), and the sheet says which. Queued is not delivered.
 - **Stop** is one child (`subagent.interrupt`); `found: false` is a child that is gone already.
 - **The tail** is the last 16 KB of the child's live transcript (`subagent.tail`), read again every
   few seconds while it is open. It stops existing when the child does, so the page says it is a live
   tail; a finished child with a session of its own is read from that session instead (the router's
   conversation viewer), which is not this model's business.

 Everything the gateway sent (the tail, its error words) is untrusted text.
 */
@MainActor
@Observable
public final class SubagentPanelModel {
  /// The one line over the list after a Steer or Stop.
  public enum Notice: Equatable, Sendable {
    case steerQueued
    case steerRejected
    case stopping
    /// Stop found nothing to stop: the child had finished.
    case finished
    case failed(String)
  }

  /// One child's transcript as the tail page shows it.
  public struct Tail: Equatable, Sendable {
    public var id: String
    public var goal: String
    public var text = ""
    /// Nothing has come back yet.
    public var loading = true
    /// The gateway has no live transcript for the child.
    public var unavailable = false
    public var error: String?
  }

  public private(set) var notice: Notice?
  public private(set) var tail: Tail?
  /// Children with a Steer or a Stop on its way: their buttons wait.
  public private(set) var busy: Set<String> = []

  @ObservationIgnored private let gateway: SubagentGateway

  public init(gateway: SubagentGateway) {
    self.gateway = gateway
  }

  public func dismissNotice() {
    notice = nil
  }

  // MARK: Steer and stop

  /// Hand a correction to a child. False when nothing was sent (nothing typed, or one is on its way)
  /// or the gateway did not take it, so the sheet keeps what was typed.
  @discardableResult
  public func steer(_ id: String, text: String) async -> Bool {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !words.isEmpty, busy.insert(id).inserted else {
      return false
    }

    defer { busy.remove(id) }

    do {
      switch try await gateway.steer(id, words) {
      case .queued:
        notice = .steerQueued
        return true
      case .rejected:
        notice = .steerRejected
        return false
      }
    } catch {
      notice = .failed(ChatResolver.describe(error))
      return false
    }
  }

  /// Stop one child.
  public func stop(_ id: String) async {
    guard busy.insert(id).inserted else {
      return
    }

    defer { busy.remove(id) }

    do {
      notice = try await gateway.interrupt(id) ? .stopping : .finished
    } catch {
      notice = .failed(ChatResolver.describe(error))
    }
  }

  // MARK: The tail

  /// Open the tail page of a child. `followTail` keeps it fresh.
  public func openTail(_ id: String, goal: String) {
    tail = Tail(id: id, goal: goal)
  }

  public func closeTail() {
    tail = nil
  }

  /// Read the open tail now and again every `interval` until the page closes or the task is cancelled.
  /// One failed read keeps what was read before and says why; the next one tries again.
  public func followTail(every interval: Duration = .seconds(3)) async {
    guard let id = tail?.id else {
      return
    }

    while !Task.isCancelled, tail?.id == id {
      await refreshTail(id)

      do {
        try await Task.sleep(for: interval)
      } catch {
        return
      }
    }
  }

  func refreshTail(_ id: String) async {
    do {
      let read = try await gateway.tail(id)

      guard tail?.id == id else {
        return
      }

      switch read {
      case .text(let text):
        tail?.text = text
        tail?.unavailable = false
      case .unavailable:
        tail?.unavailable = true
      }

      tail?.error = nil
      tail?.loading = false
    } catch {
      guard tail?.id == id else {
        return
      }

      tail?.error = ChatResolver.describe(error)
      tail?.loading = false
    }
  }
}
