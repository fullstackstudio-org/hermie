import SwiftUI
import Testing

@testable import HermieTranscript
@testable import HermieUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// The sources pill and the list under it: what a row says (the domain always), which monograms the pill
/// stacks, how an address is cut for the question, and that both lay out.
@MainActor
@Suite("Sources: the pill and the list") struct SourcesViewTests {
  private func source(_ url: String, _ title: String, _ via: ReplySourceVia = .found) -> ReplySource {
    ReplySource(url: url, title: title, via: via)
  }

  // MARK: What a row says

  @Test func aMisleadingTitleStillHasItsDomainUnderIt() {
    let row = SourceRowText(source("https://evil.example/login", "accounts.google.com - Sign in"))

    #expect(row.primary == "accounts.google.com - Sign in")
    #expect(row.secondary == "evil.example")
    #expect(row.spoken.contains("evil.example"), "VoiceOver reads the domain too: \(row.spoken)")
  }

  @Test func aPageWithNoTitleIsNamedByItsDomainAlone() {
    let row = SourceRowText(source("https://docs.example.com/a?b=c#d", ""))

    #expect(row.primary == "docs.example.com")
    #expect(row.secondary == nil)
    #expect(row.spoken == "docs.example.com")
  }

  @Test func theDomainIsShownAsTheGatewaySentItIncludingWwwAndPunycode() {
    #expect(SourceRowText(source("https://www.example.org/x", "T")).secondary == "www.example.org")
    #expect(SourceRowText(source("https://xn--bcher-kva.example/", "T")).secondary == "xn--bcher-kva.example")
    #expect(SourceRowText(source("https://[2001:db8::1]:8443/p", "T")).secondary == "[2001:db8::1]")
  }

  // MARK: The pill

  @Test func theStackShowsTheFirstThreeDifferentSites() {
    let stack = StackedMonograms(sources: [
      source("https://www.example.org/1", "a"), source("https://example.org/2", "b"),
      source("https://one.example/", "c"), source("https://two.example/", "d"), source("https://three.example/", "e")
    ])

    #expect(stack.shown.map(\.title) == ["a", "c", "d"], "www.example.org and example.org are one site")
  }

  @Test func aSingleSourceIsASingleMonogram() {
    #expect(StackedMonograms(sources: [source("https://example.org/", "t")]).shown.count == 1)
  }

  // MARK: The question

  @Test func anAddressIsCutOnlyWhenItIsLongAndKeepsItsBeginningAndEnd() {
    #expect(SourcesSheet.shortened("https://example.org/short") == "https://example.org/short")

    let long = "https://example.org/" + String(repeating: "a", count: 400) + "/end"
    let cut = SourcesSheet.shortened(long)

    #expect(cut.count <= 161)
    #expect(cut.hasPrefix("https://example.org/aaa") && cut.hasSuffix("aaa/end") && cut.contains("…"))
  }

  // MARK: Words

  @Test(arguments: [
    "native.sources.pill", "native.sources.pillAccessibility", "native.sources.title", "native.sources.read",
    "native.sources.found", "native.sources.copyLink", "native.sources.openTitle", "native.sources.openMessage",
    "native.sources.open"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test func theTitleOfARowIsPunctuationInEveryLanguage() throws {
    try expectTranslated("native.sources.row", sameIn: ["nl", "de"])
  }

  @Test func theCountAndTheDomainSurviveInEveryLanguage() throws {
    for (language, text) in try nativeTexts("native.sources.pillAccessibility") {
      #expect(text.contains("%lld"), "\(language)")
    }
    for (language, text) in try nativeTexts("native.sources.openTitle") {
      #expect(text.contains("%@"), "\(language)")
    }
    #expect(NativeStrings.Sources.openTitle("example.org").contains("example.org"))
    #expect(NativeStrings.Sources.pillAccessibility(4).contains("4"))
  }

  // MARK: Layout

  private func size(of view: some View, width: CGFloat) -> CGSize {
    let sized = view.frame(width: width)
    let fit = CGSize(width: width, height: .greatestFiniteMagnitude)
    #if os(macOS)
      return NSHostingController(rootView: sized).sizeThatFits(in: fit)
    #else
      return UIHostingController(rootView: sized).sizeThatFits(in: fit)
    #endif
  }

  @Test func theSheetListsBothSectionsAtTheLargestSize() {
    let sources = [
      source("https://example.org/guide/install", "Installing the gateway", .read),
      source("https://docs.example.com/a?b=c#d", "", .found),
      source("https://" + String(repeating: "long-label.", count: 12) + "example/", "A page with a very long domain", .found)
    ]
    let result = size(of: SourcesSheet(sources: sources).environment(\.dynamicTypeSize, .accessibility5), width: 320)

    #expect(result.width <= 320.5)
    #expect(result.height > 100)
  }

  @Test func thePillLaysOutNextToTheIconsOfTheRow() {
    let sources = [source("https://example.org/", "a"), source("https://other.example/", "b")]
    let result = size(of: HStack { SourcesPill(sources: sources) }, width: 320)

    #expect(result.width <= 320.5)
    #expect(result.height >= 30 && result.height < 80)
  }
}
