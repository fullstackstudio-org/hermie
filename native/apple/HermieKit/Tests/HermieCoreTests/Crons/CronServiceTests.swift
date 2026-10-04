import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private func service() -> (CronService, ScriptedLink, StubREST) {
  let link = ScriptedLink()
  let rest = StubREST()

  return (CronService(link: link, rest: rest), link, rest)
}

private let storedHeartbeat: JSONValue = [
  "id": "job-heartbeat",
  "name": "VM heartbeat",
  "prompt": "Check the VM.",
  "schedule_display": "every 30m",
  "profile": "default"
]

@Suite(.timeLimit(.minutes(1))) struct CronServiceTests {
  // MARK: The list

  @Test func theListIsTheHTTPAnswerForEveryProfileAndTheSocketSaysWhetherTheSchedulerRuns() async throws {
    let (service, link, rest) = service()
    rest.answer("GET", "/api/cron/jobs?profile=all", with: [storedHeartbeat, ["id": "job-inbox", "profile": "researcher"]])
    link.respond(to: RPC.CronManage.name, with: ["jobs": [], "gateway_running": false])

    let listing = try await service.list()

    #expect(listing.jobs.map(\.id) == ["job-heartbeat", "job-inbox"])
    #expect(listing.jobs.map(\.profile) == ["default", "researcher"])
    #expect(listing.gatewayRunning == false)

    let call = try #require(link.calls(RPC.CronManage.name).first)
    #expect(call.params["action"] == "list")
    #expect(call.params["include_disabled"] == true)
    #expect(call.params["profile"] == nil, "unscoped: only the flag is wanted from it")
  }

  @Test func aJobsEnvelopeIsReadAsWellAsABareArray() async throws {
    let (service, link, rest) = service()
    rest.answer("GET", "/api/cron/jobs?profile=all", with: ["jobs": [storedHeartbeat]])
    link.respond(to: RPC.CronManage.name, with: [:])

    let listing = try await service.list()

    #expect(listing.jobs.map(\.id) == ["job-heartbeat"])
    #expect(listing.gatewayRunning == nil, "an absent flag is unknown, not 'not running'")
  }

  @Test func aSocketThatCannotAnswerDoesNotFailTheList() async throws {
    let (service, link, rest) = service()
    rest.answer("GET", "/api/cron/jobs?profile=all", with: [storedHeartbeat])
    link.refuse(RPC.CronManage.name) { _ in GatewayRPCError(.notConnected, "gateway not connected") }

    let listing = try await service.list()

    #expect(listing.jobs.count == 1)
    #expect(listing.gatewayRunning == nil)
  }

  @Test func aListTheHTTPRouteRefusesThrows() async {
    let (service, link, rest) = service()
    link.respond(to: RPC.CronManage.name, with: [:])
    rest.refuse("GET", "/api/cron/jobs?profile=all", with: GatewayError(.server, "HTTP 502", status: 502))

    await #expect(throws: GatewayError.self) { try await service.list() }
  }

  // MARK: Detail, runs, targets

  @Test func theDetailAndItsRunsCarryTheJobsProfile() async throws {
    let (service, _, rest) = service()
    let job = CronJob(id: "job-inbox", profile: "researcher")
    rest.answer("GET", "/api/cron/jobs/job-inbox?profile=researcher", with: ["id": "job-inbox", "prompt": "Scan the inbox."])
    rest.answer(
      "GET", "/api/cron/jobs/job-inbox/runs?limit=20&profile=researcher",
      with: ["runs": [["id": "cron_job-inbox_2", "started_at": 2], ["id": "cron_job-inbox_1", "started_at": 1]], "limit": 20])

    let detail = try await service.detail(of: job)
    let runs = try await service.runs(of: job)

    #expect(detail.prompt == "Scan the inbox.")
    #expect(detail.profile == "researcher", "the detail may not carry the profile; the caller's is kept")
    #expect(runs.map(\.id) == ["cron_job-inbox_2", "cron_job-inbox_1"])
  }

  @Test func aJobWithNoProfileAsksWithoutOne() async throws {
    let (service, _, rest) = service()
    rest.answer("GET", "/api/cron/jobs/a%20b", with: ["job": ["id": "a b", "name": "wrapped"]])

    let detail = try await service.detail(of: CronJob(id: "a b"))

    #expect(rest.calls.map(\.path) == ["/api/cron/jobs/a%20b"], "the id is one path segment")
    #expect(detail.name == "wrapped", "a {job: …} wrapper is read too")
  }

  @Test func theDeliveryTargetsAreTheGatewaysOrJustLocal() async {
    let (service, _, rest) = service()
    rest.answer(
      "GET", "/api/cron/delivery-targets",
      with: ["targets": [["id": "local", "name": "Local (save only)"], ["id": "bot-chat:researcher", "name": "Bot Chat (researcher)"]]])

    #expect(await service.deliveryTargets().map(\.id) == ["local", "bot-chat:researcher"])

    rest.answer("GET", "/api/cron/delivery-targets", with: ["targets": []])
    #expect(await service.deliveryTargets() == [.local])

    rest.refuse("GET", "/api/cron/delivery-targets", with: GatewayError(.server, "HTTP 500", status: 500))
    #expect(await service.deliveryTargets() == [.local], "an editor with one option beats one that will not open")
  }

  // MARK: Run transcripts

  @Test func aRunIsReadWithSessionHistory() async throws {
    let (service, link, _) = service()
    link.respond(
      to: RPC.SessionHistory.name,
      with: ["count": 2, "messages": [["role": "user", "content": "Check the VM."], ["role": "assistant", "content": "All fine."]]])

    let transcript = try await service.transcript(
      of: CronRun(id: "cron_job-inbox_2"), in: CronJob(id: "job-inbox", profile: "researcher"))

    #expect(transcript.shape == .rpc)
    #expect(transcript.rows.count == 2)

    let call = try #require(link.calls(RPC.SessionHistory.name).first)
    #expect(call.params["session_id"] == "cron_job-inbox_2")
    #expect(call.params["profile"] == "researcher")
  }

  @Test func whereTheGatewayHasNoSessionHistoryTheRESTTranscriptIsRead() async throws {
    let (service, link, _) = service()
    link.refuse(RPC.SessionHistory.name) { _ in GatewayRPCError(.rejected, "unknown method", code: -32601) }
    link.setREST { id, _ in id == "cron_job-a_1" ? [TranscriptRow(json: ["role": "assistant", "content": "Done."])] : nil }

    let transcript = try await service.transcript(of: CronRun(id: "cron_job-a_1"), in: CronJob(id: "job-a"))

    #expect(transcript.shape == .rest)
    #expect(transcript.rows.count == 1)
  }

  @Test func aRunNeitherWayCanReadFailsWithTheSocketsReason() async {
    let (service, link, _) = service()
    link.refuse(RPC.SessionHistory.name) { _ in GatewayRPCError(.rejected, "session not found") }
    link.setREST { _, _ in nil }

    await #expect(throws: GatewayRPCError.self) {
      try await service.transcript(of: CronRun(id: "x"), in: CronJob(id: "j"))
    }
  }

  // MARK: Pause, resume, run now

  @Test func pausingAndResumingAreSocketCallsScopedToTheJobsProfile() async throws {
    let (service, link, _) = service()
    link.respond(to: RPC.CronManage.name, with: ["success": true])
    let job = CronJob(id: "job-inbox", profile: "researcher")

    try await service.pause(job)
    try await service.resume(CronJob(id: "job-heartbeat"))

    let calls = link.calls(RPC.CronManage.name)
    #expect(calls[0].params["action"] == "pause")
    #expect(calls[0].params["name"] == "job-inbox")
    #expect(calls[0].params["profile"] == "researcher", "without it the job is simply 'not found'")
    #expect(calls[1].params["action"] == "resume")
    #expect(calls[1].params["profile"] == nil)
  }

  @Test func aRefusalInTheAnswerIsAnErrorInTheGatewaysWords() async {
    let (service, link, _) = service()
    link.respond(to: RPC.CronManage.name, with: ["success": false, "error": "Job 'x' not found"])

    await #expect(throws: GatewayRPCError(.rejected, "Job 'x' not found")) {
      try await service.pause(CronJob(id: "x"))
    }

    link.respond(to: RPC.CronManage.name, with: ["success": false])
    await #expect(throws: GatewayRPCError(.rejected, "The gateway refused to resume this cron.")) {
      try await service.resume(CronJob(id: "x"))
    }
  }

  @Test func runNowPostsTheTriggerRoute() async throws {
    let (service, _, rest) = service()
    rest.answer("POST", "/api/cron/jobs/job-cleanup/trigger?profile=default", with: ["id": "job-cleanup", "last_status": "ok"])

    try await service.runNow(CronJob(id: "job-cleanup", profile: "default"))

    #expect(rest.calls == [.init(method: "POST", path: "/api/cron/jobs/job-cleanup/trigger?profile=default", body: [:])])
  }

  // MARK: Create, update, delete

  @Test func creatingIsASocketAddInTheScopeItWasGiven() async throws {
    let (service, link, _) = service()
    link.respond(to: RPC.CronManage.name, with: ["success": true, "job": ["job_id": "new"]])

    try await service.create(
      CronJobInput(
        name: "Nightly sweep", prompt: "Sweep the logs.", schedule: "every 6h", deliver: "bot-chat:researcher",
        repeatTimes: 3, profile: "writer"))

    let params = try #require(link.calls(RPC.CronManage.name).first).params
    #expect(params["action"] == "add")
    #expect(params["name"] == "Nightly sweep")
    #expect(params["schedule"] == "every 6h")
    #expect(params["prompt"] == "Sweep the logs.")
    #expect(params["deliver"] == "bot-chat:researcher")
    #expect(params["repeat"] == 3)
    #expect(params["profile"] == "writer", "the scope is the whole of 'create it for that bot'")
  }

  @Test func aCreateWithNoRepeatOrProfileSendsNeither() async throws {
    let (service, link, _) = service()
    link.respond(to: RPC.CronManage.name, with: ["success": true])

    try await service.create(CronJobInput(name: "n", prompt: "p", schedule: "every 1h"))

    let params = try #require(link.calls(RPC.CronManage.name).first).params
    #expect(params["repeat"] == nil)
    #expect(params["profile"] == nil)
  }

  @Test func aCreateTheGatewayRefusesThrowsItsReason() async {
    let (service, link, _) = service()
    link.respond(to: RPC.CronManage.name, with: ["success": false, "error": "Invalid schedule 'every 0m'"])

    await #expect(throws: GatewayRPCError(.rejected, "Invalid schedule 'every 0m'")) {
      try await service.create(CronJobInput(name: "n", prompt: "p", schedule: "every 0m"))
    }
  }

  @Test func updatingPutsAMergeAndReadsTheStoredJobBack() async throws {
    let (service, _, rest) = service()
    rest.answer(
      "PUT", "/api/cron/jobs/job-digest?profile=researcher",
      with: ["id": "job-digest", "name": "Renamed", "schedule_display": "every 15m", "next_run_at": "2026-10-04T14:00:00+02:00"])

    let updated = try await service.update(
      CronJob(id: "job-digest", profile: "researcher"),
      CronJobInput(name: "Renamed", prompt: "p", schedule: "every 15m", deliver: "local"))

    let body = try #require(rest.calls.first?.body)
    #expect(body["updates"] == ["name": "Renamed", "schedule": "every 15m", "prompt": "p", "deliver": "local"])
    #expect(body["updates"]?["profile"] == nil, "an edit cannot move a job between stores")
    #expect(updated.name == "Renamed")
    #expect(updated.nextRunAt == Date(timeIntervalSince1970: 1_791_115_200), "the next run is the server's")
    #expect(updated.profile == "researcher")
  }

  @Test func deletingIsADeleteOfTheJobsRoute() async throws {
    let (service, _, rest) = service()
    rest.answer("DELETE", "/api/cron/jobs/job-digest?profile=researcher", with: ["ok": true])

    try await service.remove(CronJob(id: "job-digest", profile: "researcher"))

    #expect(rest.calls == [.init(method: "DELETE", path: "/api/cron/jobs/job-digest?profile=researcher", body: nil)])
  }

  @Test func aProfileWithOddCharactersIsEncodedInTheQuery() {
    let (service, _, _) = service()

    #expect(service.path(of: CronJob(id: "j", profile: "a&b c")) == "/api/cron/jobs/j?profile=a%26b%20c")
  }

  // MARK: Broadcasts

  @Test func onlyCronChangedBroadcastsAreChanges() async throws {
    let (service, link, _) = service()
    var changes = service.changes().makeAsyncIterator()

    link.emit("sessions.changed", session: nil)
    link.emit("cron.changed", session: nil)
    let first: Void? = await changes.next()

    #expect(first != nil)
  }
}
