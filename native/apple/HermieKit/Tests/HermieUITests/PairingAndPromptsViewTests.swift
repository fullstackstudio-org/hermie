import Foundation
import HermieCore
import HermieGateway
import Testing

@testable import HermieUI

/// The parts of the QR pairing and reusable prompts screens that are plain functions: the Settings
/// category, the words, and the sentences in the three languages. (The views themselves are not driven
/// by UI tests.)
@MainActor
struct PairingAndPromptsViewTests {
  // MARK: Settings

  @Test func promptsAreACategoryOfTheirOwnWithTheirWords() {
    #expect(SettingsCategory.allCases.contains(.prompts))
    #expect(SettingsCategory.groups.flatMap { $0 }.contains(.prompts))
    #expect(SettingsCategory.prompts.title == NativeStrings.Prompts.title)
    #expect(SettingsCategory.prompts.blurb == NativeStrings.Prompts.blurb)
    #expect(!SettingsCategory.prompts.systemImage.isEmpty)

    let all = SettingsCategory.groups.flatMap { $0 }
    #expect(Set(all).count == all.count, "in exactly one group")
    #expect(Set(all) == Set(SettingsCategory.allCases))
  }

  // MARK: Words

  @Test func aCountIsTheNumberOrNone() {
    #expect(PromptWords.count(0) == NativeStrings.BotSettings.summaryNone)
    #expect(PromptWords.count(3) == "3")
  }

  @Test func theFieldsOfAPromptAreShownInBraces() {
    #expect(PromptWords.fieldList(["topic", "tone"]) == "{topic} {tone}")
    #expect(PromptWords.fieldList([]).isEmpty)
    #expect(PromptWords.preview("  First line  \nsecond") == "First line")
    #expect(PromptWords.preview(String(repeating: "x", count: 300)).count == 80)
  }

  @Test func eachProblemWithACodeHasASentenceOfItsOwn() {
    let sentences = [
      NativeStrings.Pairing.problem(.notAnOffer), NativeStrings.Pairing.problem(.notAnAddress),
      NativeStrings.Pairing.problem(.notSecure(host: "gw.example.test"))
    ]

    #expect(Set(sentences).count == 3)
    #expect(sentences.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    #expect(sentences[2].contains("gw.example.test"), "the host that was refused is named")
  }

  @Test func theSignInKindsAreNamedAndDiffer() {
    let names = GatewayAuthMode.allCases.map(NativeStrings.Pairing.auth)

    #expect(Set(names).count == names.count)
    #expect(names.allSatisfy { !$0.hasPrefix("native.") })
  }

  // MARK: Languages

  @Test(arguments: [
    "native.pairing.scan", "native.pairing.scanFooter", "native.pairing.sheet.title", "native.pairing.sheet.intro",
    "native.pairing.sheet.aim", "native.pairing.sheet.chooseImage", "native.pairing.sheet.again",
    "native.pairing.sheet.denied", "native.pairing.sheet.restricted", "native.pairing.sheet.noCamera",
    "native.pairing.sheet.found", "native.pairing.offer.title", "native.pairing.offer.address",
    "native.pairing.offer.signIn", "native.pairing.offer.secure", "native.pairing.offer.local",
    "native.pairing.offer.note", "native.pairing.offer.unverified", "native.pairing.offer.add",
    "native.pairing.offer.have", "native.pairing.auth.sessionToken", "native.pairing.auth.cookie",
    "native.pairing.problem.notAnOffer", "native.pairing.problem.notAnAddress", "native.pairing.problem.notSecure",
    "native.pairing.share.action", "native.pairing.share.blurb", "native.pairing.share.label",
    "native.pairing.share.unavailable", "native.pairing.share.failed", "native.prompts.saveFailed", "native.prompts.blurb",
    "native.prompts.global", "native.prompts.forBot", "native.prompts.add", "native.prompts.new",
    "native.prompts.edit", "native.prompts.fieldTitle", "native.prompts.titlePlaceholder", "native.prompts.help",
    "native.prompts.fields", "native.prompts.save", "native.prompts.delete", "native.prompts.deleteConfirm",
    "native.prompts.moveUp", "native.prompts.moveDown", "native.prompts.none", "native.prompts.syncNote",
    "native.prompts.notReady", "native.prompts.limit", "native.prompts.alsoGlobal", "native.prompts.fill.title",
    "native.prompts.fill.insert", "native.prompts.fill.preview", "native.prompts.composer.button",
    "native.prompts.composer.hint", "native.prompts.composer.insertHint", "native.prompts.composer.empty"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test(arguments: [
    "native.pairing.sheet.start", "native.pairing.sheet.camera", "native.pairing.auth.nativePKCE", "native.pairing.offer.host",
    "native.prompts.title", "native.prompts.perBot", "native.prompts.fieldText", "native.prompts.composer.section"
  ])
  func theSameWordInDutch(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl", "de"])
  }

  @Test func nameIsTheSameWordInGerman() throws {
    try expectTranslated("native.pairing.offer.name", sameIn: ["de"])
  }

  @Test func theSentencesWithAValueKeepItInEveryLanguage() throws {
    for key in [
      "native.pairing.problem.notSecure", "native.pairing.share.label", "native.pairing.share.unavailable",
      "native.prompts.forBot", "native.prompts.fields"
    ] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%@"), "\(key) in \(language)")
      }
    }

    for key in ["native.prompts.limit", "native.prompts.alsoGlobal"] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%lld"), "\(key) in \(language)")
      }
    }
  }

  @Test func theHelpLineShowsHowAFieldIsWrittenInEveryLanguage() throws {
    for (language, text) in try nativeTexts("native.prompts.help") {
      #expect(text.contains("{{") && text.contains("}}"), "\(language)")
    }
  }
}
