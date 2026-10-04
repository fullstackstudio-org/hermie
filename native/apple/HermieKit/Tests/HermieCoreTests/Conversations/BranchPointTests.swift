import Testing

@testable import HermieCore

/// `BranchPoint`: the message count `session.branch` takes and the name a branch is born with
/// (`branchCountFor` and `branchTitle` in the web client's `session-model.ts`).
@Suite("Branch point") struct BranchPointTests {
  @Test("the count is the distinct row ids up to the item, however many items a row became")
  func countsRows() {
    // A reply and its reasoning share a row: two items, one message.
    let items: [(id: String, rowID: Int?)] = [
      ("u1", 10), ("r1", 11), ("a1", 11), ("u2", 12), ("a2", 13)
    ]
    #expect(BranchPoint.messageCount(in: items, upTo: "u1") == 1)
    #expect(BranchPoint.messageCount(in: items, upTo: "r1") == 2)
    #expect(BranchPoint.messageCount(in: items, upTo: "a1") == 2, "the same row as r1")
    #expect(BranchPoint.messageCount(in: items, upTo: "a2") == 4)
  }

  @Test("it makes no assumption about where row ids start or whether they are contiguous")
  func anyRowIDs() {
    let items: [(id: String, rowID: Int?)] = [("a", 4_000), ("b", 4_007), ("c", 9_999)]
    #expect(BranchPoint.messageCount(in: items, upTo: "c") == 3)
  }

  @Test("a live item with no row id of its own is a message of its own")
  func liveItems() {
    let items: [(id: String, rowID: Int?)] = [("u1", 1), ("a1", 2), ("u2", nil), ("a2", nil)]
    #expect(BranchPoint.messageCount(in: items, upTo: "u2") == 3)
    #expect(BranchPoint.messageCount(in: items, upTo: "a2") == 4)
  }

  @Test("an id that is not in the list branches the whole conversation, not nothing")
  func unknownID() {
    let items: [(id: String, rowID: Int?)] = [("u1", 1), ("a1", 2)]
    #expect(BranchPoint.messageCount(in: items, upTo: "gone") == 2)
    #expect(BranchPoint.messageCount(in: [], upTo: "gone") == 0)
  }

  @Test("the title is Branch, a dot, and the first words of the message")
  func titles() {
    #expect(BranchPoint.title(for: "what is the weather like in Amsterdam today") == "Branch · what is the weather like in")
    #expect(BranchPoint.title(for: "  line one\n\nline   two  ") == "Branch · line one line two")
    #expect(BranchPoint.title(for: "") == "Branch")
    #expect(BranchPoint.title(for: " \n ") == "Branch")
  }

  @Test("the words are cut on a word boundary at 48 characters, and a word longer than that is cut to it")
  func cutting() {
    let long = "alpha bravo charlie delta echo foxtrot golf hotel"
    #expect(BranchPoint.cutToWords(long, maxWords: 8, maxChars: 24) == "alpha bravo charlie")
    #expect(BranchPoint.cutToWords(String(repeating: "x", count: 100), maxWords: 6, maxChars: 48).count == 48)
  }

  @Test("a branch's title is recognised as one by the Conversations page")
  func recognised() {
    #expect(ConversationClassifier.isBranchTitle(BranchPoint.title(for: "anything")))
    #expect(ConversationClassifier.isBranchTitle(BranchPoint.title(for: "")))
  }
}
