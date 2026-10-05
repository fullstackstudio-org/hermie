import Foundation
import Observation

// MARK: - What can be stopped

/// One turn that is running on a gateway and can be interrupted from here.
public struct RunningTurn: Sendable, Equatable, Identifiable {
  /// The runtime session it runs in.
  public var id: String
  /// The chat of this app that holds the session (its Stop button's way), or nil for a session of
  /// another client, which is interrupted by its id.
  public var chatKey: String?
  /// The bot as the person knows it, or `""` when the gateway's row does not say whose it is.
  public var botName: String
  /// What the gateway titles the session, for one that names no bot. Cleaned and bounded.
  public var title: String

  public init(id: String, chatKey: String? = nil, botName: String = "", title: String = "") {
    self.id = id
    self.chatKey = chatKey
    self.botName = botName
    self.title = title
  }
}

/// What one gateway is running, as far as this app can tell and stop.
public struct RunningTurnReading: Sendable, Equatable {
  public var turns: [RunningTurn]
  /// Running sessions the gateway lists but this connection may not act on: they cannot be stopped
  /// from here.
  public var unreachable: Int
  /// The gateway's own list was read. False: only what this app's chats say is running is known, and
  /// a turn another client started is not among them.
  public var complete: Bool

  public init(turns: [RunningTurn], unreachable: Int = 0, complete: Bool = true) {
    self.turns = turns
    self.unreachable = unreachable
    self.complete = complete
  }
}

/// How stopping one turn went.
public enum StopOutcome: Sendable, Equatable {
  /// The gateway interrupted it.
  case stopped
  /// The gateway said nothing was left to interrupt: it ended by itself a moment ago.
  case alreadyDone
  /// The connection to the gateway was gone before the call went out.
  case notConnected
  /// The call did not go through, or the gateway refused it. The gateway's own words.
  case failed(String)
}

/**
 One gateway the app has a connection to, as the emergency stop sees it. The live session is the
 only one today (ADR-0024: one socket); the model takes a list so a second connection is one more
 entry, not a change.
 */
@MainActor
public protocol StoppableGateway: AnyObject, Sendable {
  var gatewayId: String { get }
  /// What the person calls the gateway.
  var gatewayName: String { get }
  /// What runs on it now, or nil when it cannot be asked (the socket is not up).
  func runningTurns() async -> RunningTurnReading?
  func stop(_ turn: RunningTurn) async -> StopOutcome
}

// MARK: - The plan and its outcome

/// What the stop is about to do, for the question that comes first.
public struct StopPlan: Sendable, Equatable {
  public struct Entry: Sendable, Equatable, Identifiable {
    public var gatewayId: String
    public var gatewayName: String
    public var turns: [RunningTurn]

    public var id: String { gatewayId }
  }

  public var entries: [Entry]
  /// Running sessions that cannot be stopped from here (`RunningTurnReading.unreachable`).
  public var unreachable: Int
  /// Gateways that could not be asked, or that this app has no connection to: what runs there is
  /// untouched. Their names.
  public var notAsked: [String]
  /// Some gateway's own list could not be read: a turn another client started may be running that
  /// this plan does not know of.
  public var incomplete: Bool

  /// How many turns will be stopped.
  public var total: Int { entries.reduce(0) { $0 + $1.turns.count } }

  public init(entries: [Entry], unreachable: Int = 0, notAsked: [String] = [], incomplete: Bool = false) {
    self.entries = entries
    self.unreachable = unreachable
    self.notAsked = notAsked
    self.incomplete = incomplete
  }
}

/// One turn's line in the summary.
public struct StopRecord: Sendable, Equatable, Identifiable {
  public var gatewayId: String
  public var gatewayName: String
  public var turn: RunningTurn
  public var outcome: StopOutcome

  public var id: String { "\(gatewayId)\u{1F}\(turn.id)" }

  public init(gatewayId: String, gatewayName: String, turn: RunningTurn, outcome: StopOutcome) {
    self.gatewayId = gatewayId
    self.gatewayName = gatewayName
    self.turn = turn
    self.outcome = outcome
  }
}

/// What the stop did, to show afterwards.
public struct StopSummary: Sendable, Equatable {
  public var records: [StopRecord]
  public var unreachable: Int
  public var notAsked: [String]
  public var incomplete: Bool

  public init(records: [StopRecord], unreachable: Int = 0, notAsked: [String] = [], incomplete: Bool = false) {
    self.records = records
    self.unreachable = unreachable
    self.notAsked = notAsked
    self.incomplete = incomplete
  }

  public var stopped: Int { records.filter { $0.outcome == .stopped }.count }
  public var alreadyDone: Int { records.filter { $0.outcome == .alreadyDone }.count }

  /// How many turns could not be stopped.
  public var failed: Int {
    records.filter {
      switch $0.outcome {
      case .failed, .notConnected: true
      case .stopped, .alreadyDone: false
      }
    }.count
  }

  /// Nothing was running that could be stopped.
  public var wasIdle: Bool { records.isEmpty }
}

// MARK: - The model

/**
 One control that interrupts every running turn of every bot on the gateways the app is connected
 to (NX-16).

 It goes in three steps, so the person is asked about what will happen and told afterwards what did:

 1. `begin()` reads what is running (`looking`), and either finds nothing (`finished` with an idle
    summary) or comes back with a `StopPlan` to confirm.
 2. `confirm()` interrupts every turn of the plan at once. A turn that cannot be stopped is a line in
    the summary, never a reason to leave the rest running.
 3. The summary stays until `dismiss()`.

 What the gateway's stop-all would add is the same call for a turn the connection cannot see: the
 summary counts those it could not reach, and names the gateways it had no connection to.
 */
@MainActor
@Observable
public final class EmergencyStopModel {
  public enum Phase: Sendable, Equatable {
    case idle
    /// Reading what is running.
    case looking
    /// Waiting for the person to say yes.
    case confirming(StopPlan)
    /// Interrupting.
    case stopping(StopPlan)
    case finished(StopSummary)
  }

  public private(set) var phase = Phase.idle

  @ObservationIgnored private let gateways: @MainActor () -> [any StoppableGateway]
  @ObservationIgnored private let notConnected: @MainActor () -> [String]

  /// - Parameters:
  ///   - gateways: the connections the app holds now.
  ///   - notConnected: the names of the signed-in gateways the app has no connection to (it holds one
  ///     socket at a time), so the summary can say what it did not touch.
  public init(
    gateways: @escaping @MainActor () -> [any StoppableGateway],
    notConnected: @escaping @MainActor () -> [String] = { [] }
  ) {
    self.gateways = gateways
    self.notConnected = notConnected
  }

  public var isBusy: Bool {
    switch phase {
    case .looking, .stopping: true
    case .idle, .confirming, .finished: false
    }
  }

  /// Read what is running, from the start: an earlier question or summary is replaced. Ignored while
  /// the reading or the stopping itself is under way.
  public func begin() async {
    guard !isBusy else {
      return
    }

    phase = .looking

    var entries: [StopPlan.Entry] = []
    var unreachable = 0
    var notAsked = notConnected()
    var incomplete = false

    for gateway in gateways() {
      guard let reading = await gateway.runningTurns() else {
        notAsked.append(gateway.gatewayName)
        continue
      }

      unreachable += reading.unreachable
      incomplete = incomplete || !reading.complete

      if !reading.turns.isEmpty {
        entries.append(
          StopPlan.Entry(gatewayId: gateway.gatewayId, gatewayName: gateway.gatewayName, turns: reading.turns))
      }
    }

    // Whoever asked has gone (the sheet closed while the gateway was being read): nothing is left asking.
    guard !Task.isCancelled else {
      phase = .idle
      return
    }

    let plan = StopPlan(entries: entries, unreachable: unreachable, notAsked: notAsked, incomplete: incomplete)

    if plan.total == 0 {
      phase = .finished(StopSummary(records: [], unreachable: unreachable, notAsked: notAsked, incomplete: incomplete))
    } else {
      phase = .confirming(plan)
    }
  }

  /// The person said yes: interrupt every turn of the plan, all at once.
  public func confirm() async {
    guard case .confirming(let plan) = phase else {
      return
    }

    phase = .stopping(plan)

    let live = gateways()
    var records: [StopRecord] = []

    for entry in plan.entries {
      guard let gateway = live.first(where: { $0.gatewayId == entry.gatewayId }) else {
        // The connection went while the question was up: nothing there can be stopped now.
        for turn in entry.turns {
          records.append(
            StopRecord(
              gatewayId: entry.gatewayId, gatewayName: entry.gatewayName, turn: turn,
              outcome: .notConnected))
        }

        continue
      }

      let outcomes = await Self.stopAll(entry.turns, on: gateway)

      for (index, turn) in entry.turns.enumerated() {
        records.append(
          StopRecord(
            gatewayId: entry.gatewayId, gatewayName: entry.gatewayName, turn: turn,
            outcome: outcomes[index] ?? .notConnected))
      }
    }

    phase = .finished(
      StopSummary(
        records: records, unreachable: plan.unreachable, notAsked: plan.notAsked, incomplete: plan.incomplete))
  }

  /// Every turn at once, each its own call; the outcomes by the turn's place in `turns`.
  private nonisolated static func stopAll(_ turns: [RunningTurn], on gateway: any StoppableGateway) async
    -> [Int: StopOutcome]
  {
    await withTaskGroup(of: (Int, StopOutcome).self) { group in
      for (index, turn) in turns.enumerated() {
        group.addTask { (index, await gateway.stop(turn)) }
      }

      var done: [Int: StopOutcome] = [:]

      for await (index, outcome) in group {
        done[index] = outcome
      }

      return done
    }
  }

  /// "Cancel" on the question: nothing is stopped.
  public func cancel() {
    if case .confirming = phase {
      phase = .idle
    }
  }

  /// The summary is read.
  public func dismiss() {
    if isFinished {
      phase = .idle
    }
  }

  private var isFinished: Bool {
    if case .finished = phase { true } else { false }
  }
}
