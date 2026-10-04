import HermieTranscript
import Testing

@testable import HermieCore

func findBase(_ id: String) -> ItemBase {
  ItemBase(id: id, seq: 0, origin: .history, version: 1)
}

func findUser(_ id: String, _ text: String) -> VisibleItem {
  VisibleItem(item: .user(UserItem(base: findBase(id), text: text)), presentation: .full)
}

func findAssistant(_ id: String, _ text: String) -> VisibleItem {
  VisibleItem(
    item: .assistant(AssistantItem(base: findBase(id), text: text, streaming: false, interim: false)),
    presentation: .full)
}

@Suite struct FindInChatTermsTests {
  @Test func aBareTermIsAPrefixAndAQuotedOneAPhrase() {
    #expect(
      FindInChat.terms("  Invoice  \"due date\" ") == [
        .init(needle: "invoice", phrase: false), .init(needle: "due date", phrase: true),
      ])
  }

  @Test func aTrailingStarIsImpliedAndDropped() {
    #expect(FindInChat.terms("invo* *") == [.init(needle: "invo", phrase: false)])
  }

  @Test func anUnterminatedQuoteIsReadTheWayTheReferenceReadsIt() {
    // `"fo` is one `\\S+` token that starts with a quote: a phrase, with its first and last characters cut.
    #expect(FindInChat.terms("\"fo") == [.init(needle: "f", phrase: true)])
    #expect(FindInChat.terms("\"foo bar") == [.init(needle: "fo", phrase: true), .init(needle: "bar", phrase: false)])
    #expect(FindInChat.terms("\"").isEmpty)
    #expect(FindInChat.terms("\"\"").isEmpty)
  }

  @Test func anEmptyQueryHasNoTerms() {
    #expect(FindInChat.terms("   ").isEmpty)
    #expect(FindInChat.terms("***").isEmpty)
  }
}

@Suite struct FindInChatMatchTests {
  private func matches(_ text: String, _ query: String) -> Bool {
    FindInChat.matches(text, terms: FindInChat.terms(query))
  }

  @Test func aBareTermMatchesTheStartOfAWordNotItsMiddle() {
    #expect(matches("Please send the invoices today", "invoice"))
    #expect(matches("Please send the invoices today", "INV"))
    #expect(!matches("Please send the invoices today", "voice"))
  }

  @Test func everyTermMustLandInTheSameRow() {
    #expect(matches("send the invoice to the accountant", "invoice account"))
    #expect(!matches("send the invoice to the accountant", "invoice banana"))
  }

  @Test func aQuotedTermMatchesASubstring() {
    #expect(matches("the due date is Friday", "\"ue dat\""))
    #expect(!matches("the due date is Friday", "\"date due\""))
  }

  @Test func wordsAreRunsOfLettersAndNumbers() {
    #expect(matches("order #4711, shipped", "4711"))
    #expect(matches("een café-tje", "café"))
    #expect(matches("een café-tje", "tje"))
    // An underscore is neither a letter nor a number: it ends a word, as the reference's split does.
    #expect(matches("snake_case_name", "case"))
    #expect(!matches("snakecase", "case"))
  }

  @Test func noTermsMatchNothing() {
    #expect(!matches("anything", "   "))
  }
}

@Suite struct FindInChatItemTests {
  @Test func theNewestMatchingRowIsTheOneFound() {
    let items = [
      findUser("u1", "what about the invoice"),
      findAssistant("a1", "the invoice is paid"),
      findUser("u2", "thanks"),
      findAssistant("a2", "anything else"),
    ]

    #expect(FindInChat.newestMatch(in: items, query: "invoice") == "a1")
    #expect(FindInChat.newestMatch(in: items, query: "thanks") == "u2")
    #expect(FindInChat.newestMatch(in: items, query: "absent") == nil)
    #expect(FindInChat.newestMatch(in: items, query: "  ") == nil)
  }

  @Test func theWordsOfEachKindOfRowAreWhatAReaderWouldCallThem() {
    let dm: TranscriptItem = .botDmOut(
      BotDmOutItem(
        base: findBase("d"), toolID: "t", target: "@writer", targetHandle: "writer", message: "draft the intro",
        dispatch: BotDmDispatch(status: .queued), reply: BotDmReply(text: "here is the outline")))
    let incoming: TranscriptItem = .botDmIn(
      BotDmInItem(base: findBase("i"), senderName: "Writer", senderHandle: "writer", text: "ping from the writer"))
    let status: TranscriptItem = .status(StatusItem(base: findBase("s"), statusKind: "info", text: "compacting"))
    let notice: TranscriptItem = .notice(
      NoticeItem(base: findBase("n"), noticeKind: .notice, title: "Model switched", body: "now on fast"))
    let cron: TranscriptItem = .cronDelivery(
      CronDeliveryItem(base: findBase("c"), jobName: "Daily digest", body: "three new leads", shape: .botChat))
    let tool: TranscriptItem = .tool(
      ToolItem(
        base: findBase("x"), toolID: "x", name: "search", argsText: "secret-arg", status: .complete, resultKnown: true))

    #expect(FindInChat.text(of: dm).contains("writer draft the intro"))
    #expect(FindInChat.text(of: dm).contains("here is the outline"))
    #expect(FindInChat.text(of: incoming) == "ping from the writer")
    #expect(FindInChat.text(of: status) == "compacting")
    #expect(FindInChat.text(of: notice) == "Model switched\nnow on fast")
    #expect(FindInChat.text(of: cron) == "Daily digest\nthree new leads")
    // A tool row's arguments are in the gateway's index and not in what a reader sees: never matched here.
    #expect(FindInChat.text(of: tool) == "")
  }

  @Test func bothSidesOfABotToBotExchangeAreSearchable() {
    let dm = VisibleItem(
      item: .botDmOut(
        BotDmOutItem(
          base: findBase("d"), toolID: "t", target: "writer", targetHandle: "writer", message: "draft the intro",
          dispatch: BotDmDispatch(status: .queued), reply: BotDmReply(text: "here is the outline"))),
      presentation: .collapsed)

    #expect(FindInChat.newestMatch(in: [dm], query: "outline") == "d")
    #expect(FindInChat.newestMatch(in: [dm], query: "intro") == "d")
  }
}
