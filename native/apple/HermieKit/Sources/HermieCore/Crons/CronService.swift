import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// What `GET /api/cron/jobs?profile=all` and `cron.manage list` together say.
public struct CronListing: Sendable, Equatable {
  public var jobs: [CronJob]
  /// Whether the scheduler process is alive (`gateway_running`); `nil` where the gateway did not say.
  public var gatewayRunning: Bool?

  public init(jobs: [CronJob] = [], gatewayRunning: Bool? = nil) {
    self.jobs = jobs
    self.gatewayRunning = gatewayRunning
  }
}

/// The rows of one run, as `session.history` (or the REST transcript) gave them.
public struct CronRunTranscript: Sendable, Equatable {
  public var rows: [TranscriptRow]
  public var shape: RowShape

  public init(rows: [TranscriptRow], shape: RowShape) {
    self.rows = rows
    self.shape = shape
  }
}

/// What the Crons screens ask of the gateway, as one seam: a test hands in a stub, production a
/// `CronService` over a session's link.
public protocol CronBackend: Sendable {
  func list() async throws -> CronListing
  /// The full job, including the prompt the list row only previews.
  func detail(of job: CronJob) async throws -> CronJob
  /// The run sessions of a job, newest first.
  func runs(of job: CronJob) async throws -> [CronRun]
  /// Where a cron can deliver. Never throws and never answers nothing: a gateway that cannot list its
  /// targets still delivers locally.
  func deliveryTargets() async -> [CronDeliveryTarget]
  func pause(_ job: CronJob) async throws
  func resume(_ job: CronJob) async throws
  /// Fire the job now, once; its schedule is unchanged.
  func runNow(_ job: CronJob) async throws
  func create(_ input: CronJobInput) async throws
  func update(_ job: CronJob, _ input: CronJobInput) async throws -> CronJob
  func remove(_ job: CronJob) async throws
  func transcript(of run: CronRun, in job: CronJob) async throws -> CronRunTranscript
  /// One value per `cron.changed` broadcast, from the moment of the call; the stream ends with the
  /// connection. A backend with no socket has none (the default).
  func changes() -> AsyncStream<Void>
}

extension CronBackend {
  public func changes() -> AsyncStream<Void> {
    AsyncStream { $0.finish() }
  }
}

/**
 The gateway calls behind the Crons screens (`cron-controller.ts` in the Expo app).

 The cron surface is split across two transports and the split is not arbitrary:

 - The **list** is HTTP `GET /api/cron/jobs?profile=all`. That is the only call that answers for every
   profile: `cron.manage` is a scoped RPC, so it binds the profile's home to the ONE profile in its
   params and answers from that profile's cron store alone. A socket list without a `profile`
   therefore reports the launch profile's jobs and nothing else, which is why a cron owned by a bot
   used to be invisible. Every row comes back tagged with its `profile`, and the route always lists
   disabled jobs, so the Paused section still fills.
 - One socket `cron.manage {action: "list"}` rides along for **`gateway_running`** alone, the flag that
   says whether the scheduler process is alive, which no HTTP route reports. Its jobs are discarded
   and its failure is swallowed: a list that renders without knowing the scheduler's state beats no
   list.
 - **Pause, resume and creation** are socket `cron.manage`, each carrying the job's `profile` so the
   scope lands on the right store. Unlike the HTTP routes it does not search for the owner, so a
   missing `profile` is not a slow path but a wrong one: the job is simply "not found".
 - **Everything else** is HTTP, because it has no socket equivalent: the full prompt (`GET`), edits
   (`PUT {updates}`), deletion, `trigger`, the run history, and the delivery targets.
 */
public struct CronService: CronBackend {
  /// How many run sessions the detail asks for.
  public static let runHistoryLimit = 20

  let link: any GatewayLink
  let rest: any GatewayREST

  public init(link: any GatewayLink, rest: any GatewayREST) {
    self.link = link
    self.rest = rest
  }

  // MARK: Reading

  public func list() async throws -> CronListing {
    async let running = gatewayRunning()
    let body = try await get(RESTPath.cronJobs + "?profile=all")
    // `hermes serve` answers with a bare array; a `{jobs: …}` envelope is what every other cron route
    // uses and what the socket half sends, so both are read rather than one being declared correct.
    let rows = body?.arrayValue ?? body?["jobs"]?.arrayValue ?? []

    return await CronListing(
      jobs: rows.compactMap { $0.objectValue.map(CronJob.init(row:)) },
      gatewayRunning: running
    )
  }

  /// `gateway_running`, the one thing only `cron.manage` says. `include_disabled` is still forwarded:
  /// the flag rides on the job list, and the gateway attaches it only when the list came back
  /// non-empty, so a gateway whose every job is paused would otherwise never report it.
  private func gatewayRunning() async -> Bool? {
    let reply = try? await link.requestReply(
      RPC.CronManage.name, params: ["action": "list", "include_disabled": true])

    // An absent flag stays unknown rather than becoming "not running".
    return reply?.result["gateway_running"]?.boolValue
  }

  public func detail(of job: CronJob) async throws -> CronJob {
    let body = try await get(path(of: job))

    return Self.job(from: body, profile: job.profile)
  }

  public func runs(of job: CronJob) async throws -> [CronRun] {
    let body = try await get(path(of: job, suffix: "/runs", query: ["limit": String(Self.runHistoryLimit)]))

    return (body?["runs"]?.arrayValue ?? []).compactMap { $0.objectValue.map(CronRun.init(row:)) }
  }

  public func deliveryTargets() async -> [CronDeliveryTarget] {
    guard let body = try? await get(RESTPath.cronDeliveryTargets) else {
      return [.local]
    }

    let targets = (body["targets"]?.arrayValue ?? []).compactMap { $0.objectValue.map(CronDeliveryTarget.init(row:)) }

    return targets.isEmpty ? [.local] : targets
  }

  /// The transcript of one run session. Runs are sessions `cron_{job}_{ts}`: read with
  /// `session.history`, and where the gateway has that no more, with the REST transcript.
  public func transcript(of run: CronRun, in job: CronJob) async throws -> CronRunTranscript {
    var params: JSONObject = ["session_id": .string(run.id)]

    if let profile = job.profile {
      params["profile"] = .string(profile)
    }

    do {
      let reply = try await link.requestReply(RPC.SessionHistory.name, params: .object(params))
      let rows = (reply.result["messages"]?.arrayValue ?? []).map { TranscriptRow(json: $0.objectValue ?? [:]) }

      return CronRunTranscript(rows: rows, shape: .rpc)
    } catch {
      if let rows = await link.fetchMessages(run.id, MessageWindow(limit: ChatRuntimeLimits.restHistoryLimit)) {
        return CronRunTranscript(rows: rows, shape: .rest)
      }

      throw error
    }
  }

  /// The gateway's `cron.changed` broadcasts: the cron list moved, read it again.
  public func changes() -> AsyncStream<Void> {
    let events = link.events

    return AsyncStream { continuation in
      let reading = Task {
        for await wire in events {
          if wire.event.type == GatewayEventType.cronChanged {
            continuation.yield()
          }
        }

        continuation.finish()
      }

      continuation.onTermination = { _ in reading.cancel() }
    }
  }

  // MARK: Writing

  public func pause(_ job: CronJob) async throws {
    try await manage("pause", job)
  }

  public func resume(_ job: CronJob) async throws {
    try await manage("resume", job)
  }

  private func manage(_ action: String, _ job: CronJob) async throws {
    var params: JSONObject = ["action": .string(action), "name": .string(job.id)]

    if let profile = job.profile {
      params["profile"] = .string(profile)
    }

    try Self.check(try await link.requestReply(RPC.CronManage.name, params: .object(params)).result,
      fallback: "The gateway refused to \(action) this cron.")
  }

  /// `POST .../trigger`: fire the job now; the gateway answers the refreshed job.
  public func runNow(_ job: CronJob) async throws {
    _ = try await send("POST", path(of: job, suffix: "/trigger"), body: [:])
  }

  public func create(_ input: CronJobInput) async throws {
    var params: JSONObject = [
      "action": "add",
      "name": .string(input.name),
      "schedule": .string(input.schedule),
      "prompt": .string(input.prompt),
      "deliver": .string(input.deliver)
    ]

    if let times = input.repeatTimes {
      params["repeat"] = .number(Double(times))
    }

    // The scope decides which cron store the job is written to, so this is the whole of "create it for
    // that bot"; there is no owner field.
    if let profile = input.profile, !profile.isEmpty {
      params["profile"] = .string(profile)
    }

    try Self.check(try await link.requestReply(RPC.CronManage.name, params: .object(params)).result,
      fallback: "The gateway refused the cron.")
  }

  /// `PUT {updates}`: a merge, not a replace; untouched fields keep their value.
  public func update(_ job: CronJob, _ input: CronJobInput) async throws -> CronJob {
    var updates: JSONObject = [
      "name": .string(input.name),
      "schedule": .string(input.schedule),
      "prompt": .string(input.prompt),
      "deliver": .string(input.deliver)
    ]

    if let times = input.repeatTimes {
      updates["repeat"] = .number(Double(times))
    }

    let body = try await send("PUT", path(of: job), body: ["updates": .object(updates)])

    return Self.job(from: body, profile: job.profile)
  }

  public func remove(_ job: CronJob) async throws {
    _ = try await send("DELETE", path(of: job), body: nil)
  }

  // MARK: Plumbing

  /// `/api/cron/jobs/<id>` with the job's profile where it has one. Without it these routes fall back
  /// to the gateway walking every profile's store and taking the first id that matches, so omitting it
  /// is not just a wasted search but a coin toss between two profiles that named a job the same thing.
  func path(of job: CronJob, suffix: String = "", query: [String: String] = [:]) -> String {
    var items = query

    if let profile = job.profile {
      items["profile"] = profile
    }

    guard !items.isEmpty else {
      return RESTPath.cronJob(job.id) + suffix
    }

    var components = URLComponents()
    components.queryItems = items.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }

    return RESTPath.cronJob(job.id) + suffix + "?" + (components.percentEncodedQuery ?? "")
  }

  private func get(_ path: String) async throws -> JSONValue? {
    try await send("GET", path, body: nil)
  }

  private func send(_ method: String, _ path: String, body: JSONObject?) async throws -> JSONValue? {
    try await rest.restJSON(method, path, body: body.map(JSONValue.object))
  }

  /// A `cron.manage` answer that says `success: false` is a refusal, in the gateway's words.
  static func check(_ result: JSONValue, fallback: String) throws {
    guard result["success"]?.boolValue == false else {
      return
    }

    let said = result["error"]?.stringValue ?? ""

    throw GatewayRPCError(.rejected, said.isEmpty ? fallback : said)
  }

  /// The job out of a detail or update answer. `hermes serve` answers these with the stored job itself;
  /// a `{job: …}` wrapper shows up on other builds, so both are accepted.
  static func job(from body: JSONValue?, profile: String?) -> CronJob {
    let row = body?["job"]?.objectValue ?? body?.objectValue ?? [:]
    var job = CronJob(row: row)

    if job.profile == nil {
      job.profile = profile
    }

    return job
  }
}
