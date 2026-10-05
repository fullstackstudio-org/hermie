import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

@MainActor
private func viewer(_ backend: StubConversations, visibility: VisibilityOptions? = nil) -> ConversationViewerModel {
  ConversationViewerModel(
    bot: "researcher",
    conversation: ConversationFixture.conversation("p1", "Trip planning"),
    backend: backend,
    visibility: visibility ?? VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true)
  )
}

@MainActor
private func texts(_ model: ConversationViewerModel) -> [String] {
  model.items.compactMap { visible in
    switch visible.item {
    case .user(let user): user.text
    case .assistant(let assistant): assistant.text
    default: nil
    }
  }
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ConversationViewerModelTests {
  @Test func startsLoadingAndThenShowsTheNewestPageOldestFirst() async {
    let backend = StubConversations()
    backend.state.withLock {
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3), shape: .rest, reachedStart: true)
    }
    let model = viewer(backend)

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(texts(model) == ["row 1", "row 2", "row 3"])
    #expect(!model.canLoadOlder)
    #expect(backend.calls == ["transcript p1 0"])
  }

  @Test func aConversationWithNoRowsIsReadyAndEmpty() async {
    let model = viewer(StubConversations())

    await model.load()

    #expect(model.phase == .ready)
    #expect(model.items.isEmpty)
  }

  @Test func aFailedReadSaysWhyAndATryAgainReadsAgain() async {
    let backend = StubConversations()
    backend.state.withLock { $0.transcriptFailure = GatewayRPCError(.rejected, "session not found") }
    let model = viewer(backend)

    await model.load()
    #expect(model.phase == .failed("session not found"))

    backend.state.withLock {
      $0.transcriptFailure = nil
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(2), shape: .rest, reachedStart: true)
    }
    await model.load()

    #expect(model.phase == .ready)
    #expect(texts(model) == ["row 1", "row 2"])
  }

  @Test func anOlderPageIsPlacedInFrontAndStartsAtTheRowsAlreadyRead() async {
    let backend = StubConversations()
    backend.state.withLock {
      // Newest rows 4...6 first; the page before them is rows 1...3.
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3, from: 4), shape: .rest, reachedStart: false)
      $0.pages[3] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3), shape: .rest, reachedStart: true)
    }
    let model = viewer(backend)

    await model.load()
    #expect(model.canLoadOlder)
    #expect(texts(model) == ["row 4", "row 5", "row 6"])

    await model.loadOlder()

    #expect(texts(model) == ["row 1", "row 2", "row 3", "row 4", "row 5", "row 6"])
    #expect(!model.canLoadOlder)
    #expect(backend.calls == ["transcript p1 0", "transcript p1 3"])
  }

  @Test func aPageThatOverlapsTheLastAddsNothingTwiceAndEndsTheHistory() async {
    let backend = StubConversations()
    backend.state.withLock {
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3, from: 4), shape: .rest, reachedStart: false)
      // A turn landed between the two reads, so the "older" page is rows already held.
      $0.pages[3] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3, from: 4), shape: .rest, reachedStart: false)
    }
    let model = viewer(backend)

    await model.load()
    await model.loadOlder()

    #expect(texts(model) == ["row 4", "row 5", "row 6"])
    #expect(!model.canLoadOlder)
  }

  @Test func aFailedOlderPageIsReportedAndMayBeTriedAgain() async {
    let backend = StubConversations()
    backend.state.withLock {
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(2, from: 3), shape: .rest, reachedStart: false)
    }
    let model = viewer(backend)
    await model.load()

    backend.fail("transcript", GatewayRPCError(.timeout, "request timed out"))
    await model.loadOlder()

    #expect(model.olderError == "request timed out")
    #expect(model.phase == .ready)
    #expect(model.canLoadOlder)
    #expect(texts(model) == ["row 3", "row 4"])
  }

  @Test func nothingOlderIsAskedForWhenTheStartWasReached() async {
    let backend = StubConversations()
    backend.state.withLock {
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(2), shape: .rest, reachedStart: true)
    }
    let model = viewer(backend)
    await model.load()

    await model.loadOlder()

    #expect(backend.calls == ["transcript p1 0"])
  }

  @Test func theVisibilityOfTheChatDecidesWhatIsDrawn() async {
    let backend = StubConversations()
    backend.state.withLock {
      $0.pages[0] = ConversationTranscriptPage(
        rows: [
          TranscriptRow(json: ["id": 1, "role": "user", "content": "question"]),
          TranscriptRow(json: ["id": 2, "role": "assistant", "content": "answer"])
        ],
        shape: .rest, reachedStart: true)
    }
    let model = viewer(backend, visibility: VisibilityOptions(level: .quiet, showBotToBot: false, showThinking: false))
    await model.load()
    let quiet = model.revision

    model.visibility = VisibilityOptions(level: .verbose, showBotToBot: true, showThinking: true)

    #expect(model.revision > quiet, "a change of visibility is a change of what is drawn")
    #expect(texts(model) == ["question", "answer"])
  }
}

/// A conversation opened from a search hit, looking for the row the words are in: the same walk the chat
/// runs, over the viewer's own pages.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct ConversationViewerFindTests {
  /// What a walk did, held where the main actor's closures can write it.
  @MainActor
  private final class Log {
    var revealed: [String] = []
    var settled: [ChatFindWalk.Outcome] = []
  }

  private func twoPages() -> StubConversations {
    let backend = StubConversations()
    backend.state.withLock {
      // Newest rows 4...6 first; the page before them is rows 1...3.
      $0.pages[0] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3, from: 4), shape: .rest, reachedStart: false)
      $0.pages[3] = ConversationTranscriptPage(rows: ConversationFixture.restRows(3), shape: .rest, reachedStart: true)
    }
    return backend
  }

  private func walk(_ query: String, over model: ConversationViewerModel, log: Log) -> ChatFindWalk {
    ChatFindWalk(
      query: query,
      hooks: .conversation(
        model,
        reveal: { id in
          log.revealed.append(id)
          return true
        },
        revision: { model.revision }),
      onSettled: { log.settled.append($0) })
  }

  @Test func aRowOnThePageThatIsInIsFoundWithoutReadingMore() async {
    let backend = twoPages()
    let model = viewer(backend)
    await model.load()
    let log = Log()

    let found = walk("row 5", over: model, log: log)
    found.step()

    #expect(log.settled == [.found(itemID: log.revealed.first ?? "")])
    #expect(log.revealed.count == 1)
    #expect(backend.calls == ["transcript p1 0"])
  }

  @Test func theWalkReadsOlderPagesUntilTheWordsAreThere() async {
    let backend = twoPages()
    let model = viewer(backend)
    await model.load()
    let log = Log()
    let found = walk("row 2", over: model, log: log)

    found.step()
    await waitUntil("the walk to settle") { !log.settled.isEmpty }

    #expect(backend.calls == ["transcript p1 0", "transcript p1 3"])
    guard case .found = log.settled.first else {
      Issue.record("not found: \(log.settled)")
      return
    }
  }

  @Test func wordsThatAreNowhereEndAtTheStartOfTheHistoryAsNotFound() async {
    let backend = twoPages()
    let model = viewer(backend)
    await model.load()
    let log = Log()
    let found = walk("nowhere", over: model, log: log)

    found.step()
    await waitUntil("the walk to settle") { !log.settled.isEmpty }

    #expect(log.settled == [.notFound])
    #expect(log.revealed.isEmpty)
    #expect(!model.canLoadOlder)
  }

  @Test func aWalkWaitsForTheFirstPageInsteadOfCallingItAMiss() async {
    let backend = twoPages()
    let model = viewer(backend)
    let log = Log()
    let found = walk("row 2", over: model, log: log)

    // Nothing is loaded yet: not a miss, so no page is read and nothing is settled.
    found.step()
    #expect(log.settled.isEmpty)
    #expect(backend.calls.isEmpty)

    await model.load()
    found.step()
    await waitUntil("the walk to settle") { !log.settled.isEmpty }

    guard case .found = log.settled.first else {
      Issue.record("not found: \(log.settled)")
      return
    }
  }

  @Test func aPageThatCannotBeReadEndsTheWalkAsNotFound() async {
    let backend = twoPages()
    let model = viewer(backend)
    await model.load()
    backend.fail("transcript", GatewayRPCError(.timeout, "request timed out"))
    let log = Log()
    let found = walk("row 2", over: model, log: log)

    found.step()
    await waitUntil("the walk to settle") { !log.settled.isEmpty }

    #expect(log.settled == [.notFound])
  }

  @Test func loadingOlderForAFindSaysWhereTheHistoryCameOut() async {
    let backend = twoPages()
    let model = viewer(backend)

    // Not loaded: nothing to page.
    #expect(await model.loadOlderForFind() == .start)

    await model.load()
    #expect(await model.loadOlderForFind() == .grew)
    #expect(await model.loadOlderForFind() == .start)
  }
}
