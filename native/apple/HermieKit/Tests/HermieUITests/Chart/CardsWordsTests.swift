import Foundation
import HermieMarkdown
import Testing

@testable import HermieUI

/// The words of a `hermie-cards` block and of the callouts: in the catalogue in three languages, and what the
/// labels the app hands the Markdown target say.
@MainActor
@Suite("Cards block and callouts: the words")
struct CardsWordsTests {
  @Test(arguments: [
    "native.block.moreOptions", "native.cards.label", "native.cards.showSource", "native.cards.showCards",
    "native.cards.copySource", "native.cards.copied", "native.cards.card", "native.cards.highlighted",
    "native.cards.tags", "native.cards.then", "native.alert.note", "native.alert.important",
    "native.alert.warning", "native.alert.caution"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  /// "Tip" is the Dutch word too.
  @Test func tipIsTheSameWordInDutch() throws {
    try expectTranslated("native.alert.tip", sameIn: ["nl"])
  }

  @Test func theCardSentenceKeepsAllThreePlaceholdersInEveryLanguage() throws {
    for (language, text) in try nativeTexts("native.cards.card") {
      #expect(text.contains("%1$lld") && text.contains("%2$lld") && text.contains("%3$@"), "\(language): \(text)")
    }
  }

  @Test func theLabelsTheAppHandsTheMarkdownTargetComeFromTheCatalogue() {
    let labels = MarkdownCardsLabels.localized
    let spec = HermieCardsSpec(
      title: "Plan", layout: .stack, connector: .arrow,
      cards: [
        HermieCard(title: "Gateway", subtitle: "k3s", tags: ["k3s", "Postgres"], highlight: true, next: "deploys to"),
        HermieCard(title: "Website")
      ])
    let spoken = HermieCardsSpeech.sentence(spec, index: 0, words: labels.words)

    #expect(!labels.name.isEmpty && !labels.name.hasPrefix("native."))
    #expect(!labels.moreOptions.hasPrefix("native.") && !labels.copySource.hasPrefix("native."))
    #expect(!labels.code.showSource.hasPrefix("native.") && !labels.code.showRendered.hasPrefix("native."))
    #expect(spoken.contains("Gateway") && spoken.contains("k3s, Postgres") && spoken.contains("deploys to"))
    #expect(spoken.contains("1") && spoken.contains("2"), "the position and the total are said")
    #expect(!spoken.contains("native."))
  }

  @Test func everyCalloutHasAnAnnouncedName() {
    let labels = MarkdownAlertLabels.localized
    let names = MarkdownAlertKind.allCases.map(labels.name)

    #expect(names.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    #expect(Set(names).count == 5)
  }
}
