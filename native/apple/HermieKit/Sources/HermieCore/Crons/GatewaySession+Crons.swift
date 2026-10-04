import Foundation
import HermieTranscript

extension GatewaySession {
  /// The gateway calls behind the Crons screens, over this session's link; nil for a link with no
  /// REST side (a test's scripted one), which has no crons to show.
  public var cronService: CronService? {
    (link as? any GatewayREST).map { CronService(link: link, rest: $0) }
  }

  /// The model behind the Crons list and detail. The caller keeps it: it holds what was read.
  public func crons() -> CronsModel? {
    cronService.map { CronsModel(backend: $0) }
  }

  /// The model behind one cron run's read-only transcript. It starts at the visibility the reader's
  /// chats are at, so a run reads the way a chat does.
  public func cronRun(job: CronJob, run: CronRun) -> CronRunModel? {
    cronService.map {
      CronRunModel(job: job, run: run, backend: $0, visibility: models[job.profile ?? ""]?.visibility ?? defaultVisibility)
    }
  }
}
