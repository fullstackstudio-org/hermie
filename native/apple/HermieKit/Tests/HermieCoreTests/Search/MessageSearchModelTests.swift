import Foundation
import HermieGateway
import Synchronization
import Testing

@testable import HermieCore

// The roster search, against a scripted gateway: which requests go out, what is dropped, what a
// superseded or cancelled query leaves behind, and what a failure says.

/// A latch the scripted search waits on; opening it lets every waiter, present and future, through.
/// A waiter whose task is cancelled is let out with `CancellationError`, as a cancelled request would be.
final class SearchGate: Sendable {
  private struct State {
    var open = false
    var next: UInt64 = 0
    var waiters: [UInt64: CheckedContinuation<Void, any Error>] = [:]
  }

  private let state = Mutex(State())

  func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [:] }
      return Array(state.waiters.values)
    }

    for waiter in waiters {
      waiter.resume()
    }
  }

  func wait() async throws {
    let id = state.withLock { state in
      state.next += 1
      return state.next
    }

    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let outcome = state.withLock { state -> Bool? in
          if state.open { return true }
          if Task.isCancelled { return false }
          state.waiters[id] = continuation
          return nil
        }

        switch outcome {
        case true?: continuation.resume()
        case false?: continuation.resume(throwing: CancellationError())
        case nil: break
        }
      }
    } onCancel: {
      let waiter = state.withLock { $0.waiters.removeValue(forKey: id) }
      waiter?.resume(throwing: CancellationError())
    }
  }
}

/// The gateway side of `GET /api/sessions/search`, one answer per profile.
final class SearchScript: Sendable {
  struct Call: Sendable, Equatable {
    var profile: String
    var query: String
    var limit: Int
    var timeoutMs: Int
  }

  private struct State {
    var calls: [Call] = []
    var inFlight = 0
    var peak = 0
    var cancelled = 0
    var answers: [String: Result<[SessionSearchHit], any Error>] = [:]
    var gated = false
  }

  private let state = Mutex(State())
  let gate = SearchGate()

  /// `gated`: the scripted calls wait on the gate before answering.
  init(gated: Bool = false, answers: [String: Result<[SessionSearchHit], any Error>] = [:]) {
    state.withLock {
      $0.gated = gated
      $0.answers = answers
    }
  }

  func setGated(_ gated: Bool) {
    state.withLock { $0.gated = gated }
  }

  var calls: [Call] { state.withLock { $0.calls } }
  var peak: Int { state.withLock { $0.peak } }
  var cancelled: Int { state.withLock { $0.cancelled } }

  func answer(_ profile: String, _ result: Result<[SessionSearchHit], any Error>) {
    state.withLock { $0.answers[profile] = result }
  }

  func search(profile: String, query: String, limit: Int, timeoutMs: Int) async throws -> [SessionSearchHit] {
    let gated = state.withLock { state -> Bool in
      state.calls.append(Call(profile: profile, query: query, limit: limit, timeoutMs: timeoutMs))
      state.inFlight += 1
      state.peak = max(state.peak, state.inFlight)
      return state.gated
    }

    defer { state.withLock { $0.inFlight -= 1 } }

    if gated {
      do {
        try await gate.wait()
      } catch {
        state.withLock { $0.cancelled += 1 }
        throw error
      }
    }

    return try state.withLock { $0.answers[profile] ?? .success([]) }.get()
  }

  var search: MessageSearchModel.Search {
    { profile, query, limit, timeoutMs in
      try await self.search(profile: profile, query: query, limit: limit, timeoutMs: timeoutMs)
    }
  }
}

struct SearchRefused: Error {}

@MainActor
func botNamed(_ name: String, canonical: String? = nil, tip: String? = nil) -> Bot {
  Bot(
    name: name,
    canonical: canonical.map { CanonicalSession(id: $0, resolvedID: tip ?? $0) }
  )
}

/// Wait (without a real-time deadline of its own) until `count` calls have reached the script.
func untilCalls(_ script: SearchScript, _ count: Int) async throws {
  try await eventually("\(count) searches to go out") { script.calls.count >= count }
}

@MainActor
@Suite struct MessageSearchModelTests {
  private func model(_ script: SearchScript, debounce: Duration = .zero, concurrency: Int = 4) -> MessageSearchModel {
    MessageSearchModel(debounce: debounce, concurrency: concurrency, search: script.search)
  }

  private func hit(_ id: String, snippet: String = "a >>>word<<<", at: Double? = nil, root: String? = nil)
    -> SessionSearchHit
  {
    SessionSearchHit(sessionID: id, lineageRoot: root, snippet: snippet, role: "assistant", at: at)
  }

  @Test func theBestHitOfEachBotComesBackNewestFirst() async {
    let script = SearchScript(answers: [
      "ada": .success([hit("s-ada", at: 100)]),
      "bob": .success([hit("s-bob", at: 300)]),
      "cy": .success([hit("s-cy", at: 200)]),
    ])
    let model = model(script)

    await model.run(
      query: "word",
      bots: [botNamed("ada", canonical: "s-ada"), botNamed("bob", canonical: "s-bob"), botNamed("cy", canonical: "s-cy")],
      ready: true)

    #expect(model.matches.map(\.bot) == ["bob", "cy", "ada"])
    #expect(model.matches.first?.snippet == "a >>>word<<<")
    #expect(model.matches.first?.role == "assistant")
    #expect(model.query == "word")
    #expect(model.searching == false)
    #expect(model.failed == false)
  }

  @Test func theRequestCarriesTheTrimmedWordsAndTheTuning() async {
    let script = SearchScript()
    let model = model(script)

    await model.run(query: "  needle  ", bots: [botNamed("ada", canonical: "s")], ready: true)

    #expect(script.calls == [.init(profile: "ada", query: "needle", limit: 5, timeoutMs: 8_000)])
    #expect(model.query == "needle")
  }

  @Test func aHitInAConversationThatIsNotTheBotChatIsDropped() async {
    let script = SearchScript(answers: [
      // A cron run in the same profile: not the forever-chat, so not a place to open.
      "ada": .success([hit("cron-run-9")]),
      // The tip of the compression lineage, found from the stored root the roster knows.
      "bob": .success([hit("tip-2", root: "s-bob")]),
      // The tip the roster resolved.
      "cy": .success([hit("tip-cy")]),
      // No canonical chat at all.
      "dee": .success([hit("s-dee")]),
    ])
    let model = model(script)

    await model.run(
      query: "word",
      bots: [
        botNamed("ada", canonical: "s-ada"), botNamed("bob", canonical: "s-bob"),
        botNamed("cy", canonical: "s-cy", tip: "tip-cy"), botNamed("dee"),
      ],
      ready: true)

    #expect(model.matches.map(\.bot).sorted() == ["bob", "cy"])
  }

  @Test func theFirstCanonicalHitWinsWhenTheGatewayAnswersSeveral() async {
    let script = SearchScript(answers: [
      "ada": .success([hit("cron-run-9", snippet: "no"), hit("s-ada", snippet: "yes"), hit("s-ada", snippet: "later")])
    ])
    let model = model(script)

    await model.run(query: "word", bots: [botNamed("ada", canonical: "s-ada")], ready: true)

    #expect(model.matches.map(\.snippet) == ["yes"])
  }

  @Test func nothingIsAskedForABlankFieldAnUnreadyConnectionOrNoBots() async {
    let script = SearchScript()
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s")]

    await model.run(query: "   ", bots: bots, ready: true)
    await model.run(query: "word", bots: bots, ready: false)
    await model.run(query: "word", bots: [], ready: true)

    #expect(script.calls.isEmpty)
    #expect(model.query == "")
    #expect(model.searching == false)
  }

  @Test func anEmptiedFieldClearsTheAnswerAtOnce() async {
    let script = SearchScript(answers: ["ada": .success([hit("s")])])
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s")]

    await model.run(query: "word", bots: bots, ready: true)
    #expect(model.matches.count == 1)

    await model.run(query: "", bots: bots, ready: true)

    #expect(model.matches.isEmpty)
    #expect(model.query == "")
    #expect(script.calls.count == 1)
  }

  @Test func aBotsFailureCostsThatBotsRowAndNothingElse() async {
    let script = SearchScript(answers: [
      "ada": .failure(SearchRefused()),
      "bob": .success([hit("s-bob")]),
    ])
    let model = model(script)

    await model.run(query: "word", bots: [botNamed("ada", canonical: "s-ada"), botNamed("bob", canonical: "s-bob")], ready: true)

    #expect(model.matches.map(\.bot) == ["bob"])
    #expect(model.failed == false)
  }

  @Test func everyBotFailingSaysTheSearchCouldNotRunInsteadOfNothingMatched() async {
    let script = SearchScript(answers: [
      "ada": .failure(SearchRefused()),
      "bob": .failure(GatewayError(.server, "HTTP 500", status: 500)),
    ])
    let model = model(script)

    await model.run(query: "word", bots: [botNamed("ada", canonical: "s-ada"), botNamed("bob", canonical: "s-bob")], ready: true)

    #expect(model.matches.isEmpty)
    #expect(model.failed)
    #expect(model.query == "word")
    #expect(model.searching == false)
  }

  @Test func aSearchThatFoundNothingIsNotAFailure() async {
    let script = SearchScript()
    let model = model(script)

    await model.run(query: "word", bots: [botNamed("ada", canonical: "s")], ready: true)

    #expect(model.matches.isEmpty)
    #expect(model.failed == false)
    #expect(model.query == "word")
  }

  @Test func aRosterSearchIsBoundedToFourRequestsAtOnce() async throws {
    let script = SearchScript(gated: true)
    let model = model(script)
    let bots = (1...10).map { botNamed("bot\($0)", canonical: "s\($0)") }

    let task = Task { await model.run(query: "word", bots: bots, ready: true) }

    try await untilCalls(script, 4)
    // Give a fifth the chance to go out, were the bound not there.
    for _ in 0..<50 { await Task.yield() }

    #expect(script.calls.count == 4)
    #expect(model.searching)

    script.gate.open()
    await task.value

    #expect(script.calls.count == 10)
    #expect(script.peak == 4)
    #expect(model.searching == false)
  }

  @Test func aSupersededQueryNeverPaintsOverTheNewOne() async throws {
    let script = SearchScript(gated: true, answers: [
      "ada": .success([hit("s-ada", snippet: "answer to either")])
    ])
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s-ada")]

    let first = Task { await model.run(query: "fir", bots: bots, ready: true) }
    try await untilCalls(script, 1)

    // The field moves on while the first request is still out. The first task is cancelled, as a
    // view's `.task(id:)` does, and the second search starts.
    first.cancel()
    let second = Task { await model.run(query: "first", bots: bots, ready: true) }
    try await untilCalls(script, 2)
    await first.value

    // The first request was cancelled, and said nothing.
    #expect(script.cancelled == 1)
    #expect(model.matches.isEmpty)
    #expect(model.query == "")
    #expect(model.searching)

    script.gate.open()
    await second.value

    #expect(model.query == "first")
    #expect(model.matches.map(\.bot) == ["ada"])
    #expect(model.searching == false)
  }

  @Test func aSupersededRunThatAnswersLateDoesNotOverwriteTheNewerAnswer() async throws {
    // Even a request that ignores cancellation (it answers anyway) is not believed once superseded.
    let script = SearchScript(gated: true, answers: ["ada": .success([hit("s-ada", snippet: "old")])])
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s-ada")]

    let first = Task { await model.run(query: "old", bots: bots, ready: true) }
    try await untilCalls(script, 1)

    let second = Task { await model.run(query: "new", bots: bots, ready: true) }
    try await untilCalls(script, 2)

    script.answer("ada", .success([hit("s-ada", snippet: "new")]))
    script.gate.open()
    await first.value
    await second.value

    #expect(model.query == "new")
    #expect(model.matches.map(\.snippet) == ["new"])
  }

  @Test func cancellingTheTaskStopsTheRequestsAndLeavesNothingSearching() async throws {
    let script = SearchScript(gated: true)
    let model = model(script)

    let task = Task { await model.run(query: "word", bots: [botNamed("ada", canonical: "s")], ready: true) }
    try await untilCalls(script, 1)
    #expect(model.searching)

    task.cancel()
    await task.value

    #expect(script.cancelled == 1)
    #expect(model.searching == false)
    #expect(model.matches.isEmpty)
    #expect(model.failed == false)
    #expect(model.query == "")
  }

  @Test func aQueryCancelledWhileTheFieldIsStillMovingNeverGoesOut() async {
    let script = SearchScript()
    let model = model(script, debounce: .seconds(30))

    let task = Task { await model.run(query: "wo", bots: [botNamed("ada", canonical: "s")], ready: true) }
    for _ in 0..<20 { await Task.yield() }
    task.cancel()
    await task.value

    #expect(script.calls.isEmpty)
    #expect(model.searching == false)
  }

  @Test func aNewQueryDropsTheOldAnswerBeforeItsOwnArrives() async throws {
    let script = SearchScript(answers: ["ada": .success([hit("s")])])
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s")]

    await model.run(query: "word", bots: bots, ready: true)
    #expect(model.matches.count == 1)

    script.setGated(true)
    let task = Task { await model.run(query: "other", bots: bots, ready: true) }
    try await untilCalls(script, 2)

    // The old answer is for other words: it must not stand under the field as if it answered these.
    #expect(model.matches.isEmpty)
    #expect(model.query == "")
    #expect(model.searching)

    script.gate.open()
    await task.value

    #expect(model.query == "other")
    #expect(model.matches.count == 1)
  }

  @Test func theSameWordsAskedAgainKeepTheirAnswerUpUntilTheNewOneIsIn() async throws {
    let script = SearchScript(answers: ["ada": .success([hit("s")])])
    let model = model(script)
    let bots = [botNamed("ada", canonical: "s")]

    await model.run(query: "word", bots: bots, ready: true)

    // The roster moved under the field (a bot came or went): the same words are searched again.
    script.setGated(true)
    let task = Task { await model.run(query: "word", bots: bots + [botNamed("bob", canonical: "t")], ready: true) }
    try await untilCalls(script, 3)
    script.gate.open()
    await task.value

    #expect(model.query == "word")
    #expect(model.searching == false)
  }

  @Test func theOrderDoesNotDependOnWhichRequestLandedFirst() {
    let matches = [
      MessageMatch(bot: "zed", sessionID: "z", snippet: "", at: 10),
      MessageMatch(bot: "ada", sessionID: "a", snippet: "", at: 10),
      MessageMatch(bot: "mid", sessionID: "m", snippet: "", at: nil),
      MessageMatch(bot: "new", sessionID: "n", snippet: "", at: 99),
    ]

    #expect(MessageSearchModel.order(matches).map(\.bot) == ["new", "ada", "zed", "mid"])
    #expect(MessageSearchModel.order(matches.reversed()).map(\.bot) == ["new", "ada", "zed", "mid"])
  }
}
