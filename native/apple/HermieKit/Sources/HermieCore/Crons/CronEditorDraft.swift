import Foundation
import HermieProtocol

/// What `cron.manage add` and `PUT /api/cron/jobs/{id}` take, once the editor has checked it.
public struct CronJobInput: Sendable, Equatable {
  public var name: String
  public var prompt: String
  /// The string `parse_schedule` reads (`CronSchedule.build`).
  public var schedule: String
  public var deliver: String
  public var repeatTimes: Int?
  /// Whose cron store to create the job in; `nil` is the launch profile. Only ever sent on create.
  public var profile: String?

  public init(
    name: String,
    prompt: String,
    schedule: String,
    deliver: String = "local",
    repeatTimes: Int? = nil,
    profile: String? = nil
  ) {
    self.name = name
    self.prompt = prompt
    self.schedule = schedule
    self.deliver = deliver
    self.repeatTimes = repeatTimes
    self.profile = profile
  }
}

/// What can be wrong with the editor's fields, before anything is sent.
public struct CronEditorProblems: Sendable, Equatable {
  public var nameRequired = false
  public var promptRequired = false
  public var schedule: CronScheduleError?

  public var isEmpty: Bool { !nameRequired && !promptRequired && schedule == nil }
}

/// The cron editor's fields, and the checks the gateway will make again (`CronEditorSheet.tsx`).
///
/// A name and the instructions are required, and the schedule has to build into a string the
/// gateway's parser accepts (`CronSchedule.build`). Nothing here predicts when the cron will fire: the
/// editor builds a schedule string, the gateway parses it, and the `next_run_at` that comes back is
/// what the detail shows (the gateway owns the timezone and the DST rules).
public struct CronEditorDraft: Sendable, Equatable {
  public var name: String
  public var prompt: String
  public var deliver: String
  /// `""` is the launch profile, which is what an absent `profile` param means.
  public var profile: String
  public var schedule: CronScheduleDraft
  /// The cron being edited; `nil` creates one.
  public let editing: CronJob?

  /// An empty draft, to create a cron.
  public init() {
    name = ""
    prompt = ""
    deliver = "local"
    profile = ""
    schedule = .default
    editing = nil
  }

  /// A draft of `job`'s fields, to edit it.
  public init(editing job: CronJob) {
    name = job.name
    prompt = job.displayPrompt
    deliver = job.deliver.isEmpty ? "local" : job.deliver
    profile = job.profile ?? ""
    schedule = CronSchedule.draft(from: job.schedule)
    editing = job
  }

  public var isNew: Bool { editing == nil }

  /// What is wrong now; empty when the draft can be saved.
  public var problems: CronEditorProblems {
    var problems = CronEditorProblems()
    problems.nameRequired = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    problems.promptRequired = prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

    if case .failure(let error) = CronSchedule.build(schedule) {
      problems.schedule = error
    }

    return problems
  }

  /// The checked input, or nil while `problems` is not empty.
  public var input: CronJobInput? {
    guard problems.isEmpty, case .success(let built) = CronSchedule.build(schedule) else {
      return nil
    }

    return CronJobInput(
      name: name.trimmingCharacters(in: .whitespacesAndNewlines),
      prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
      schedule: built,
      deliver: deliver.isEmpty ? "local" : deliver,
      // Only ever sent on create: `PUT {updates}` has no way to move a job between stores, and the
      // route would read it as "look for it over here".
      profile: isNew && !profile.isEmpty ? profile : nil
    )
  }
}
