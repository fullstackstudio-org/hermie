import Foundation
import HermieGateway
import Observation

/**
 The Crons screens' state: the list, one cron's detail and run history, and what can be done with
 them (`useCron` and `CronController` in the Expo app).

 ## Nothing is patched

 Every mutation makes the gateway broadcast `cron.changed`, and the list is read again after it (here
 at once, and again when the broadcast lands, debounced). A cron's `next_run_at` only the server can
 compute, and most actions change something the gateway owns, so a list that guessed at the outcome
 would be a list that lies about a gateway it can simply ask. The one thing the model does by itself
 is mark a row busy while its action runs, so a tap does not look ignored.

 One action runs at a time on a given cron. A read that a newer one overtook is dropped, and a failed
 refresh keeps the list that was on screen.

 Every text here is the gateway's or a bot's: plain text, never Markdown.
 */
@MainActor
@Observable
public final class CronsModel {
  /// Nothing read yet, a list (possibly empty), or why it could not be read.
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    case failed(String)
  }

  /// One cron's run history.
  public enum Runs: Equatable, Sendable {
    case loading
    case loaded([CronRun])
    case failed(String)
  }

  public private(set) var phase = Phase.loading
  public private(set) var jobs: [CronJob] = []
  /// Whether the scheduler process is alive; `nil` until the gateway says.
  public private(set) var gatewayRunning: Bool?
  /// Where a cron can deliver; `local` alone until the gateway answers.
  public private(set) var targets: [CronDeliveryTarget] = [.local]
  public private(set) var runs: [String: Runs] = [:]
  /// Crons with an action in flight, by id.
  public private(set) var busy: Set<String> = []
  /// What the last action that failed said, in the gateway's words; cleared by the next action or by
  /// `dismissFailure()`.
  public private(set) var failure: String?
  /// The editor's save is running.
  public private(set) var saving = false
  /// Why the editor's last save was refused; cleared when the editor opens again.
  public private(set) var saveError: String?

  @ObservationIgnored private let backend: any CronBackend
  @ObservationIgnored private let debounce: Duration
  /// Only the newest read may write: an answer that arrives after a newer read started is stale.
  @ObservationIgnored private var round = 0
  @ObservationIgnored private var targetsRead = false

  /// `cron.changed` fires about once per scheduler tick; a burst is coalesced for this long.
  public static let changedDebounce: Duration = .milliseconds(750)

  public init(backend: any CronBackend, debounce: Duration = CronsModel.changedDebounce) {
    self.backend = backend
    self.debounce = debounce
  }

  // MARK: Reading

  /// The crons that are going to run, in the order the gateway listed them.
  public var active: [CronJob] { jobs.filter { $0.status != .paused } }
  /// The crons that are switched off.
  public var paused: [CronJob] { jobs.filter { $0.status == .paused } }

  /// The profile is shown only where it tells two rows apart: the HTTP list tags EVERY row with its
  /// store, so on a single-profile gateway each one would read the same word.
  public var showsProfiles: Bool {
    Set(jobs.map(\.profile)).count > 1
  }

  public func job(id: String) -> CronJob? {
    jobs.first { $0.id == id }
  }

  /// Read the list. Safe to call whenever the connection returns or the gateway says the list may have
  /// changed; a read that a newer one overtook is dropped.
  public func load() async {
    round += 1
    let mine = round

    async let targets = readTargets()

    do {
      let listing = try await backend.list()

      if round == mine {
        jobs = listing.jobs
        gatewayRunning = listing.gatewayRunning
        phase = .ready
      }
    } catch {
      if round == mine {
        // A list already on screen stays: a failed refresh is no reason to blank it.
        if phase != .ready {
          phase = .failed(Self.words(of: error))
        } else {
          failure = Self.words(of: error)
        }
      }
    }

    await targets
  }

  /// The delivery targets are read once: they come from the gateway's configuration, not from the
  /// crons.
  private func readTargets() async {
    guard !targetsRead else {
      return
    }

    targetsRead = true
    targets = await backend.deliveryTargets()
  }

  /// The full job, including the prompt a list row only previews. The row in `jobs` becomes the
  /// detail, so every screen reads one value.
  public func loadDetail(of job: CronJob) async {
    guard let detail = try? await backend.detail(of: job), let index = jobs.firstIndex(where: { $0.id == job.id })
    else {
      return
    }

    jobs[index] = detail
  }

  /// A cron's run history, newest first. A history already on screen stays while it is read again.
  public func loadRuns(of job: CronJob) async {
    if runs[job.id] == nil {
      runs[job.id] = .loading
    }

    do {
      runs[job.id] = .loaded(try await backend.runs(of: job))
    } catch {
      if case .loaded? = runs[job.id] {
        failure = Self.words(of: error)
      } else {
        runs[job.id] = .failed(Self.words(of: error))
      }
    }
  }

  /// Follow the gateway's `cron.changed` broadcasts until the calling task is cancelled.
  public func watch() async {
    var pending: Task<Void, Never>?

    defer { pending?.cancel() }

    for await _ in backend.changes() {
      pending?.cancel()
      pending = Task { [debounce] in
        try? await Task.sleep(for: debounce)

        if !Task.isCancelled {
          await self.load()
        }
      }
    }
  }

  // MARK: Doing

  public func dismissFailure() {
    failure = nil
  }

  /// Pause; true when the gateway did.
  @discardableResult
  public func pause(_ job: CronJob) async -> Bool {
    await mutate(job) { try await self.backend.pause(job) }
  }

  @discardableResult
  public func resume(_ job: CronJob) async -> Bool {
    await mutate(job) { try await self.backend.resume(job) }
  }

  /// Run now, once; the schedule is unchanged. The run shows in the history once the gateway has it.
  @discardableResult
  public func runNow(_ job: CronJob) async -> Bool {
    let done = await mutate(job) { try await self.backend.runNow(job) }

    if done {
      await loadRuns(of: job)
    }

    return done
  }

  /// Delete; true when the gateway did. The caller has asked first: there is no undo.
  @discardableResult
  public func remove(_ job: CronJob) async -> Bool {
    let done = await mutate(job) { try await self.backend.remove(job) }

    if done {
      jobs.removeAll { $0.id == job.id }
      runs[job.id] = nil
    }

    return done
  }

  /// Create or update, from the editor. Refused drafts are not sent: the editor shows what is wrong.
  /// True when the gateway took it; otherwise `saveError` says why in the gateway's words.
  @discardableResult
  public func save(_ draft: CronEditorDraft) async -> Bool {
    guard !saving, let input = draft.input else {
      return false
    }

    saving = true
    saveError = nil
    defer { saving = false }

    do {
      if let job = draft.editing {
        let updated = try await backend.update(job, input)

        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
          jobs[index] = updated
        }
      } else {
        try await backend.create(input)
      }
    } catch {
      saveError = Self.words(of: error)

      return false
    }

    await load()

    return true
  }

  /// The editor is opened again: what the last save said is stale.
  public func beginEditing() {
    saveError = nil
  }

  /// Run one action on a cron: marked busy, its failure reported, the list read again after it.
  private func mutate(_ job: CronJob, _ work: () async throws -> Void) async -> Bool {
    guard !busy.contains(job.id) else {
      return false
    }

    busy.insert(job.id)
    failure = nil
    defer { busy.remove(job.id) }

    do {
      try await work()
    } catch {
      failure = Self.words(of: error)

      return false
    }

    await load()

    return true
  }

  static func words(of error: any Error) -> String {
    let said = ChatResolver.describe(error)

    return SecurePrompt.displayText(said, limit: SecurePrompt.textLimit).replacingOccurrences(of: "\n", with: " ")
  }
}
