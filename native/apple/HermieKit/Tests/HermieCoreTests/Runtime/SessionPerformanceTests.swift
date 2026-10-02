import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// 10,000 deltas through the whole runtime, measuring every hop onto the main
/// actor: the work a frame does there (the chat list's changed rows, the chat
/// screen's snapshot) must stay under 8 ms. Measured as this thread's CPU time,
/// which a loaded machine cannot inflate; wall time is reported beside it.
@Suite(.timeLimit(.minutes(2))) @MainActor struct SessionPerformanceTests {
  nonisolated static let deltas = 10_000
  nonisolated static let budget: Duration = .milliseconds(8)

  final class Timings: Sendable {
    private let storage = Mutex<[FrameTiming]>([])
    func append(_ timing: FrameTiming) { storage.withLock { $0.append(timing) } }
    var all: [FrameTiming] { storage.withLock { $0 } }
  }

  static func report(_ label: String, _ timings: [FrameTiming]) -> String {
    let cpu = timings.map(\.cpu).sorted()
    let wall = timings.map(\.wall).sorted()
    let p99 = { (values: [Duration]) in values[min(values.count - 1, values.count * 99 / 100)] }
    var load = [Double](repeating: 0, count: 3)
    _ = getloadavg(&load, 3)

    return """
      \(label): \(timings.count) frames for \(deltas) deltas; main-actor CPU per frame max \(cpu.last ?? .zero), \
      p99 \(p99(cpu)); wall max \(wall.last ?? .zero), p99 \(p99(wall)); \
      load average \(String(format: "%.1f %.1f %.1f", load[0], load[1], load[2]))
      """
  }

  @Test func tenThousandDeltasWithAManualFrameClock() async throws {
    let harness = SessionHarness()
    let timings = Timings()
    harness.session.frameTimings = { timings.append($0) }
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()

    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)

    for seq in 2...(Self.deltas + 1) {
      harness.link.emit("message.delta", session: Fixture.runtime, seq: seq, payload: ["text": "token "])

      // A frame every 100 deltas, as a 60 Hz display would see a fast stream.
      if seq % 100 == 0 {
        try await harness.frame()
      }
    }

    try await harness.frame()
    #expect(model.items.last?.item.asAssistant?.text.count == Self.deltas * 6)

    let all = timings.all
    let worst = all.map(\.cpu).max() ?? .zero
    print(Self.report("manual frames", all))
    #expect(all.count >= Self.deltas / 100)
    #expect(worst < Self.budget, "\(Self.report("manual frames", all))")
    await harness.session.shutdown()
  }

  @Test func tenThousandDeltasWithTheRealFrameClock() async throws {
    let link = ScriptedLink()
    link.respond(to: RPC.SubagentList.name, with: ["subagents": []])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": false])

    var options = GatewaySession.Options()
    options.store.now = { 1_790_000_000_000 }
    let session = GatewaySession(gatewayID: "g1", link: link, options: options)
    let timings = Timings()
    session.frameTimings = { timings.append($0) }

    await session.start()
    link.status(.ready)
    try await link.answerNext(RPC.ProfilesList.name, SessionHarness.roster)
    try await eventually("the roster") { await session.roster.bot(named: bot) != nil }
    let model = session.chat(bot)
    let opening = Task { @MainActor in try await session.open(bot) }
    try await link.answerNext(RPC.SessionResume.name, Fixture.resume())
    try await link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await opening.value

    // Produced off the main actor, as the connection would.
    await Task.detached {
      link.emit("message.start", session: Fixture.runtime, seq: 1)

      for seq in 2...(Self.deltas + 1) {
        link.emit("message.delta", session: Fixture.runtime, seq: seq, payload: ["text": "token "])
      }
    }.value

    try await eventually("every delta on screen") {
      await model.items.last?.item.asAssistant?.text.count == Self.deltas * 6
    }

    let all = timings.all
    let worst = all.map(\.cpu).max() ?? .zero
    print(Self.report("real frames", all))
    #expect(worst < Self.budget, "\(Self.report("real frames", all))")
    await session.shutdown()
  }
}
