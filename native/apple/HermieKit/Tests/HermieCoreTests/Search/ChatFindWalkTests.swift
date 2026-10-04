import HermieTranscript
import Testing

@testable import HermieCore

/// A chat the walk can be pointed at: rows it can read, pages it can load, a list that may not have a
/// row yet.
@MainActor
final class FindHarness {
  var items: [VisibleItem]
  var loaded = true
  /// The ids the list has a row for; nil means every id.
  var listed: Set<String>?
  var revision = 0
  var revealed: [String] = []
  var settled: [ChatFindWalk.Outcome] = []
  var loadCalls = 0
  /// What each page does when it is asked for: the rows it adds (oldest first) and the answer.
  var pages: [(rows: [VisibleItem], answer: OlderHistory)] = []
  /// The rebuild that draws a page comes with the load (true) or only after it has returned (false).
  var drawsWithTheLoad = true
  /// A load that waits for `release()`.
  var holdLoads = false
  private var held: CheckedContinuation<Void, Never>?

  init(items: [VisibleItem]) {
    self.items = items
  }

  /// The rows were rebuilt (a snapshot arrived).
  func rebuild(_ rows: [VisibleItem]? = nil) {
    if let rows { items = rows }
    revision += 1
  }

  func release() {
    held?.resume()
    held = nil
  }

  var heldLoad: Bool { held != nil }

  func walk(query: String, pageLimit: Int = 200) -> ChatFindWalk {
    ChatFindWalk(
      query: query,
      hooks: .init(
        items: { [unowned self] in items },
        loaded: { [unowned self] in loaded },
        reveal: { [unowned self] id in
          guard listed?.contains(id) ?? true else { return false }
          revealed.append(id)
          return true
        },
        loadOlder: { [unowned self] in await load() },
        revision: { [unowned self] in revision }
      ),
      pageLimit: pageLimit,
      onSettled: { [unowned self] outcome in settled.append(outcome) }
    )
  }

  private func load() async -> OlderHistory {
    loadCalls += 1

    if holdLoads {
      await withCheckedContinuation { held = $0 }
    }

    guard !pages.isEmpty else {
      return .start
    }

    let page = pages.removeFirst()

    if drawsWithTheLoad {
      items = page.rows + items
      revision += 1
    }

    return page.answer
  }
}

/// Wait on the main actor, without a real-time deadline of its own, until `condition` holds.
@MainActor
func pollMain(_ what: String, _ condition: @MainActor () -> Bool) async throws {
  let deadline = ContinuousClock.now + generousWait

  while !condition() {
    guard ContinuousClock.now < deadline else {
      throw TimedOut(what: what)
    }

    try await Task.sleep(for: .milliseconds(1))
  }
}

@MainActor
@Suite struct ChatFindWalkTests {
  private let old = [findUser("u0", "an older question about invoices"), findAssistant("a0", "sure")]
  private let recent = [findUser("u1", "hello"), findAssistant("a1", "hi there")]

  @Test func aMatchInTheLoadedRowsIsRevealedAtOnce() {
    let chat = FindHarness(items: [findUser("u0", "the invoice"), findAssistant("a0", "another invoice"), findUser("u1", "ok")])
    let walk = chat.walk(query: "invoice")

    walk.step()

    #expect(chat.revealed == ["a0"])
    #expect(chat.settled == [.found(itemID: "a0")])
    #expect(chat.loadCalls == 0)
  }

  @Test func aSettledWalkDoesNothingMore() {
    let chat = FindHarness(items: [findUser("u0", "the invoice")])
    let walk = chat.walk(query: "invoice")

    walk.step()
    walk.step()
    chat.rebuild()
    walk.step()

    #expect(chat.revealed == ["u0"])
    #expect(chat.settled.count == 1)
  }

  @Test func aRowTheListDoesNotHaveYetIsAskedForAgainOnTheNextRebuild() {
    let chat = FindHarness(items: [findUser("u0", "the invoice")])
    chat.listed = []
    let walk = chat.walk(query: "invoice")

    walk.step()
    #expect(chat.settled.isEmpty)
    #expect(chat.revealed.isEmpty)
    #expect(chat.loadCalls == 0)

    chat.listed = ["u0"]
    chat.rebuild()
    walk.step()

    #expect(chat.revealed == ["u0"])
    #expect(chat.settled == [.found(itemID: "u0")])
  }

  @Test func aMissAgainstAChatStillArrivingIsNotAMiss() {
    let chat = FindHarness(items: recent)
    chat.loaded = false
    let walk = chat.walk(query: "invoice")

    walk.step()

    #expect(chat.loadCalls == 0)
    #expect(chat.settled.isEmpty)

    // The match arrives with the rest of the chat.
    chat.loaded = true
    chat.rebuild(old + recent)
    walk.step()

    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.loadCalls == 0)
  }

  @Test func aMatchFurtherBackThanLoadedIsWalkedToPageByPage() async throws {
    let chat = FindHarness(items: recent)
    chat.pages = [(rows: [findUser("p1", "nothing here")], answer: .grew), (rows: old, answer: .grew)]
    let walk = chat.walk(query: "invoices")

    walk.step()

    try await pollMain("the match") { !chat.settled.isEmpty }
    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.revealed == ["u0"])
    #expect(chat.loadCalls == 2)
  }

  @Test func aPageDrawnAfterTheLoadReturnedIsLookedAtByTheRebuildThatDrawsIt() async throws {
    let chat = FindHarness(items: recent)
    chat.drawsWithTheLoad = false
    chat.pages = [(rows: old, answer: .grew)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load") { chat.loadCalls == 1 }
    for _ in 0..<20 { await Task.yield() }

    // Returned, and nothing drawn yet: the walk waits for the rebuild instead of loading another page.
    #expect(chat.settled.isEmpty)
    #expect(chat.loadCalls == 1)

    chat.rebuild(old + recent)
    walk.step()

    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.loadCalls == 1)
  }

  @Test func aStepBeforeTheRebuildThatDrawsThePageDoesNotPageOnPastIt() async throws {
    let chat = FindHarness(items: recent)
    chat.drawsWithTheLoad = false
    // The match is in the first page; a second one exists and must not be asked for.
    chat.pages = [(rows: old, answer: .grew), (rows: [], answer: .start)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load") { chat.loadCalls == 1 }
    for _ in 0..<20 { await Task.yield() }

    // Steps with the rows from before the page (a poll, the rebuild of something else): no new page, no verdict.
    for _ in 0..<5 {
      walk.step()
      await Task.yield()
    }

    #expect(chat.loadCalls == 1)
    #expect(chat.settled.isEmpty)

    chat.rebuild(old + recent)
    walk.step()

    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.revealed == ["u0"])
    #expect(chat.loadCalls == 1)
  }

  @Test func theEndOfTheHistoryLooksAtRowsDrawnWhileTheLoadWasOutBeforeSayingNotFound() async throws {
    let chat = FindHarness(items: recent)
    chat.holdLoads = true
    chat.pages = [(rows: [], answer: .start)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load to start") { chat.heldLoad }

    // The last page is drawn while the load is out; the walk is busy and does not look.
    chat.rebuild(old + recent)
    walk.step()
    #expect(chat.settled.isEmpty)

    chat.release()

    try await pollMain("the walk to end") { !chat.settled.isEmpty }
    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.revealed == ["u0"])
  }

  @Test func aPageDrawnWhileTheWalkWasWaitingIsLookedAtWhenTheLoadReturns() async throws {
    let chat = FindHarness(items: recent)
    chat.holdLoads = true
    chat.pages = [(rows: old, answer: .grew)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load to start") { chat.heldLoad }

    // The rebuild that draws the page comes while the load is out, finds the walk busy, and goes away.
    chat.rebuild(old + recent)
    walk.step()
    #expect(chat.settled.isEmpty)

    chat.drawsWithTheLoad = false
    chat.release()

    try await pollMain("the match, with no step after the load") { !chat.settled.isEmpty }
    #expect(chat.settled == [.found(itemID: "u0")])
    #expect(chat.loadCalls == 1)
  }

  @Test func theWalkStopsWhenTheHistoryRunsOut() async throws {
    let chat = FindHarness(items: recent)
    chat.pages = [(rows: [findUser("p1", "more")], answer: .start)]
    let walk = chat.walk(query: "invoice")

    walk.step()

    try await pollMain("the walk to end") { !chat.settled.isEmpty }
    #expect(chat.settled == [.notFound])
    #expect(chat.loadCalls == 1)
    #expect(chat.revealed.isEmpty)
  }

  @Test func aGatewayThatCannotPageEndsTheWalkToo() async throws {
    let chat = FindHarness(items: recent)
    chat.pages = [(rows: [], answer: .unavailable)]
    let walk = chat.walk(query: "invoice")

    walk.step()

    try await pollMain("the walk to end") { !chat.settled.isEmpty }
    #expect(chat.settled == [.notFound])
  }

  @Test func theWalkIsBoundedAndSaysSoInsteadOfPagingForever() async throws {
    let chat = FindHarness(items: recent)
    chat.pages = (1...50).map { (rows: [findUser("p\($0)", "filler \($0)")], answer: .grew) }
    let walk = chat.walk(query: "invoice", pageLimit: 5)

    // The owner steps after each rebuild, as the feed does.
    for _ in 0..<40 {
      walk.step()
      await Task.yield()
      try await Task.sleep(for: .milliseconds(1))
    }

    #expect(chat.settled == [.notFound])
    #expect(chat.loadCalls == 5)
    #expect(walk.pages == 5)
  }

  @Test func aWalkLoadsOnePageAtATime() async throws {
    let chat = FindHarness(items: recent)
    chat.holdLoads = true
    chat.pages = [(rows: old, answer: .grew)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load to start") { chat.heldLoad }
    walk.step()
    walk.step()

    #expect(chat.loadCalls == 1)

    chat.release()
    try await pollMain("the match") { !chat.settled.isEmpty }
    #expect(chat.loadCalls == 1)
    #expect(chat.settled == [.found(itemID: "u0")])
  }

  @Test func aCancelledWalkReportsNothingAndLoadsNothingMore() async throws {
    let chat = FindHarness(items: recent)
    chat.holdLoads = true
    chat.pages = [(rows: old, answer: .grew)]
    let walk = chat.walk(query: "invoices")

    walk.step()
    try await pollMain("the load to start") { chat.heldLoad }
    walk.cancel()
    chat.release()

    for _ in 0..<20 { await Task.yield() }
    walk.step()

    #expect(chat.settled.isEmpty)
    #expect(chat.revealed.isEmpty)
    #expect(chat.loadCalls == 1)
  }
}
