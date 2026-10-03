import Testing

@testable import HermieUI

/// Each chat screen holds a lease of its own on the bot's model, and gives back only that one.
@Suite struct ChatLeaseBookTests {
  private final class Token: Sendable {
    static let shared = Token()
    static let other = Token()
  }

  private let session = ObjectIdentifier(Token.shared)
  private let other = ObjectIdentifier(Token.other)

  @Test func theModelGoesBackOnlyWithTheLastLease() {
    var book = ChatLeaseBook()
    let old = book.acquire(session: session, bot: "writer")
    let new = book.acquire(session: session, bot: "writer")
    #expect(book.count(session: session, bot: "writer") == 2)

    let oldWasLast = book.release(old)
    #expect(!oldWasLast, "the new screen still holds it")

    let newWasLast = book.release(new)
    #expect(newWasLast, "the last one: the model goes back to the session")
    #expect(book.count(session: session, bot: "writer") == 0)
  }

  @Test func aLeaseGivenBackTwiceCannotTakeTheModelFromTheScreenThatHoldsItNow() {
    // With a count per bot, an old screen's teardown that ran twice counted as two screens leaving,
    // and took the model from the screen that held it.
    var book = ChatLeaseBook()
    let old = book.acquire(session: session, bot: "writer")
    let new = book.acquire(session: session, bot: "writer")

    let first = book.release(old)
    let again = book.release(old)
    #expect(!first)
    #expect(!again, "already given back: nothing changes")
    #expect(book.count(session: session, bot: "writer") == 1)

    let last = book.release(new)
    #expect(last)
  }

  @Test func aLeaseNeverTakenChangesNothing() {
    var book = ChatLeaseBook()
    let held = book.acquire(session: session, bot: "writer")
    let stranger = ChatLease(session: session, bot: "writer", id: held.id + 100)

    let released = book.release(stranger)
    #expect(!released)
    #expect(book.count(session: session, bot: "writer") == 1)
  }

  @Test func leasesAreKeptPerBotAndPerSession() {
    var book = ChatLeaseBook()
    let writer = book.acquire(session: session, bot: "writer")
    let researcher = book.acquire(session: session, bot: "researcher")
    let elsewhere = book.acquire(session: other, bot: "writer")
    #expect(writer != elsewhere)

    let writerWasLast = book.release(writer)
    #expect(writerWasLast)
    #expect(book.count(session: session, bot: "researcher") == 1)
    #expect(book.count(session: other, bot: "writer") == 1)

    let researcherWasLast = book.release(researcher)
    let elsewhereWasLast = book.release(elsewhere)
    #expect(researcherWasLast)
    #expect(elsewhereWasLast)
  }
}
