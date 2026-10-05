import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// The parts of the usage screens that are plain functions: the words of the numbers, what a person may
/// type into the limit fields, the Settings category, and the sentences in the three languages. (The
/// views themselves are not driven by UI tests.)
@MainActor
struct UsageViewTests {
  // MARK: The words of the numbers

  @Test func aCostCarriesATildeWhereItIsTheGatewaysEstimate() {
    #expect(UsageWords.cost(1.5, estimated: true).hasPrefix("~"))
    #expect(!UsageWords.cost(1.5, estimated: false).hasPrefix("~"))
    #expect(UsageWords.cost(DailyUsage(day: "2026-10-05", estimatedCost: 2)).hasPrefix("~"))
    #expect(!UsageWords.cost(DailyUsage(day: "2026-10-05", estimatedCost: 2, actualCost: 3)).hasPrefix("~"))
  }

  @Test func aLineSaysTokensAndCost() {
    var totals = UsageTotals()
    totals.add(DailyUsage(day: "2026-10-05", inputTokens: 1000, outputTokens: 234, estimatedCost: 0.5))

    #expect(UsageWords.line(totals).contains(" · "))
    #expect(UsageWords.line(totals).contains(UsageFormat.tokens(1234)))
  }

  @Test func eachFailureHasItsOwnSentence() {
    let sentences = [
      UsageWords.words(.unsupported), UsageWords.words(.offline), UsageWords.words(.failed("the database is busy"))
    ]

    #expect(Set(sentences).count == 3)
    #expect(sentences.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    #expect(sentences[2].contains("the database is busy"))
    // A refusal with no words is not worth a sentence of its own.
    #expect(UsageWords.words(.failed("")) == UsageWords.words(.unsupported))
  }

  // MARK: The provider accounts

  private let english = Locale(identifier: "en_US")
  private let now = Date(timeIntervalSince1970: 1_791_201_600)

  @Test func aWindowIsSaidAsAShareAndAResetCountdown() {
    let window = AccountWindow(
      id: "current_session", label: "Current session", usedPercent: 18, resetAt: now.addingTimeInterval(2 * 3600 + 600))

    #expect(AccountWords.percent(window, locale: english) == "18%")
    #expect(AccountWords.used(window, locale: english) == NativeStrings.Usage.windowUsed("18%"))
    #expect(AccountWords.resets(window, now: now, locale: english) == NativeStrings.Usage.resetsIn("2h 10m"))
    #expect(NativeStrings.Usage.resetsIn("2h 10m").contains("2h 10m"))
  }

  @Test func aWindowWithNoShareOrNoFutureResetSaysNothingMadeUp() {
    let none = AccountWindow(id: "w", label: "Weekly")
    let past = AccountWindow(id: "w", label: "Weekly", usedPercent: 50, resetAt: now.addingTimeInterval(-5))

    #expect(AccountWords.percent(none) == "–")
    #expect(AccountWords.used(none) == "–")
    #expect(AccountWords.resets(none, now: now) == nil)
    #expect(AccountWords.resets(past, now: now) == nil)
    #expect(none.fraction == nil, "no bar is drawn without a share")
  }

  @Test func creditsAreSaidWithTheirCurrencyAndTheCapWhereThereIsOne() {
    let capped = AccountCredits(currency: "USD", remaining: 4.2, total: 10)
    let open = AccountCredits(currency: "USD", remaining: 4.2)

    #expect(AccountWords.credits(capped, locale: english) == NativeStrings.Usage.creditsLeft(remaining: "$4.20", total: "$10.00"))
    #expect(AccountWords.credits(open, locale: english) == NativeStrings.Usage.remaining("$4.20"))
  }

  @Test func aProviderWithNothingSaysWhyInTheGatewaysWordsOrInOurs() {
    let told = ProviderAccountUsage(
      provider: "openrouter", title: "OpenRouter credits", available: false,
      unavailableReason: "Not signed in to this provider in this profile.")
    let silent = ProviderAccountUsage(provider: "codex", title: "Codex", available: false)

    #expect(AccountWords.reason(told) == "Not signed in to this provider in this profile.")
    #expect(AccountWords.reason(silent) == NativeStrings.Usage.accountUnavailable)
    #expect(!NativeStrings.Usage.accountUnavailable.hasPrefix("native."))
  }

  @Test func whenTheProviderWasReadIsRelativeAndNeverInTheFuture() {
    let read = ProviderAccountUsage(
      provider: "anthropic", title: "Claude", fetchedAt: now.addingTimeInterval(-120))
    let ahead = ProviderAccountUsage(provider: "anthropic", title: "Claude", fetchedAt: now.addingTimeInterval(600))
    let unknown = ProviderAccountUsage(provider: "anthropic", title: "Claude")

    #expect(AccountWords.updated(read, now: now, locale: english)?.contains("2 minutes ago") == true)
    #expect(AccountWords.updated(ahead, now: now, locale: english)?.contains("minutes") == false)
    #expect(AccountWords.updated(unknown, now: now) == nil)
  }

  @Test func theFooterSaysWhereTheNumbersCameFrom() {
    let live = AccountSectionRows.footer(structured: true, forBot: true)
    let gateway = AccountSectionRows.footer(structured: true, forBot: false)
    let lines = AccountSectionRows.footer(structured: false, forBot: true)

    #expect(Set([live, gateway, lines]).count == 3)
    #expect(lines == NativeStrings.Usage.accountNote, "the older gateway's text lines keep their own note")
  }

  // MARK: The limit fields

  @Test func aCostIsReadFromWhatWasTyped() {
    #expect(UsageAlertInput.cost("5") == 5)
    #expect(UsageAlertInput.cost("2.50") == 2.5)
    #expect(UsageAlertInput.cost("2,50") == 2.5)
    #expect(UsageAlertInput.cost(" $12 ") == 12)
  }

  @Test func aCostThatIsNotANumberAboveZeroIsNoLimit() {
    for typed in ["", "   ", "0", "0.00", "-5", "abc", "1.2.3", "5 dollars", "∞", "٣"] {
      #expect(UsageAlertInput.cost(typed) == nil, "\(typed)")
    }
  }

  @Test func aTokenLimitIsReadWithSeparatorsAndSuffixes() {
    #expect(UsageAlertInput.tokens("500000") == 500_000)
    #expect(UsageAlertInput.tokens("1,500,000") == 1_500_000)
    #expect(UsageAlertInput.tokens("500k") == 500_000)
    #expect(UsageAlertInput.tokens(" 2M ") == 2_000_000)
    #expect(UsageAlertInput.tokens("1_000") == 1000)
  }

  @Test func aTokenLimitThatIsNotACountAboveZeroIsNoLimit() {
    for typed in ["", "0", "0k", "-5", "abc", "k", "1.5m x", "99999999999999999999", "9999999999999999m"] {
      #expect(UsageAlertInput.tokens(typed) == nil, "\(typed)")
    }
  }

  @Test func theFieldsShowWhatWasKept() {
    #expect(UsageAlertInput.text(cost: 5) == "5")
    #expect(UsageAlertInput.text(cost: 2.5) == "2.5")
    #expect(UsageAlertInput.text(cost: nil).isEmpty)
    #expect(UsageAlertInput.text(tokens: 250_000) == "250000")
    #expect(UsageAlertInput.text(tokens: nil).isEmpty)
  }

  // MARK: Settings

  @Test func usageIsACategoryOfItsOwnWithItsWords() {
    #expect(SettingsCategory.allCases.contains(.usage))
    #expect(SettingsCategory.groups.flatMap { $0 }.contains(.usage))
    #expect(SettingsCategory.usage.title == NativeStrings.Usage.title)
    #expect(SettingsCategory.usage.blurb == NativeStrings.Usage.blurb)
    #expect(!SettingsCategory.usage.systemImage.isEmpty)
    // Every category is in exactly one group.
    let all = SettingsCategory.groups.flatMap { $0 }
    #expect(Set(all).count == all.count)
    #expect(Set(all) == Set(SettingsCategory.allCases))
  }

  // MARK: Languages

  /// Every sentence of the usage screens is in the Native table in English, Dutch and German, and the three
  /// differ where the languages differ.
  @Test(arguments: [
    "native.usage.title", "native.usage.blurb", "native.usage.span.week", "native.usage.span.month",
    "native.usage.span", "native.usage.today", "native.usage.period", "native.usage.inOut", "native.usage.cached",
    "native.usage.sessions", "native.usage.messages", "native.usage.apiCalls", "native.usage.perDay",
    "native.usage.noUse", "native.usage.loading", "native.usage.unsupported", "native.usage.offline",
    "native.usage.failed", "native.usage.updated", "native.usage.dayNote", "native.usage.context",
    "native.usage.contextDetail", "native.usage.contextNone", "native.usage.account", "native.usage.accountNote",
    "native.usage.accountNone", "native.usage.nous", "native.usage.plan", "native.usage.topup", "native.usage.renews",
    "native.usage.remaining", "native.usage.spendable", "native.usage.allBots", "native.usage.failedBots",
    "native.usage.alertSwitch", "native.usage.alertCostLimit", "native.usage.alertTokenLimit",
    "native.usage.alertOff", "native.usage.alertFooter", "native.usage.alertTitle", "native.usage.alertCost",
    "native.usage.alertCostTop", "native.usage.alertTokens", "native.usage.alertTokensTop",
    "native.usage.accountNoteLive", "native.usage.accountNoteGateway", "native.usage.accountRefresh",
    "native.usage.accountRefreshing", "native.usage.resetsIn", "native.usage.windowUsed",
    "native.usage.accountUnavailable", "native.usage.credits", "native.usage.creditsLeft"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test(arguments: ["native.usage.perBot", "native.usage.tokenCount"])
  func theSameInDutch(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl"])
  }

  @Test func limitIsTheSameWordInGerman() throws {
    try expectTranslated("native.usage.alerts", sameIn: ["de"])
  }

  @Test func theNotificationsAreAsLongAsTheEnglishOnesSayAndKeepTheirPlaceholders() throws {
    for key in ["native.usage.alertCost", "native.usage.alertTokens"] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%1$@") && text.contains("%2$@") && text.contains("%3$@"), "\(key) in \(language)")
      }
    }

    for key in ["native.usage.alertCostTop", "native.usage.alertTokensTop"] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%4$@"), "\(key) in \(language)")
      }
    }
  }

  @Test func theNotificationCopyIsTheReadersLanguageAndNeverAKey() {
    let copy = UsageAlertCopy.localized

    #expect(!copy.title.hasPrefix("native."))
    #expect(copy.cost("$6.00", "$5.00", "Home", nil).contains("$6.00"))
    #expect(copy.cost("$6.00", "$5.00", "Home", "Researcher").contains("Researcher"))
    #expect(copy.tokens("2M", "1M", "Home", nil).contains("2M"))
    #expect(copy.tokens("2M", "1M", "Home", "Researcher").contains("Researcher"))
  }
}
