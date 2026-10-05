import Foundation
import HermieCore
import HermieProtocol
import Testing
import UniformTypeIdentifiers

@testable import HermieUI

/// The parts of the decision log's screens that are plain functions: the words, the Settings category, the row's
/// lines and the files it exports. (The views themselves are not driven by UI tests.)
@MainActor
struct DecisionLogViewTests {
  private func entry(
    kind: DecisionKind = .approval, outcome: DecisionOutcome = .approved, method: DecisionMethod = .tap,
    bot: String = "researcher", gateway: String = "Home", summary: String? = nil
  ) -> DecisionEntry {
    DecisionEntry(
      at: Date(timeIntervalSince1970: 1_790_000_000), gatewayID: "g1", gateway: gateway, bot: bot, session: "rt-1",
      kind: kind, outcome: outcome, method: method, summary: summary)
  }

  // MARK: Settings

  @Test func theDecisionLogIsACategoryOfItsOwnWithItsWords() {
    #expect(SettingsCategory.allCases.contains(.decisions))
    #expect(SettingsCategory.groups.flatMap { $0 }.contains(.decisions))
    #expect(SettingsCategory.decisions.title == NativeStrings.Decisions.title)
    #expect(SettingsCategory.decisions.blurb == NativeStrings.Decisions.blurb)
    #expect(!SettingsCategory.decisions.systemImage.isEmpty)

    let all = SettingsCategory.groups.flatMap { $0 }

    #expect(Set(all).count == all.count, "in exactly one group")
    #expect(Set(all) == Set(SettingsCategory.allCases))
  }

  // MARK: The words

  @Test func everyKindOutcomeAndMethodHasItsOwnWords() {
    let kinds = DecisionKind.allCases.map(NativeStrings.Decisions.kind)
    let outcomes = DecisionOutcome.allCases.map(NativeStrings.Decisions.outcome)
    let methods = DecisionMethod.allCases.map(NativeStrings.Decisions.method)

    for words in [kinds, outcomes, methods] {
      #expect(Set(words).count == words.count, "no two read alike")
      #expect(words.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    }
  }

  @Test func everyRequestTheLogNamesHasASubject() {
    let methods = Array(ServerRequestBody.Method.secureInput) + ServerRequestBody.Method.interactive

    for method in methods {
      #expect(NativeStrings.Decisions.subject(request: method) != nil, "\(method)")
    }

    #expect(NativeStrings.Decisions.subject(request: "terminal.read") == nil)
    #expect(Set(methods.compactMap(NativeStrings.Decisions.subject(request:))).count == methods.count)
  }

  @Test func aSummaryIsTheSubjectForARequestAndTheTextForTheRest() {
    #expect(
      NativeStrings.Decisions.summary(of: entry(kind: .device, summary: "device.location"))
        == NativeStrings.Decisions.subject(request: "device.location"))
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .secure, summary: "sudo")) == NativeStrings.Decisions.subject(request: "sudo"))
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .approval, summary: "npm test")) == "npm test")
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .connector, summary: "calendar")) == "calendar")
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .device, summary: "from.the.future")) == "from.the.future")
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .approval, summary: nil)) == nil)
    #expect(NativeStrings.Decisions.summary(of: entry(kind: .approval, summary: "")) == nil)
  }

  // MARK: The row

  @Test func aRowNamesTheBotTheGatewayAndHowItWasDecided() {
    let tap = DecisionRow.detail(entry(), showsBot: true)

    #expect(tap == "researcher · Home · \(NativeStrings.Decisions.method(.tap))")
    #expect(DecisionRow.detail(entry(method: .passkey), showsBot: true).hasSuffix(NativeStrings.Decisions.method(.passkey)))
  }

  @Test func aBotsOwnPageLeavesTheBotOut() {
    #expect(DecisionRow.detail(entry(), showsBot: false) == "Home · \(NativeStrings.Decisions.method(.tap))")
    #expect(DecisionRow.detail(entry(bot: "", gateway: ""), showsBot: true) == NativeStrings.Decisions.method(.tap))
  }

  @Test func refusalsAndSkipsAreToldApartFromWhatWasAllowed() {
    for outcome in DecisionOutcome.allCases {
      let symbol = DecisionRow.symbol(outcome)

      switch outcome {
      case .denied, .declined: #expect(symbol == "xmark.circle.fill", "\(outcome)")
      case .skipped: #expect(symbol == "minus.circle.fill", "\(outcome)")
      default: #expect(symbol == "checkmark.circle.fill", "\(outcome)")
      }
    }
  }

  // MARK: Export

  @Test func eachFormatIsAFileOfItsOwnKind() {
    #expect(DecisionExportFormat.csv.contentType == .commaSeparatedText)
    #expect(DecisionExportFormat.json.contentType == .json)

    let entries = [entry(summary: "ls")]

    #expect(DecisionExportFile(entries: entries, format: .csv).fileName.hasSuffix(".csv"))
    #expect(DecisionExportFile(entries: entries, format: .json).fileName.hasSuffix(".json"))
    #expect(DecisionExportFile(entries: entries, format: .csv).fileName.hasPrefix("hermie-decisions-"))
  }

  @Test func theSaveDocumentWritesTheExportOfItsFormat() throws {
    let entries = [entry(summary: "ls")]

    for format in DecisionExportFormat.allCases {
      let document = DecisionExportDocument(entries: entries, format: format)

      #expect(document.format == format)
      #expect(document.entries == entries)
    }
  }

  // MARK: Languages

  /// Every sentence of the decision log is in the Native table in English, Dutch and German, and the three
  /// differ where the languages differ.
  @Test(arguments: [
    "native.decisions.title", "native.decisions.blurb", "native.decisions.empty", "native.decisions.noMatch",
    "native.decisions.searchPrompt", "native.decisions.allBots", "native.decisions.allKinds",
    "native.decisions.filterKind", "native.decisions.note", "native.decisions.export", "native.decisions.exportCSV",
    "native.decisions.exportJSON", "native.decisions.clear", "native.decisions.clearTitle",
    "native.decisions.clearMessage", "native.decisions.clearConfirm", "native.decisions.kind.approval",
    "native.decisions.kind.clarify", "native.decisions.kind.confirm", "native.decisions.kind.secure",
    "native.decisions.kind.device", "native.decisions.kind.input", "native.decisions.kind.review",
    "native.decisions.outcome.approved", "native.decisions.outcome.approvedSession",
    "native.decisions.outcome.approvedAlways", "native.decisions.outcome.denied", "native.decisions.outcome.answered",
    "native.decisions.outcome.confirmed", "native.decisions.outcome.declined", "native.decisions.outcome.entered",
    "native.decisions.outcome.shared", "native.decisions.outcome.authorised", "native.decisions.outcome.skipped",
    "native.decisions.method.tap", "native.decisions.method.notification", "native.decisions.method.keyboard",
    "native.decisions.subject.secret", "native.decisions.subject.sudo", "native.decisions.subject.vaultUnlock",
    "native.decisions.subject.vaultCode", "native.decisions.subject.vaultSaveLogin",
    "native.decisions.subject.location", "native.decisions.subject.calendar", "native.decisions.subject.scan",
    "native.decisions.subject.form", "native.decisions.subject.file", "native.decisions.subject.signature",
    "native.decisions.subject.draft", "native.decisions.subject.diff"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test(arguments: [
    "native.decisions.filterBot", "native.decisions.kind.connector", "native.decisions.method.passkey",
    "native.decisions.subject.contact"
  ])
  func theSameWordInTheOtherLanguages(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl", "de"])
  }

  @Test func theNoteSaysWhatIsNeverKept() throws {
    for (language, text) in try nativeTexts("native.decisions.note") {
      #expect(text.contains("90"), "the age limit in \(language)")
      #expect(text.contains("5.000") || text.contains("5,000"), "the count limit in \(language)")
    }
  }
}
