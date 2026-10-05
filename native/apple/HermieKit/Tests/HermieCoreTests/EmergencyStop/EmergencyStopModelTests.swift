import Foundation
import Synchronization
import Testing

@testable import HermieCore

/// A gateway the emergency stop can ask and stop, scripted by the test.
@MainActor
final class FakeStoppable: StoppableGateway {
  let gatewayId: String
  let gatewayName: String
  var reading: RunningTurnReading?
  /// How stopping a turn goes, by the turn's id; a turn not named here is stopped.
  var outcomes: [String: StopOutcome] = [:]
  private(set) var stopped: [String] = []
  private(set) var reads = 0
  /// How many `stop` calls were in the air at once at the most.
  private(set) var peak = 0
  private var inFlight = 0
  /// Held until `release()`, so a test can look at the model while the stops are under way.
  var gate: Gate?

  /// One gate for every call to wait at.
  final class Gate: Sendable {
    private let state = Mutex<(open: Bool, waiting: [CheckedContinuation<Void, Never>])>((false, []))

    func wait() async {
      await withCheckedContinuation { continuation in
        let resumeNow = state.withLock { state -> Bool in
          if state.open { return true }
          state.waiting.append(continuation)
          return false
        }

        if resumeNow { continuation.resume() }
      }
    }

    func open() {
      let waiting = state.withLock { state -> [CheckedContinuation<Void, Never>] in
        state.open = true
        defer { state.waiting = [] }
        return state.waiting
      }

      for continuation in waiting { continuation.resume() }
    }

    var waiters: Int { state.withLock { $0.waiting.count } }
  }

  init(id: String, name: String, turns: [RunningTurn], unreachable: Int = 0, complete: Bool = true) {
    gatewayId = id
    gatewayName = name
    reading = RunningTurnReading(turns: turns, unreachable: unreachable, complete: complete)
  }

  func runningTurns() async -> RunningTurnReading? {
    reads += 1
    return reading
  }

  func stop(_ turn: RunningTurn) async -> StopOutcome {
    inFlight += 1
    peak = max(peak, inFlight)
    defer { inFlight -= 1 }

    if let gate {
      await gate.wait()
    }

    stopped.append(turn.id)
    return outcomes[turn.id] ?? .stopped
  }
}

/// The connections the model is given, which a test can take away.
@MainActor
final class Held {
  var gateways: [any StoppableGateway]

  init(gateways: [any StoppableGateway]) {
    self.gateways = gateways
  }
}

@MainActor
@Suite("Emergency stop: the model", .timeLimit(.minutes(1)))
struct EmergencyStopModelTests {
  private func turn(_ id: String, bot: String = "") -> RunningTurn {
    RunningTurn(id: id, chatKey: bot.isEmpty ? nil : bot, botName: bot.capitalized)
  }

  private func plan(_ model: EmergencyStopModel) -> StopPlan? {
    if case .confirming(let plan) = model.phase { plan } else { nil }
  }

  private func summary(_ model: EmergencyStopModel) -> StopSummary? {
    if case .finished(let summary) = model.phase { summary } else { nil }
  }

  @Test("it reads what runs, asks with the count, and stops every turn of every bot only after the yes")
  func asksThenStops() async {
    let home = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher"), turn("rt-2", bot: "writer"), turn("rt-3")])
    let model = EmergencyStopModel(gateways: { [home] })

    #expect(model.phase == .idle)
    await model.begin()

    let asked = plan(model)
    #expect(asked?.total == 3, "Stop all 3 running turns?")
    #expect(asked?.entries.map(\.gatewayName) == ["Home"])
    #expect(home.stopped.isEmpty, "nothing is stopped before the person says yes")

    await model.confirm()

    #expect(Set(home.stopped) == ["rt-1", "rt-2", "rt-3"])
    let done = summary(model)
    #expect(done?.stopped == 3)
    #expect(done?.failed == 0)
    #expect(done?.records.map(\.turn.botName) == ["Researcher", "Writer", ""], "in the order the plan listed them")
    #expect(done?.records.allSatisfy { $0.gatewayName == "Home" } == true)
    #expect(done?.wasIdle == false)
  }

  @Test("every turn is interrupted at once, not one after the other")
  func allAtOnce() async throws {
    let gateway = FakeStoppable(id: "g1", name: "Home", turns: (1...4).map { turn("rt-\($0)", bot: "bot\($0)") })
    let gate = FakeStoppable.Gate()
    gateway.gate = gate

    let model = EmergencyStopModel(gateways: { [gateway] })
    await model.begin()

    let running = Task { await model.confirm() }
    try await eventually("all four stops to be under way") { gate.waiters == 4 }
    #expect(model.isBusy)
    #expect(model.phase != .idle)

    gate.open()
    await running.value
    #expect(gateway.peak == 4)
    #expect(summary(model)?.stopped == 4)
  }

  @Test("a turn that cannot be stopped is a line in the summary, and the rest are stopped all the same")
  func partialFailure() async {
    let gateway = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher"), turn("rt-2", bot: "writer"), turn("rt-3", bot: "ops")])
    gateway.outcomes = ["rt-2": .failed("session not found"), "rt-3": .alreadyDone]

    let model = EmergencyStopModel(gateways: { [gateway] })
    await model.begin()
    await model.confirm()

    #expect(Set(gateway.stopped) == ["rt-1", "rt-2", "rt-3"], "one failure does not leave the others running")

    let done = summary(model)
    #expect(done?.stopped == 1)
    #expect(done?.alreadyDone == 1)
    #expect(done?.failed == 1)
    #expect(done?.records.map(\.outcome) == [.stopped, .failed("session not found"), .alreadyDone])
  }

  @Test("with nothing running it says so, without asking")
  func nothingRunning() async {
    let gateway = FakeStoppable(id: "g1", name: "Home", turns: [], unreachable: 0)
    let model = EmergencyStopModel(gateways: { [gateway] })

    await model.begin()

    #expect(summary(model)?.wasIdle == true)
    #expect(plan(model) == nil)

    model.dismiss()
    #expect(model.phase == .idle)
  }

  @Test("what the gateway lists but this connection may not stop, a list that could not be read, and gateways out of reach are all said")
  func saysWhatItCouldNotReach() async {
    let live = FakeStoppable(
      id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")], unreachable: 2, complete: false)
    let down = FakeStoppable(id: "g2", name: "Work", turns: [])
    down.reading = nil

    let model = EmergencyStopModel(gateways: { [live, down] }, notConnected: { ["Cabin"] })
    await model.begin()

    let asked = plan(model)
    #expect(asked?.total == 1)
    #expect(asked?.unreachable == 2)
    #expect(asked?.incomplete == true)
    #expect(asked?.notAsked == ["Cabin", "Work"])

    await model.confirm()

    let done = summary(model)
    #expect(done?.unreachable == 2)
    #expect(done?.incomplete == true)
    #expect(done?.notAsked == ["Cabin", "Work"])
    #expect(down.stopped.isEmpty)
  }

  @Test("more than one gateway: each is read and stopped by itself, and the plan keeps them apart")
  func twoGateways() async {
    let one = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    let two = FakeStoppable(id: "g2", name: "Work", turns: [turn("rt-1", bot: "researcher"), turn("rt-2", bot: "ops")])
    two.outcomes = ["rt-2": .failed("busy")]

    let model = EmergencyStopModel(gateways: { [one, two] })
    await model.begin()
    #expect(plan(model)?.total == 3)
    #expect(plan(model)?.entries.map(\.gatewayId) == ["g1", "g2"])

    await model.confirm()

    #expect(one.stopped == ["rt-1"])
    #expect(Set(two.stopped) == ["rt-1", "rt-2"], "the same runtime id on another gateway is another turn")

    let ids = summary(model)?.records.map(\.id)
    #expect(Set(ids ?? []).count == 3, "no two lines of the summary share an identity")
    #expect(summary(model)?.records.map(\.gatewayName) == ["Home", "Work", "Work"])
    #expect(summary(model)?.failed == 1)
  }

  @Test("Cancel on the question stops nothing, and asking again reads again")
  func cancel() async {
    let gateway = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    let model = EmergencyStopModel(gateways: { [gateway] })

    await model.begin()
    model.cancel()
    #expect(model.phase == .idle)
    #expect(gateway.stopped.isEmpty)

    await model.confirm()
    #expect(model.phase == .idle, "there is nothing to confirm after a cancel")
    #expect(gateway.stopped.isEmpty)

    await model.begin()
    #expect(plan(model)?.total == 1)
    #expect(gateway.reads == 2)
  }

  @Test("a connection that went while the question was up is a failure of its turns, not a silent pass")
  func connectionGoesBeforeYes() async {
    let gateway = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    let held = Held(gateways: [gateway])
    let model = EmergencyStopModel(gateways: { held.gateways })

    await model.begin()
    held.gateways = []
    await model.confirm()

    let done = summary(model)
    #expect(done?.records.map(\.outcome) == [.notConnected])
    #expect(done?.failed == 1)
  }

  @Test("asking again while a stop is under way changes nothing")
  func busyIgnoresBegin() async throws {
    let gateway = FakeStoppable(id: "g1", name: "Home", turns: [turn("rt-1", bot: "researcher")])
    let gate = FakeStoppable.Gate()
    gateway.gate = gate
    let model = EmergencyStopModel(gateways: { [gateway] })

    await model.begin()
    let running = Task { await model.confirm() }
    try await eventually("the stop to be under way") { gate.waiters == 1 }

    await model.begin()
    #expect(gateway.reads == 1, "no second reading in the middle of a stop")

    gate.open()
    await running.value
    #expect(summary(model)?.stopped == 1)
  }
}
