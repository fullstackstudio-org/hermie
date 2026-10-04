import Foundation
import HermieTranscript

/**
 Where a conversation is forked, and what the fork is called (`branchCountFor` and `branchTitle` in
 the web client's `core/sessions/session-model.ts`).

 `session.branch` takes no row id: its `count` is how many of the parent's MESSAGES the child starts
 with, counted from the start. A transcript ITEM is not a gateway message (a reply and its reasoning,
 a DM and the card that announces it are several items of one row, and a live item has no row yet),
 so the count is of distinct `rowID`s up to the item, over the whole ordered transcript rather than
 the visible items: the reader's verbosity settings take items out of what is drawn, and a count over
 that would fork several messages too early.
 */
public enum BranchPoint {
  /// How many words of the branched message survive into the branch's name.
  public static let titleWords = 6
  /// How long the whole generated name may get, before the words are cut.
  public static let titleLimit = 48

  /**
   How many of the parent's messages a branch taken at `itemID` keeps: the distinct row ids at or
   before it. An item with no row id of its own (one that arrived live) counts as a message of its
   own, so the answer is "everything up to here". An id that is not in the list branches the whole
   conversation rather than nothing, the safer of the two wrong answers.
   */
  public static func messageCount(in items: [(id: String, rowID: Int?)], upTo itemID: String) -> Int {
    var seen: Set<Int> = []
    var count = 0

    for item in items {
      if let rowID = item.rowID {
        if seen.insert(rowID).inserted {
          count += 1
        }
      } else {
        count += 1
      }

      if item.id == itemID {
        return count
      }
    }

    return count
  }

  /// The name a branch is born with: `Branch · <first words>` of the message it was taken at, so six
  /// branches off one conversation read as six thoughts. A message with no words is the bare prefix,
  /// which is still a title the Conversations page groups as a branch.
  public static func title(for text: String) -> String {
    let cut = cutToWords(text, maxWords: titleWords, maxChars: titleLimit)

    return cut.isEmpty
      ? ConversationClassifier.branchTitlePrefix : "\(ConversationClassifier.branchTitlePrefix) · \(cut)"
  }

  /// `text` cut to at most `maxWords` words and `maxChars` characters on a word boundary, whitespace
  /// collapsed; a word alone longer than the budget is cut to it rather than dropped.
  static func cutToWords(_ text: String, maxWords: Int, maxChars: Int) -> String {
    let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)

    guard let first = words.first else {
      return ""
    }

    var out = ""

    for word in words.prefix(maxWords) {
      let next = out.isEmpty ? word : "\(out) \(word)"

      if next.utf16.count > maxChars {
        break
      }

      out = next
    }

    return out.isEmpty ? String(first.prefix(maxChars)) : out
  }
}
