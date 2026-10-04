import Foundation
import HermieGateway
import HermieProtocol
import Synchronization

@testable import HermieCore

/// A gateway's crons as the model sees them: a list the test sets, a log of what was asked, errors a
/// test can arm, and a read it can hold back.
final class StubCrons: CronBackend, Sendable {
  struct State {
    var listing = CronListing()
    var details: [String: CronJob] = [:]
    var runs: [String: [CronRun]] = [:]
    var targets: [CronDeliveryTarget] = [.local]
    var transcript = CronRunTranscript(rows: [], shape: .rpc)
    var calls: [String] = []
    var failing: [String: any Error] = [:]
    /// The method whose next call is held in the air until `release()`, and the call being held.
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
    var changeSinks: [AsyncStream<Void>.Continuation] = []
    /// What an update answers; the job it was given with the input applied where not set.
    var updated: CronJob?
  }

  let state = Mutex(State())

  var calls: [String] { state.withLock { $0.calls } }

  func set(_ jobs: [CronJob], running: Bool? = true) {
    state.withLock { $0.listing = CronListing(jobs: jobs, gatewayRunning: running) }
  }

  func fail(_ method: String, _ error: any Error) {
    state.withLock { $0.failing[method] = error }
  }

  func heal(_ method: String) {
    state.withLock { $0.failing[method] = nil }
  }

  func hold(_ method: String) {
    state.withLock { $0.armed = method }
  }

  var isHolding: Bool { state.withLock { $0.held != nil } }

  func release() {
    let held = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.held = nil }
      return state.held
    }

    held?.resume()
  }

  /// A `cron.changed` broadcast.
  func broadcastChange() {
    for sink in state.withLock({ $0.changeSinks }) {
      sink.yield()
    }
  }

  var watchers: Int { state.withLock { $0.changeSinks.count } }

  func record(_ call: String) async throws {
    let method = call.split(separator: " ").first.map(String.init) ?? call
    let (error, hold) = state.withLock { state -> ((any Error)?, Bool) in
      state.calls.append(call)
      let hold = state.armed == method

      if hold {
        state.armed = nil
      }

      return (state.failing[method], hold)
    }

    if hold {
      await withCheckedContinuation { continuation in
        state.withLock { $0.held = continuation }
      }
    }

    if let error {
      throw error
    }
  }

  func list() async throws -> CronListing {
    // What the gateway says when the read is made, however long the answer takes to arrive.
    let answer = state.withLock { $0.listing }
    try await record("list")

    return answer
  }

  func detail(of job: CronJob) async throws -> CronJob {
    try await record("detail \(job.id)")

    return state.withLock { $0.details[job.id] } ?? job
  }

  func runs(of job: CronJob) async throws -> [CronRun] {
    try await record("runs \(job.id)")

    return state.withLock { $0.runs[job.id] } ?? []
  }

  func deliveryTargets() async -> [CronDeliveryTarget] {
    try? await record("targets")

    return state.withLock { $0.targets }
  }

  func pause(_ job: CronJob) async throws {
    try await record("pause \(job.id)")
  }

  func resume(_ job: CronJob) async throws {
    try await record("resume \(job.id)")
  }

  func runNow(_ job: CronJob) async throws {
    try await record("runNow \(job.id)")
  }

  func create(_ input: CronJobInput) async throws {
    try await record("create \(input.name)")
  }

  func update(_ job: CronJob, _ input: CronJobInput) async throws -> CronJob {
    try await record("update \(job.id) \(input.name)")
    var updated = job
    updated.name = input.name
    updated.prompt = input.prompt
    updated.schedule = input.schedule

    return state.withLock { $0.updated } ?? updated
  }

  func remove(_ job: CronJob) async throws {
    try await record("remove \(job.id)")
  }

  func transcript(of run: CronRun, in job: CronJob) async throws -> CronRunTranscript {
    try await record("transcript \(run.id)")

    return state.withLock { $0.transcript }
  }

  func changes() -> AsyncStream<Void> {
    let (stream, sink) = AsyncStream<Void>.makeStream()
    state.withLock { $0.changeSinks.append(sink) }

    return stream
  }
}

/// The REST side of a link, scripted: what each `METHOD path` answers (or refuses with), and a log.
final class StubREST: GatewayREST, Sendable {
  struct Call: Equatable, Sendable {
    var method: String
    var path: String
    var body: JSONValue?
  }

  private struct State {
    var calls: [Call] = []
    var answers: [String: JSONValue] = [:]
    var failures: [String: any Error] = [:]
  }

  private let state = Mutex(State())

  var calls: [Call] { state.withLock { $0.calls } }

  func answer(_ method: String, _ path: String, with body: JSONValue) {
    state.withLock { $0.answers["\(method) \(path)"] = body }
  }

  func refuse(_ method: String, _ path: String, with error: any Error) {
    state.withLock { $0.failures["\(method) \(path)"] = error }
  }

  func restJSON(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue? {
    let key = "\(method) \(path)"
    let (answer, failure) = state.withLock { state -> (JSONValue?, (any Error)?) in
      state.calls.append(Call(method: method, path: path, body: body))

      return (state.answers[key], state.failures[key])
    }

    if let failure {
      throw failure
    }

    return answer
  }
}
