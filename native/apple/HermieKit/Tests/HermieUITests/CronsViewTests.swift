import Foundation
import HermieCore
import HermieTranscript
import Testing

@testable import HermieUI

/// The parts of the Crons and Activity screens that are plain functions: their words, their sentences in
/// all three languages, and the router's way into a cron. (The views themselves are not driven by UI
/// tests.)
@MainActor
struct CronsViewTests {
  private let now = Date(timeIntervalSince1970: 1_791_100_000)
  private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!

    return calendar
  }()

  // MARK: Schedules in words

  @Test func aScheduleTheBuilderWritesIsSaidInWords() {
    #expect(CronText.schedule("every 30m") == NativeStrings.Cron.everyMinutes(30))
    #expect(CronText.schedule("every 120m") == NativeStrings.Cron.everyHours(2))
    #expect(CronText.schedule("every 1d") == NativeStrings.Cron.everyDays(1))
    #expect(CronText.schedule("in 2h") == NativeStrings.Cron.onceIn("2h"))

    let time = CronText.clock(hour: 9, minute: 0, calendar: utc, locale: Locale(identifier: "en_US"))
    #expect(CronText.schedule("weekdays at 9am", calendar: utc, locale: Locale(identifier: "en_US")) == NativeStrings.Cron.weekdaysAt(time))
    #expect(CronText.schedule("every day at 9am", calendar: utc, locale: Locale(identifier: "en_US")) == NativeStrings.Cron.dailyAt(time))
    let eight = CronText.clock(hour: 8, minute: 0, calendar: utc, locale: Locale(identifier: "en_US"))
    #expect(CronText.schedule("0 8 * * 0,6", calendar: utc, locale: Locale(identifier: "en_US")) == NativeStrings.Cron.weekendsAt(eight))
  }

  @Test func nothingTheWordsCannotSayIsShownExactlyAsStored() {
    #expect(CronText.schedule("*/15 * * * *") == "*/15 * * * *")
    #expect(CronText.schedule("") == Strings.Cron.Detail.unknown)
  }

  @Test func namedDaysAreListedByName() {
    let text = CronText.schedule("every monday, wednesday at 8am", locale: Locale(identifier: "en_US"))

    #expect(text.contains(Strings.Cron.Schedule.weekdayNames[1]))
    #expect(text.contains(Strings.Cron.Schedule.weekdayNames[3]))
  }

  @Test func aScheduleErrorIsSaidInTheGatewaysTerms() {
    #expect(CronText.error(.interval) == Strings.Cron.Schedule.Errors.interval)
    #expect(CronText.error(.cronFieldCount) == Strings.Cron.Schedule.Errors.cronFieldCount)

    let field = CronText.error(.cronField(.hour, value: "24"))
    #expect(field.contains("24"))
    #expect(field.contains(NativeStrings.Cron.field(.hour)))
  }

  // MARK: Times

  @Test func aTimeIsRelativeToNowAndNeverAbsolute() {
    #expect(CronText.relative(now.addingTimeInterval(10), now: now) == Strings.Cron.Relative.now)
    #expect(CronText.relative(now.addingTimeInterval(600), now: now) == Strings.Cron.Relative.inMinutes(value: 10))
    #expect(CronText.relative(now.addingTimeInterval(-600), now: now) == Strings.Cron.Relative.minutesAgo(value: 10))
    #expect(CronText.relative(now.addingTimeInterval(7_200), now: now) == Strings.Cron.Relative.inHours(value: 2))
    #expect(CronText.relative(now.addingTimeInterval(-7_200), now: now) == Strings.Cron.Relative.hoursAgo(value: 2))
    #expect(CronText.relative(now.addingTimeInterval(3 * 86_400), now: now) == Strings.Cron.Relative.inDays(value: 3))
    #expect(CronText.relative(now.addingTimeInterval(-3 * 86_400), now: now) == Strings.Cron.Relative.daysAgo(value: 3))
  }

  @Test func theWhenColumnPutsTheRightLabelOverTheRightValue() {
    let next = CronText.when(.next(now.addingTimeInterval(600)), now: now)
    #expect(next.label == Strings.Cron.List.nextLabel)
    #expect(next.value == Strings.Cron.Relative.inMinutes(value: 10))

    let last = CronText.when(.last(now.addingTimeInterval(-600)), now: now)
    #expect(last.label == Strings.Cron.List.lastLabel)

    #expect(CronText.when(.overdue) == (Strings.Cron.List.nextLabel, Strings.Cron.List.overdue))
    #expect(CronText.when(.notScheduled) == (Strings.Cron.List.nextLabel, Strings.Cron.List.noNextRun))
    #expect(CronText.when(.neverRun) == (Strings.Cron.List.lastLabel, Strings.Cron.Detail.unknown))
  }

  // MARK: Statuses

  @Test func aRunsOutcomeIsInWordsAndAnUnknownOneIsMadeReadable() {
    #expect(CronText.outcome(CronRun(id: "r", endedAt: 1, status: "cron_complete")) == Strings.Cron.Status.ok)
    #expect(CronText.outcome(CronRun(id: "r", endedAt: 1, status: "cron_incomplete_no_output")) == Strings.Cron.Status.failed)
    #expect(CronText.outcome(CronRun(id: "r", status: nil)) == Strings.Cron.Status.running)
    #expect(CronText.outcome(CronRun(id: "r", endedAt: 1, status: "user_exit")) == "User exit")
    #expect(CronText.humanised("rate_limited") == "Rate limited")
    #expect(CronText.humanised("OK") == Strings.Cron.Status.ok)
    #expect(CronText.humanised("  ") == nil)
  }

  @Test func whereACronDeliversIsTheGatewaysNameForTheTarget() {
    let targets = [CronDeliveryTarget(id: "bot-chat:researcher", name: "Bot Chat (researcher)")]

    #expect(CronText.delivery("bot-chat:researcher", targets: targets) == "Bot Chat (researcher)")
    #expect(CronText.delivery("telegram", targets: targets) == "telegram")
    #expect(CronText.delivery("", targets: targets) == Strings.Cron.Detail.unknown)
  }

  // MARK: Activity

  @Test func anActivityRowReadsAsASentence() {
    let label: (String) -> String = { $0.capitalized }
    let out = ActivityEntry(id: "a", botName: "researcher", itemID: "a", kind: .dmOut, at: 1, fromHandle: "researcher", toHandle: "writer", text: "x")
    let reply = ActivityEntry(id: "b", botName: "writer", itemID: "b", kind: .dmReply, at: 1, fromHandle: "writer", toHandle: "researcher", text: "x")
    let spawn = ActivityEntry(id: "c", botName: "researcher", itemID: "c", kind: .delegation, at: 1, fromHandle: "researcher", text: "x", agentCount: 3)

    #expect(ActivityText.heading(out, label: label) == Strings.App.Activity.to(from: "Researcher", to: "Writer"))
    #expect(ActivityText.heading(reply, label: label) == Strings.App.Activity.reply(from: "Writer", to: "Researcher"))
    #expect(ActivityText.heading(spawn, label: label) == Strings.App.Activity.spawned(bot: "Researcher", count: 3))
  }

  @Test func anActivityStatusIsInWordsWhateverTheEnginesVocabulary() {
    func entry(_ kind: ActivityKind, _ status: String?) -> ActivityEntry {
      ActivityEntry(id: "a", botName: "b", itemID: "a", kind: kind, at: 1, fromHandle: "b", text: "", status: status)
    }

    #expect(ActivityText.status(entry(.dmOut, nil)) == nil)
    #expect(ActivityText.status(entry(.dmOut, "Queued")) == NativeStrings.ActivityStatus.queued)
    #expect(ActivityText.status(entry(.dmOut, "Replied")) == NativeStrings.ActivityStatus.replied)
    #expect(ActivityText.status(entry(.dmOut, "Failed")) == Strings.Cron.Status.failed)
    #expect(ActivityText.status(entry(.delegation, "running")) == Strings.App.Activity.GroupStatus.running)
    #expect(ActivityText.status(entry(.delegation, "mystery_state")) == "Mystery state")
  }

  @Test func aDayIsTodayYesterdayOrItsDate() {
    let today = utc.startOfDay(for: now)
    let yesterday = today.addingTimeInterval(-86_400)
    let older = today.addingTimeInterval(-5 * 86_400)

    #expect(ActivityText.dayTitle(today, now: now, calendar: utc) == Strings.App.Activity.today)
    #expect(ActivityText.dayTitle(yesterday, now: now, calendar: utc) == Strings.App.Activity.yesterday)
    #expect(ActivityText.dayTitle(older, now: now, calendar: utc, locale: Locale(identifier: "en_US")).isEmpty == false)
  }

  @Test func aTapAsksTheChatToFindTheOpeningOfTheMessage() {
    #expect(ActivityRow.findWords("  draft the announcement  ") == "draft the announcement")
    #expect(ActivityRow.findWords(String(repeating: "a", count: 200)).count == ActivityRow.findLimit)
  }

  // MARK: Languages

  /// Every one-line sentence the two screens add is in the Native table in English, Dutch and German.
  @Test(arguments: [
    "native.cron.schedule.onceIn", "native.cron.schedule.onceAt", "native.cron.schedule.dailyAt",
    "native.cron.schedule.weekdaysAt", "native.cron.schedule.weekendsAt", "native.cron.field.minute",
    "native.cron.field.hour", "native.cron.field.dayOfMonth", "native.cron.field.month",
    "native.cron.field.dayOfWeek", "native.activity.status.replied", "native.activity.status.sending",
    "native.activity.status.queued", "native.activity.status.sent", "native.activity.status.ambiguous"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    var texts: [String: String] = [:]

    for language in ["en", "nl", "de"] {
      let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
      let bundle = try #require(Bundle(path: path))
      let text = bundle.localizedString(forKey: key, value: "MISSING", table: "Native")

      #expect(text != "MISSING", "\(key) is missing in \(language)")
      texts[language] = text
    }

    #expect(texts["nl"] != texts["en"], "\(key) was not translated into Dutch")
    #expect(texts["de"] != texts["en"], "\(key) was not translated into German")
  }

  /// The three intervals have a singular and a plural in every language.
  @Test(arguments: ["native.cron.schedule.everyMinutes", "native.cron.schedule.everyHours", "native.cron.schedule.everyDays"])
  func theIntervalsArePlurals(_ key: String) throws {
    for language in ["en", "nl", "de"] {
      let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
      let dictionary = try #require(NSDictionary(contentsOfFile: path + "/Native.stringsdict"))
      let entry = try #require(dictionary[key] as? [String: Any], "\(key) is missing in \(language)")
      let value = try #require(entry["value"] as? [String: Any])

      #expect(value["one"] != nil && value["other"] != nil, "\(key) has no singular and plural in \(language)")
    }
  }

  // MARK: The way into a cron

  @MainActor
  @Test func openingACronSelectsItAndOpensTheCronsSection() {
    let router = AppRouter()
    let cron = CronRef(gatewayId: "g1", id: "job-1", profile: "researcher")

    router.openCron(cron)
    #expect(router.selectedCron == cron)
    #expect(router.section == .routines)

    router.closeCron()
    #expect(router.selectedCron == nil)
  }

  @MainActor
  @Test func aCronBelongsToItsGatewayLikeAChatDoes() {
    let router = AppRouter()
    router.gatewaysChanged(
      GatewayIndex(entries: [.init(id: "g1", key: "a"), .init(id: "g2", key: "b")], activeId: "g1"))
    router.openCron(CronRef(gatewayId: "g1", id: "job-1"))

    router.switchGateway(to: "g2")
    #expect(router.selectedCron == nil)

    router.openCron(CronRef(gatewayId: "g2", id: "job-2"))
    router.gatewaysChanged(GatewayIndex(entries: [.init(id: "g1", key: "a")], activeId: "g1"))
    #expect(router.selectedCron == nil, "a gateway that is gone takes its cron with it")
  }

  @MainActor
  @Test func openingACronLeavesTheOpenChatSelected() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g1", bot: "researcher")
    router.openChat(chat)

    router.openCron(CronRef(gatewayId: "g1", id: "job-1"))

    #expect(router.selectedChat == chat, "the chat comes back with the Chats section")
    router.openChat(chat)
    #expect(router.section == .chats)
  }

  @Test func aCronIsNotPartOfTheSavedNavigation() {
    let snapshot = RouterSnapshot(section: .routines, selectedChat: nil, detailPath: [])

    #expect(RouterSnapshot.decode(snapshot.encoded()) == snapshot)
  }
}
