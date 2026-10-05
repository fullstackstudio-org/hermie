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
  /// Where the turn was started from (`tui`, `cli`, a messaging platform), where the gateway says.
  public var source: String

  public init(id: String, chatKey: String? = nil, botName: String = "", title: String = "", source: String = "") {
    self.id = id
    self.chatKey = chatKey
    self.botName = botName
    self.title = title
    self.source = source
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

/// What the gateway's stop-everything (`session.interrupt_all`) answered.
public struct StopEverythingReport: Sendable, Equatable {
  /// The turns it stopped, named as the person knows them (the bot, else the profile).
  public var stopped: [RunningTurn]
  /// Sessions with no turn running, or whose turn ended during the call.
  public var alreadyIdle: Int
  /// Running turns it may not stop: other people's, in a chat more than one person is in.
  public var notAllowed: Int
  /// Turns whose stop failed on the gateway.
  public var failed: Int

  public init(stopped: [RunningTurn], alreadyIdle: Int = 0, notAllowed: Int = 0, failed: Int = 0) {
    self.stopped = stopped
    self.alreadyIdle = alreadyIdle
    self.notAllowed = notAllowed
    self.failed = failed
  }
}

/// How the one-call stop went on one gateway.
public enum StopEverythingOutcome: Sendable, Equatable {
  /// The gateway stopped what it could and says what.
  case answered(StopEverythingReport)
  /// The gateway has no such method (it answers `-32601`): stop the turns one by one.
  case unsupported
  /// The connection to the gateway was gone before the call went out.
  case notConnected
  /// The call did not go through, or the gateway refused it. The gateway's own words. Nothing is known to
  /// have been stopped, so the turns are stopped one by one.
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
  /// Stop every turn of the caller's that the gateway can, in one call (`session.interrupt_all`): the turns of
  /// every bot, from every client of this person, which also reaches a turn this connection cannot see. The
  /// default is a gateway that cannot, and the stop goes turn by turn.
  func stopEverything() async -> StopEverythingOutcome
}

extension StoppableGateway {
  public func stopEverything() async -> StopEverythingOutcome { .unsupported }
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
  /// Of `unreachable`, how many each gateway had (by id). Where the gateway can stop everything in one call
  /// (`StoppableGateway.stopEverything`) those are answered by it, and no longer a caveat.
  public var unreachableByGateway: [String: Int]
  /// The gateways (by id) whose own list could not be read, which `incomplete` is about.
  public var incompleteGateways: [String]

  /// How many turns will be stopped.
  public var total: Int { entries.reduce(0) { $0 + $1.turns.count } }

  public init(
    entries: [Entry], unreachable: Int = 0, notAsked: [String] = [], incomplete: Bool = false,
    unreachableByGateway: [String: Int] = [:], incompleteGateways: [String] = []
  ) {
    self.entries = entries
    self.unreachable = unreachable
    self.notAsked = notAsked
    self.incomplete = incomplete
    self.unreachableByGateway = unreachableByGateway
    self.incompleteGateways = incompleteGateways
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
  /// Running sessions nobody could stop from here, on gateways that were stopped turn by turn.
  public var unreachable: Int
  public var notAsked: [String]
  public var incomplete: Bool
  /// Some gateway was stopped in one call (`session.interrupt_all`): the summary is its answer, which covers
  /// the turns of every client of this person, and says what it left running. Scheduled (cron) runs are
  /// outside that call and keep running.
  public var usedStopEverything: Bool
  /// What that call counted beyond the turns it names: sessions with no turn running (`alreadyIdleCount`),
  /// running turns it may not stop (another person's, in a shared chat) and turns whose stop failed.
  public var alreadyIdleCount: Int
  public var notAllowed: Int
  public var failedCount: Int

  public init(
    records: [StopRecord], unreachable: Int = 0, notAsked: [String] = [], incomplete: Bool = false,
    usedStopEverything: Bool = false, alreadyIdleCount: Int = 0, notAllowed: Int = 0, failedCount: Int = 0
  ) {
    self.records = records
    self.unreachable = unreachable
    self.notAsked = notAsked
    self.incomplete = incomplete
    self.usedStopEverything = usedStopEverything
    self.alreadyIdleCount = alreadyIdleCount
    self.notAllowed = notAllowed
    self.failedCount = failedCount
  }

  public var stopped: Int { records.filter { $0.outcome == .stopped }.count }
  /// Turns that ended by themselves before their stop went out.
  public var alreadyDone: Int { records.filter { $0.outcome == .alreadyDone }.count }

  /// How many turns could not be stopped.
  public var failed: Int {
    failedCount
      + records.filter {
        switch $0.outcome {
        case .failed, .notConnected: true
        case .stopped, .alreadyDone: false
        }
      }.count
  }

  /// Nothing was running that could be stopped, and nothing was left running that should have been. Sessions
  /// that were idle all along do not count: they are not a turn.
  public var wasIdle: Bool { records.isEmpty && notAllowed == 0 && failedCount == 0 }
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
    var unreachableBy: [String: Int] = [:]
    var notAsked = notConnected()
    var incomplete = false
    var incompleteBy: [String] = []

    for gateway in gateways() {
      guard let reading = await gateway.runningTurns() else {
        notAsked.append(gateway.gatewayName)
        continue
      }

      unreachable += reading.unreachable
      incomplete = incomplete || !reading.complete

      if reading.unreachable > 0 {
        unreachableBy[gateway.gatewayId] = reading.unreachable
      }

      if !reading.complete {
        incompleteBy.append(gateway.gatewayId)
      }

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

    let plan = StopPlan(
      entries: entries, unreachable: unreachable, notAsked: notAsked, incomplete: incomplete,
      unreachableByGateway: unreachableBy, incompleteGateways: incompleteBy)

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
    /// What the gateways stopped in one call answered for: their `unreachable` and unreadable lists are no
    /// longer a caveat, since that call does not go by the list.
    var answeredBy = Set<String>()
    var usedStopEverything = false
    var alreadyIdle = 0
    var notAllowed = 0
    var failedCount = 0

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

      switch await gateway.stopEverything() {
      case .answered(let report):
        usedStopEverything = true
        answeredBy.insert(entry.gatewayId)
        alreadyIdle += report.alreadyIdle
        notAllowed += report.notAllowed
        failedCount += report.failed

        for turn in report.stopped {
          records.append(
            StopRecord(gatewayId: entry.gatewayId, gatewayName: entry.gatewayName, turn: turn, outcome: .stopped))
        }

        continue
      case .notConnected:
        for turn in entry.turns {
          records.append(
            StopRecord(
              gatewayId: entry.gatewayId, gatewayName: entry.gatewayName, turn: turn, outcome: .notConnected))
        }

        continue
      case .unsupported, .failed:
        // An older gateway, or a call that did not go through: stop what the plan lists, one by one. A turn
        // that was stopped after all by the call that failed answers "nothing left to interrupt".
        break
      }

      let outcomes = await Self.stopAll(entry.turns, on: gateway)

      for (index, turn) in entry.turns.enumerated() {
        records.append(
          StopRecord(
            gatewayId: entry.gatewayId, gatewayName: entry.gatewayName, turn: turn,
            outcome: outcomes[index] ?? .notConnected))
      }
    }

    let unreachable = plan.unreachableByGateway.reduce(0) { answeredBy.contains($1.key) ? $0 : $0 + $1.value }
    let incomplete = plan.incompleteGateways.contains { !answeredBy.contains($0) }

    phase = .finished(
      StopSummary(
        records: records, unreachable: unreachable, notAsked: plan.notAsked, incomplete: incomplete,
        usedStopEverything: usedStopEverything, alreadyIdleCount: alreadyIdle, notAllowed: notAllowed,
        failedCount: failedCount))
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
