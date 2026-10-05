import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// The parts of the search over every conversation that are plain functions: what it says about itself,
/// the words of a result, the date of one, and its sentences in the three languages. (The views are not
/// driven by UI tests.)
@MainActor
struct SearchEverywhereViewTests {
  // MARK: What it says

  @Test func anEmptyFieldHasNothingToSay() {
    #expect(SearchStatus.of(query: "", answered: false, searching: false, count: 0, failed: false) == .idle)
  }

  @Test func untilTheWordsAreAnsweredTheSearchIsStillOut() {
    #expect(SearchStatus.of(query: "x", answered: false, searching: false, count: 3, failed: false) == .searching)
    // This device answered; the gateways have not.
    #expect(SearchStatus.of(query: "x", answered: true, searching: true, count: 3, failed: false) == .searching)
  }

  @Test func theSearchSaysWhatItFoundOrThatItCouldNotLook() {
    #expect(SearchStatus.of(query: "x", answered: true, searching: false, count: 2, failed: false) == .results)
    #expect(SearchStatus.of(query: "x", answered: true, searching: false, count: 0, failed: false) == .none)
    #expect(SearchStatus.of(query: "x", answered: true, searching: false, count: 0, failed: true) == .failed)
    // A search that could not ask any gateway still lists what this device found.
    #expect(SearchStatus.of(query: "x", answered: true, searching: false, count: 1, failed: true) == .results)
  }

  @Test func eachStatusHasItsOwnSentence() {
    let sentences = [
      SearchStatus.searching.text(query: "q"), SearchStatus.none.text(query: "q"), SearchStatus.failed.text(query: "q")
    ]

    #expect(Set(sentences).count == 3)
    #expect(sentences.allSatisfy { !$0.isEmpty && !$0.hasPrefix("native.") })
    #expect(SearchStatus.none.text(query: "invoice").contains("invoice"))
    #expect(SearchStatus.idle.text(query: "q").isEmpty)
  }

  // MARK: The words of a result

  private func result(_ kind: SearchResultKind, title: String = "", label: String = "") -> SearchResult {
    SearchResult(gatewayID: "g1", bot: "researcher", sessionID: "s", title: title, ownLabel: label, kind: kind, snippet: "")
  }

  @Test func theBotChatIsCalledByName() {
    #expect(SearchResultText.chatTitle(result(.botChat, title: "anything")) == NativeStrings.Search.botChat)
  }

  @Test func anOwnChatIsCalledWhatTheReaderNamedItElseMyChat() {
    #expect(SearchResultText.chatTitle(result(.ownChat, title: "Chat · Ada · Ideas", label: "Ideas")) == "Ideas")
    #expect(SearchResultText.chatTitle(result(.ownChat, title: "Chat · Ada")) == NativeStrings.Search.ownChat)
  }

  @Test func aBranchAndAPastConversationAreCalledByTheirTitleElseByWhatTheyAre() {
    #expect(SearchResultText.chatTitle(result(.branch, title: "Branch · Why")) == "Branch · Why")
    #expect(SearchResultText.chatTitle(result(.branch)) == NativeStrings.Search.branch)
    #expect(SearchResultText.chatTitle(result(.past, title: "Taxes 2025")) == "Taxes 2025")
    #expect(SearchResultText.chatTitle(result(.past)) == NativeStrings.Search.past)
  }

  @Test func aTitleIsOneCleanLine() {
    let title = SearchResultText.chatTitle(result(.past, title: "Two\nlines\u{202E}reversed"))

    #expect(!title.contains("\n"))
    #expect(!title.contains("\u{202E}"))
  }

  // MARK: The date

  @Test func aDateSaysWhichDayItIsInAndTheYearOnlyWhenItIsAnother() {
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let today = SearchResultRow.time(now.timeIntervalSince1970 - 60, now: now, calendar: calendar)
    let earlier = SearchResultRow.time(now.timeIntervalSince1970 - 40 * 86_400, now: now, calendar: calendar)
    let old = SearchResultRow.time(now.timeIntervalSince1970 - 800 * 86_400, now: now, calendar: calendar)

    #expect(!today.isEmpty && !earlier.isEmpty && !old.isEmpty)
    #expect(old.count > earlier.count)
    #expect(SearchResultRow.time(nil).isEmpty)
    #expect(SearchResultRow.time(0).isEmpty)
    #expect(SearchResultRow.time(.nan).isEmpty)
  }

  // MARK: Languages

  /// Every sentence of the search is in the Native table in English, Dutch and German, and the three
  /// differ where the languages differ.
  @Test(arguments: [
    "native.search.title", "native.search.prompt", "native.search.hint", "native.search.none",
    "native.search.searching", "native.search.unreachable", "native.search.onDevice", "native.search.ownChat",
    "native.search.branch", "native.search.past", "native.search.openAt", "native.search.everywhere",
    "native.search.resultsHeader", "native.commands.searchEverywhere"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test func theBotChatIsTheSameWordInDutch() throws {
    // "Bot Chat" is the name the app gives the one chat; Dutch keeps it.
    try expectTranslated("native.search.botChat", sameIn: ["nl"])
  }
}
