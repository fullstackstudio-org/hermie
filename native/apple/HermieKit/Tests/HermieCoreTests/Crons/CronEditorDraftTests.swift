import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

private let existing = CronJob(
  id: "job-digest",
  name: "Daily digest",
  schedule: "weekdays at 9am",
  prompt: "Summarize the overnight updates.",
  deliver: "bot-chat:researcher",
  profile: "researcher"
)

@Suite struct CronEditorDraftTests {
  @Test func aNewDraftStartsEmptyAndEveryDayFieldHasADefault() {
    let draft = CronEditorDraft()

    #expect(draft.isNew)
    #expect(draft.name == "" && draft.prompt == "")
    #expect(draft.deliver == "local")
    #expect(draft.profile == "")
    #expect(draft.schedule == .default)
  }

  @Test func anEmptyDraftIsNotReadyAndSaysWhatIsMissing() {
    var draft = CronEditorDraft()
    draft.schedule.mode = .once
    draft.schedule.onceValue = "soon"

    #expect(draft.problems == CronEditorProblems(nameRequired: true, promptRequired: true, schedule: .once))
    #expect(draft.input == nil)
  }

  @Test func aNameAndInstructionsOfOnlyWhitespaceAreMissing() {
    var draft = CronEditorDraft()
    draft.name = "   \n"
    draft.prompt = "\t "

    #expect(draft.problems.nameRequired)
    #expect(draft.problems.promptRequired)
    #expect(draft.problems.schedule == nil, "the default schedule builds")
  }

  @Test func aCompleteDraftBuildsTheInputTheGatewayTakes() {
    var draft = CronEditorDraft()
    draft.name = "  Morning briefing "
    draft.prompt = " Summarize overnight updates.\n"
    draft.deliver = "bot-chat:researcher"
    draft.profile = "writer"
    draft.schedule = CronScheduleDraft(mode: .daily, time: "07:30", weekdays: [1, 2, 3, 4, 5])

    #expect(draft.problems.isEmpty)
    #expect(
      draft.input
        == CronJobInput(
          name: "Morning briefing",
          prompt: "Summarize overnight updates.",
          schedule: "weekdays at 7:30am",
          deliver: "bot-chat:researcher",
          profile: "writer"
        ))
  }

  @Test func theLaunchProfileIsNoProfileAtAll() {
    var draft = CronEditorDraft()
    draft.name = "a"
    draft.prompt = "b"

    #expect(draft.input?.profile == nil)
  }

  @Test func editingOpensOnTheCronsOwnFields() {
    let draft = CronEditorDraft(editing: existing)

    #expect(!draft.isNew)
    #expect(draft.name == "Daily digest")
    #expect(draft.prompt == "Summarize the overnight updates.")
    #expect(draft.deliver == "bot-chat:researcher")
    #expect(draft.profile == "researcher")
    #expect(draft.schedule.mode == .daily)
    #expect(draft.schedule.time == "09:00")
    #expect(draft.schedule.weekdays == [1, 2, 3, 4, 5])
    #expect(draft.problems.isEmpty)
  }

  @Test func editingFallsBackToThePreviewWhereThePromptWasNeverRead() {
    let draft = CronEditorDraft(editing: CronJob(id: "a", name: "n", schedule: "every 5m", promptPreview: "Preview…"))

    #expect(draft.prompt == "Preview…")
  }

  @Test func theProfileIsOnlyEverSentOnCreate() {
    var draft = CronEditorDraft(editing: existing)
    draft.name = "Renamed"

    // `PUT {updates}` has no way to move a job between stores, and the route would read it as "look
    // for it over here".
    #expect(draft.input?.profile == nil)
    #expect(draft.input?.name == "Renamed")
  }

  @Test func aScheduleTheBuilderCannotExpressBlocksTheSaveUntilFixed() {
    var draft = CronEditorDraft(editing: CronJob(id: "a", name: "n", schedule: "0 0 9 * * 1", prompt: "p"))

    #expect(draft.problems.schedule == .cronFieldCount)
    #expect(draft.input == nil)

    draft.schedule.cronExpression = "0 9 * * 1"
    #expect(draft.input?.schedule == "0 9 * * 1")
  }
}

extension CronEditorProblems {
  init(nameRequired: Bool, promptRequired: Bool, schedule: CronScheduleError?) {
    self.init()
    self.nameRequired = nameRequired
    self.promptRequired = promptRequired
    self.schedule = schedule
  }
}
