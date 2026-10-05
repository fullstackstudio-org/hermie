import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

// The agents overview: what is made of what was read (`AgentsOverview.make`), what each gateway answer becomes
// (`AgentsService`, over a scripted link with `session.active_list`, `delegation.status` and a cron backend that
// answer as the gateway does), and how the model keeps it (`AgentsModel`).

private let researcher = Bot(name: "researcher", displayName: "Researcher")
private let writer = Bot(name: "writer", displayName: "Writer")
private let coder = Bot(name: "coder", displayName: "Coder")

/// 2026-10-05 12:00:00 UTC.
private let agentsNoon = Date(timeIntervalSince1970: 1_791_201_600)

private func session(
  _ bot: String?, id: String = "rt", status: String = "working", title: String = "", preview: String = "",
  started: Double? = nil
) -> BotRoster.ActiveSession {
  BotRoster.ActiveSession(
    id: id, sessionKey: "key-\(id)", status: status, title: title, preview: preview, startedAt: started, bot: bot)
}

private func make(
  bots: [Bot] = [researcher, writer, coder], active: [BotRoster.ActiveSession]? = [], live: [ChatState] = [],
  subagents: [String: [AgentSubagent]] = [:], jobs: [CronJob]? = nil, waiting: [String: Int] = [:]
) -> AgentsOverview {
  AgentsOverview.make(
    AgentsInput(bots: bots, active: active, live: live, subagents: subagents, jobs: jobs, waiting: waiting, now: agentsNoon))
}

/// A chat of `bot` with one tool call that is still running.
private func chatRunningTool(_ bot: String, name: String = "web_search", context: String? = "latest rates") -> ChatState {
  var chat = createChatState(bot, "stored-\(bot)", "stored-\(bot)")
  let id = "tool-1"

  chat.items[id] = .tool(
    ToolItem(
      base: ItemBase(id: id, seq: 1, ts: 1, origin: .live, version: 0), toolID: "t1", name: name, context: context,
      status: .running, resultKnown: false))
  chat.order.append(id)

  return chat
}

private func agentsJob(
  _ id: String, name: String = "", profile: String? = "researcher", next: TimeInterval? = 3600, enabled: Bool = true,
  schedule: String = "every 1h"
) -> CronJob {
  CronJob(
    id: id, name: name.isEmpty ? "Job \(id)" : name, schedule: schedule, enabled: enabled,
    state: enabled ? "scheduled" : "paused", nextRunAt: next.map { agentsNoon.addingTimeInterval($0) }, profile: profile)
}

@Suite("Agents overview: what is made of what was read")
struct AgentsOverviewMakeTests {
  @Test func everyBotIsIdleWhenNothingRuns() {
    let overview = make()

    #expect(overview.rows.map(\.bot.name) == ["researcher", "writer", "coder"])
    #expect(overview.rows.allSatisfy { $0.state == .idle })
    #expect(overview.idle == 3 && overview.running == 0 && overview.waiting == 0)
    #expect(overview.isComplete)
  }

  @Test func aBotWithABusySessionIsRunningAndTheOthersAreNot() {
    let overview = make(active: [session("writer", title: "Draft", preview: "Writing the intro", started: 1_791_201_000)])

    #expect(overview.row(for: "writer")?.state == .running)
    #expect(overview.row(for: "writer")?.sessionTitle == "Draft")
    #expect(overview.row(for: "writer")?.preview == "Writing the intro")
    #expect(overview.row(for: "writer")?.startedAt == Date(timeIntervalSince1970: 1_791_201_000))
    #expect(overview.row(for: "researcher")?.state == .idle)
    #expect(overview.running == 1)
  }

  @Test func aBotParkedOnAQuestionIsWaitingForYouWhetherTheGatewayOrTheInboxSaysSo() {
    let byStatus = make(active: [session("writer", status: "waiting")])
    let byInbox = make(waiting: ["coder": 2])

    #expect(byStatus.row(for: "writer")?.state == .waiting)
    #expect(byInbox.row(for: "coder")?.state == .waiting, "an inbox item is waiting even with no turn running")
    #expect(byInbox.row(for: "coder")?.waitingCount == 2)
    #expect(byInbox.waiting == 1)
  }

  @Test func theRowsAreWaitingFirstThenRunningThenIdleAndTheRosterOrderHoldsInsideEach() {
    let overview = make(
      active: [session("researcher", id: "a"), session("coder", id: "b")], waiting: ["writer": 1])

    #expect(overview.rows.map(\.bot.name) == ["writer", "researcher", "coder"])
    #expect(overview.rows.map(\.state) == [.waiting, .running, .running])
  }

  @Test func aSessionNoBotOwnsIsCountedAndNamesNobody() {
    let overview = make(active: [session(nil, id: "cron_1"), session(nil, id: "branch"), session("writer")])

    #expect(overview.otherRunning == 2)
    #expect(overview.running == 1)
  }

  @Test func theLiveChatSaysWhichToolRunsWhileTheTurnRuns() {
    let overview = make(active: [session("researcher")], live: [chatRunningTool("researcher")])

    #expect(overview.row(for: "researcher")?.tool == AgentTool(name: "web_search", context: "latest rates"))
    #expect(overview.row(for: "writer")?.tool == nil)
  }

  @Test func aToolThatFinishedIsNotTheCurrentOne() {
    var chat = chatRunningTool("researcher")
    if case .tool(var tool)? = chat.items["tool-1"] {
      tool.status = .complete
      chat.items["tool-1"] = .tool(tool)
    }

    let overview = make(active: [session("researcher")], live: [chat])

    #expect(overview.row(for: "researcher")?.tool == nil)
  }

  @Test func theGatewaysListIsTheTruthOverAChatThatThinksItIsBusy() {
    let overview = make(active: [], live: [chatRunningTool("researcher")])

    #expect(overview.row(for: "researcher")?.state == .idle, "the gateway says that turn is over")
    #expect(overview.row(for: "researcher")?.tool == nil)
  }

  @Test func whenTheListCannotBeReadTheOpenChatsAreAllThereIsAndTheOverviewSaysItGuessed() {
    let overview = make(active: nil, live: [chatRunningTool("researcher")])

    #expect(overview.isComplete == false)
    #expect(overview.row(for: "researcher")?.state == .running)
    #expect(overview.row(for: "writer")?.state == .idle)
    #expect(overview.otherRunning == 0)
  }

  @Test func subagentsBelongToTheirBotAndTheNewestComesFirst() {
    let older = AgentSubagent(id: "s1", goal: "Audit", startedAt: agentsNoon.addingTimeInterval(-600))
    let newer = AgentSubagent(id: "s2", goal: "Fix", status: "queued", startedAt: agentsNoon.addingTimeInterval(-60))
    let overview = make(active: [session("coder")], subagents: ["coder": [older, newer]])

    #expect(overview.row(for: "coder")?.subagents.map(\.id) == ["s2", "s1"])
    #expect(overview.subagentCount == 2)
    #expect(overview.subagents.map(\.subagent.id) == ["s2", "s1"])
    #expect(overview.subagents.allSatisfy { $0.bot.name == "coder" })
  }

  @Test func theNextRunsAreSoonestFirstAndEachBotKnowsItsOwn() {
    let overview = make(
      jobs: [
        agentsJob("late", profile: "writer", next: 7200),
        agentsJob("soon", profile: "researcher", next: 600),
        agentsJob("mid", profile: "researcher", next: 1800),
        agentsJob("elsewhere", profile: "stranger", next: 60),
        agentsJob("nobody", profile: nil, next: 120)
      ])

    #expect(overview.upcoming.map(\.name) == ["Job elsewhere", "Job nobody", "Job soon", "Job mid", "Job late"])
    #expect(overview.row(for: "researcher")?.nextCron?.name == "Job soon")
    #expect(overview.row(for: "writer")?.nextCron?.name == "Job late")
    #expect(overview.row(for: "coder")?.nextCron == nil)
    #expect(overview.upcoming.first { $0.name == "Job elsewhere" }?.bot == nil, "a profile that is not a bot")
    #expect(overview.cronsKnown)
  }

  @Test func aPausedJobAndOneWithNoNextRunAreNotUpcoming() {
    let overview = make(
      jobs: [
        agentsJob("paused", enabled: false), agentsJob("never", next: nil), agentsJob("fine", next: 30)
      ])

    #expect(overview.upcoming.map(\.name) == ["Job fine"])
  }

  @Test func theUpcomingListIsCappedAndTwoJobsWithTheSameNameInTwoStoresAreTwo() {
    let many = (0..<20).map { agentsJob("j\($0)", next: Double($0 + 1) * 60) }
    let overview = make(jobs: many)

    #expect(overview.upcoming.count == AgentsOverview.upcomingLimit)
    #expect(overview.upcoming.first?.name == "Job j0")

    let twin = make(jobs: [agentsJob("daily", profile: "researcher", next: 60), agentsJob("daily", profile: "writer", next: 120)])
    #expect(Set(twin.upcoming.map(\.id)).count == 2)
  }

  @Test func aCronListThatCouldNotBeReadIsUnknownNotEmpty() {
    #expect(make(jobs: nil).cronsKnown == false)
    #expect(make(jobs: []).cronsKnown)
  }

  @Test func aLongOrMultilineLineIsCutToOne() {
    let preview = "first line\nsecond line " + String(repeating: "x", count: 300)
    let overview = make(active: [session("writer", preview: preview)])
    let shown = overview.row(for: "writer")?.preview ?? ""

    #expect(!shown.contains("\n"))
    #expect(shown.count == AgentsOverview.previewLimit + 1, "cut, with an ellipsis")
    #expect(shown.hasSuffix("…"))
    #expect(make(active: [session("writer", preview: "  \n ")]).row(for: "writer")?.preview == nil)
  }

  @Test func theInboxIsCountedPerBotForOneGatewayOnly() {
    func item(_ id: String, gateway: String, bot: String) -> NeedsYouItem {
      NeedsYouItem(
        id: id, gatewayId: gateway, gatewayName: gateway, gatewayKey: gateway, bot: bot, botName: bot,
        kind: .approval, method: "approval", requestId: id, since: agentsNoon)
    }

    let counts = AgentsOverview.waitingCounts(
      in: [
        item("1", gateway: "g1", bot: "writer"), item("2", gateway: "g1", bot: "writer"),
        item("3", gateway: "g1", bot: "coder"), item("4", gateway: "g2", bot: "coder")
      ], gatewayId: "g1")

    #expect(counts == ["writer": 2, "coder": 1])
  }
}

// MARK: - The gateway's answers

/// A cron backend that lists what it is given.
private final class AgentsStubCrons: CronBackend, @unchecked Sendable {
  var jobs: [CronJob]?

  init(_ jobs: [CronJob]?) { self.jobs = jobs }

  func list() async throws -> CronListing {
    guard let jobs else { throw GatewayRPCError(.rejected, "no crons", code: 500) }
    return CronListing(jobs: jobs, gatewayRunning: true)
  }

  func detail(of job: CronJob) async throws -> CronJob { job }
  func runs(of job: CronJob) async throws -> [CronRun] { [] }
  func deliveryTargets() async -> [CronDeliveryTarget] { [.local] }
  func pause(_ job: CronJob) async throws {}
  func resume(_ job: CronJob) async throws {}
  func runNow(_ job: CronJob) async throws {}
  func create(_ input: CronJobInput) async throws {}
  func update(_ job: CronJob, _ input: CronJobInput) async throws -> CronJob { job }
  func remove(_ job: CronJob) async throws {}
  func transcript(of run: CronRun, in job: CronJob) async throws -> CronRunTranscript {
    CronRunTranscript(rows: [], shape: .rpc)
  }
}

@MainActor
@Suite("Agents overview: over a session's gateway answers", .timeLimit(.minutes(1)))
struct AgentsServiceTests {
  private static func row(id: String, key: String, status: String = "working", title: String = "", preview: String = "")
    -> JSONValue
  {
    [
      "id": .string(id), "session_key": .string(key), "status": .string(status), "title": .string(title),
      "preview": .string(preview), "model": "example-model", "started_at": 1_791_201_000
    ]
  }

  private func service(_ harness: SessionHarness, crons: AgentsStubCrons? = nil) -> AgentsService {
    AgentsService(link: harness.link, store: harness.session.store, roster: harness.session.roster, cron: crons)
  }

  @Test("the busy rows are attributed to the bot whose session they are, and an idle row is not busy")
  func attributesTheActiveList() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.respond(
      to: RPC.SessionActiveList.name,
      with: [
        "sessions": [
          Self.row(id: "rt-9", key: Fixture.stored, status: "waiting", title: "Weekly report", preview: "Which one?"),
          Self.row(id: "rt-cron", key: "cron_job_1", title: "A cron run"),
          Self.row(id: "rt-idle", key: "idle", status: "idle")
        ]
      ])

    let sessions = try #require(await service(harness).activeSessions())

    #expect(sessions.count == 2, "the idle row is dropped")
    let own = try #require(sessions.first { $0.bot == Fixture.profile })
    #expect(own.status == "waiting")
    #expect(own.title == "Weekly report" && own.preview == "Which one?")
    #expect(own.startedAt == 1_791_201_000)
    #expect(sessions.first { $0.id == "rt-cron" }?.bot == nil, "a cron's run is nobody's")

    await harness.session.shutdown()
  }

  @Test("a list the gateway refuses is unknown, not empty")
  func anUnreadableListIsNil() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.refuse(RPC.SessionActiveList.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    #expect(await service(harness).activeSessions() == nil)

    await harness.session.shutdown()
  }

  @Test("delegation.status is asked once per bot, by profile, and its active children are read")
  func readsSubagentsPerProfile() async throws {
    let harness = SessionHarness()
    harness.link.respond(to: RPC.DelegationStatus.name) { params in
      guard params["profile"]?.stringValue == "researcher" else { return ["active": []] }

      return [
        "active": [
          ["subagent_id": "sa-1", "goal": "Audit the dependencies", "status": "running", "tool_count": 3,
            "model": "example-model", "started_at": 1_791_201_300],
          ["subagent_id": "sa-2", "goal": "Fix", "status": "queued"],
          ["subagent_id": "sa-1", "goal": "a duplicate id"],
          ["goal": "no id at all"]
        ]
      ]
    }

    let found = await service(harness).subagents(of: [researcher, writer])

    #expect(found.keys.sorted() == ["researcher"], "a bot with none is left out")
    #expect(found["researcher"]?.map(\.id) == ["sa-1", "sa-2"])
    #expect(found["researcher"]?.first?.goal == "Audit the dependencies")
    #expect(found["researcher"]?.first?.toolCount == 3)
    #expect(found["researcher"]?.first?.startedAt == Date(timeIntervalSince1970: 1_791_201_300))
    #expect(found["researcher"]?.last?.status == "queued")
    #expect(harness.link.calls(RPC.DelegationStatus.name).count == 2)

    await harness.session.shutdown()
  }

  @Test("a gateway without delegation reports no sub-agents instead of failing")
  func noDelegation() async throws {
    let harness = SessionHarness()
    harness.link.refuse(RPC.DelegationStatus.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }

    #expect(await service(harness).subagents(of: [researcher]).isEmpty)

    await harness.session.shutdown()
  }

  @Test("the cron list is what the cron backend lists, and nil when it cannot")
  func readsCrons() async throws {
    let harness = SessionHarness()

    #expect(await service(harness).cronJobs() == nil, "no REST side, no schedule")
    #expect(await service(harness, crons: AgentsStubCrons([agentsJob("a")])).cronJobs()?.map(\.id) == ["a"])
    #expect(await service(harness, crons: AgentsStubCrons(nil)).cronJobs() == nil, "a refusal is not an empty schedule")

    await harness.session.shutdown()
  }

  @Test("everything together: the overview of a bot waiting, with the cron that runs next")
  func theWholeOverview() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.respond(
      to: RPC.SessionActiveList.name,
      with: ["sessions": [Self.row(id: "rt-9", key: Fixture.stored, status: "waiting")]])
    harness.link.respond(to: RPC.DelegationStatus.name, with: ["active": []])
    // The roster is read again by the full read.
    harness.link.respond(to: RPC.ProfilesList.name, with: SessionHarness.roster)

    let model = AgentsModel(backend: service(harness, crons: AgentsStubCrons([agentsJob("c1", profile: Fixture.profile, next: 900)])))
    await model.refresh()

    let row = try #require(model.overview.row(for: Fixture.profile))
    #expect(row.state == .waiting)
    #expect(row.nextCron?.name == "Job c1")
    #expect(model.overview.upcoming.count == 1)
    #expect(model.phase == .ready)

    await harness.session.shutdown()
  }
}

// MARK: - The model

private final class StubAgents: AgentsBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var state = State()

  struct State {
    var bots: [Bot] = [researcher, writer]
    var active: [BotRoster.ActiveSession]? = []
    var live: [ChatState] = []
    var subagents: [String: [AgentSubagent]] = [:]
    var jobs: [CronJob]? = []
    var asked: [[String]] = []
    var rosterReads = 0
    var cronReads = 0
    var gate: CheckedContinuation<Void, Never>?
    var hold = false
  }

  var read: State { lock.withLock { state } }

  func set(_ change: (inout State) -> Void) { lock.withLock { change(&state) } }

  var changes: AsyncStream<Void>.Continuation?
  private var stream: AsyncStream<Void>?

  init() {
    let made = AsyncStream<Void>.makeStream()
    stream = made.stream
    changes = made.continuation
  }

  func heldBots() async -> [Bot] { read.bots }

  func bots() async -> [Bot] {
    lock.withLock { state.rosterReads += 1 }
    return read.bots
  }

  func activeSessions() async -> [BotRoster.ActiveSession]? {
    // What the gateway says when it is asked, however long the answer takes to arrive.
    let answer = read.active

    if lock.withLock({ state.hold }) {
      await withCheckedContinuation { continuation in lock.withLock { state.gate = continuation } }
    }

    return answer
  }

  func liveStates() async -> [ChatState] { read.live }

  func subagents(of bots: [Bot]) async -> [String: [AgentSubagent]] {
    lock.withLock { state.asked.append(bots.map(\.name)) }
    return read.subagents
  }

  func cronJobs() async -> [CronJob]? {
    lock.withLock { state.cronReads += 1 }
    return read.jobs
  }

  func cronChanges() -> AsyncStream<Void> { stream ?? AsyncStream { $0.finish() } }

  func release() {
    let gate = lock.withLock { () -> CheckedContinuation<Void, Never>? in
      defer { state.gate = nil; state.hold = false }
      return state.gate
    }

    gate?.resume()
  }
}

@MainActor
@Suite("Agents overview: the model", .timeLimit(.minutes(1)))
struct AgentsModelTests {
  private func model(_ backend: StubAgents) -> AgentsModel {
    AgentsModel(backend: backend, now: { agentsNoon }, debounce: .milliseconds(10))
  }

  @Test func nothingIsShownBeforeTheFirstRead() {
    let model = model(StubAgents())

    #expect(model.phase == .loading)
    #expect(model.overview.rows.isEmpty)
  }

  @Test func aFullReadFillsTheWholeOverview() async {
    let backend = StubAgents()
    backend.set {
      $0.active = [session("researcher")]
      $0.jobs = [agentsJob("c", profile: "writer", next: 60)]
    }
    let model = model(backend)

    await model.refresh()

    #expect(model.phase == .ready)
    #expect(model.overview.rows.map(\.state) == [.running, .idle])
    #expect(model.overview.row(for: "writer")?.nextCron?.name == "Job c")
  }

  @Test func onlyTheBusyBotsAreAskedForSubagentsAndEveryBotWhenTheListIsUnreadable() async {
    let backend = StubAgents()
    backend.set { $0.active = [session("writer")] }
    let model = model(backend)

    await model.refresh()
    #expect(backend.read.asked.last == ["writer"])

    backend.set { $0.active = nil }
    await model.refreshLive()
    #expect(backend.read.asked.last == ["researcher", "writer"])
    #expect(model.overview.isComplete == false)
  }

  @Test func aLiveReadDoesNotReadTheRosterOrTheCronsAgain() async {
    let backend = StubAgents()
    let model = model(backend)

    await model.refresh()
    await model.refreshLive()
    await model.refreshLive()

    #expect(backend.read.rosterReads == 1)
    #expect(backend.read.cronReads == 1)
  }

  @Test func theSubagentsShowUnderTheirBotAfterALiveRead() async {
    let backend = StubAgents()
    let model = model(backend)
    await model.refresh()

    backend.set {
      $0.active = [session("researcher")]
      $0.subagents = ["researcher": [AgentSubagent(id: "s1", goal: "Audit")]]
    }
    await model.refreshLive()

    #expect(model.overview.row(for: "researcher")?.subagents.map(\.id) == ["s1"])
    #expect(model.overview.running == 1)
  }

  @Test func aCronListThatFailsKeepsTheOneOnScreen() async {
    let backend = StubAgents()
    backend.set { $0.jobs = [agentsJob("c", profile: "writer", next: 60)] }
    let model = model(backend)
    await model.refresh()

    backend.set { $0.jobs = nil }
    await model.refresh()
    #expect(model.overview.upcoming.count == 1, "a flaky read is no reason to empty the schedule")

    await model.refreshCrons()
    #expect(model.overview.upcoming.count == 1)

    backend.set { $0.jobs = [] }
    await model.refreshCrons()
    #expect(model.overview.upcoming.isEmpty, "a list that says nothing is scheduled is believed")
  }

  @Test func whatWaitsInTheInboxChangesTheOverviewWithoutAGatewayRead() async {
    let backend = StubAgents()
    let model = model(backend)
    model.setWaiting(["writer": 1])
    #expect(model.phase == .loading, "nothing is drawn from a count before there are bots")

    await model.refresh()
    let reads = backend.read.rosterReads
    #expect(model.overview.row(for: "writer")?.state == .waiting)

    model.setWaiting([:])
    #expect(model.overview.row(for: "writer")?.state == .idle)
    #expect(backend.read.rosterReads == reads)
  }

  @Test func aReadANewerOneOvertookIsDropped() async {
    let backend = StubAgents()
    let model = model(backend)
    await model.refresh()

    // A read that asks while the researcher runs, and whose answer is slow to arrive.
    backend.set {
      $0.active = [session("researcher")]
      $0.hold = true
    }
    let slow = Task { @MainActor in await model.refreshLive() }

    while backend.read.gate == nil { await Task.yield() }

    // A newer read asks after the writer took over, and its answer is what stays on screen.
    backend.set {
      $0.active = [session("writer")]
      $0.hold = false
    }
    await model.refreshLive()
    #expect(model.overview.row(for: "writer")?.state == .running)

    backend.release()
    await slow.value

    #expect(model.overview.row(for: "writer")?.state == .running, "the overtaken read did not write")
    #expect(model.overview.row(for: "researcher")?.state == .idle)
  }

  @Test func theCronBroadcastReadsTheListAgainOnceForABurst() async {
    let backend = StubAgents()
    let model = model(backend)
    await model.refresh()
    let before = backend.read.cronReads

    let watching = Task { @MainActor in await model.watchCrons() }
    backend.set { $0.jobs = [agentsJob("new", profile: "writer", next: 120)] }

    backend.changes?.yield()
    backend.changes?.yield()
    backend.changes?.yield()

    while model.overview.upcoming.isEmpty { try? await Task.sleep(for: .milliseconds(5)) }
    try? await Task.sleep(for: .milliseconds(60))

    #expect(model.overview.upcoming.map(\.name) == ["Job new"])
    #expect(backend.read.cronReads == before + 1, "a burst is one read")

    watching.cancel()
  }
}
