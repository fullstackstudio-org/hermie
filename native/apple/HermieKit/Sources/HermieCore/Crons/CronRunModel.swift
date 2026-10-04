import Foundation
import Observation

import HermieTranscript

/**
 One run of a cron, read and not answered (`CronRunScreen.tsx`).

 A run is an ordinary session (`cron_{job}_{timestamp}`), read with `session.history` and drawn through
 exactly the same projection as a chat (`rowsToItems`, `visibleItems`), which is why a tool call in a
 cron run looks like a tool call in a conversation. It is a snapshot: a cron session has no live agent
 behind it, so nothing here is live, nothing is written to the chat cache, and there is nothing to
 send a prompt to.
 */
@MainActor
@Observable
public final class CronRunModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    case failed(String)
  }

  public let job: CronJob
  public let run: CronRun

  public private(set) var phase = Phase.loading
  /// What the transcript draws, under `visibility`.
  public private(set) var items: [VisibleItem] = []
  /// Moves whenever `items` changed, for a view that rebuilds rows on it.
  public private(set) var revision = 0

  public var visibility: VisibilityOptions {
    didSet {
      if visibility != oldValue {
        publish()
      }
    }
  }

  @ObservationIgnored private let backend: any CronBackend
  @ObservationIgnored private var state: ChatState
  @ObservationIgnored private var loading = false

  public init(job: CronJob, run: CronRun, backend: any CronBackend, visibility: VisibilityOptions) {
    self.job = job
    self.run = run
    self.backend = backend
    self.visibility = visibility
    self.state = createChatState(job.profile ?? "", run.id, run.id)
  }

  /// Read the run. Called once when the screen opens, and again by its "Try again".
  public func load() async {
    guard !loading else {
      return
    }

    loading = true
    defer { loading = false }

    phase = .loading
    state = createChatState(job.profile ?? "", run.id, run.id)

    do {
      let page = try await backend.transcript(of: run, in: job)

      state = reconcile(state, rowsToItems(page.rows, page.shape))
      phase = .ready
      publish()
    } catch {
      phase = .failed(CronsModel.words(of: error))
    }
  }

  private func publish() {
    items = visibleItems(state, visibility)
    revision += 1
  }
}
