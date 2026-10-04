import Foundation
import HermieProtocol
import Observation

/// A diff under review: what the person decided about each hunk so far. Like the form and the draft
/// it is the sheet's own state and goes only into the answer.
///
/// Nothing is decided for the person: a hunk starts undecided, "approve all" and "reject all" set
/// every hunk the same way (and can be changed hunk by hunk afterwards), and the answer can be sent
/// only once EVERY hunk is decided (`canSend`; the gateway refuses an answer that leaves one out).
@MainActor
@Observable
public final class InteractiveDiffModel {
  public let diff: ReviewDiff
  /// The decision per hunk id; a hunk without an entry is not decided yet.
  public private(set) var decisions: [String: HunkDecision] = [:]

  public init(diff: ReviewDiff) {
    self.diff = diff
  }

  public func decision(of id: String) -> HunkDecision? {
    decisions[id]
  }

  /// Decide one hunk. An id the diff does not have is ignored.
  public func decide(_ id: String, _ decision: HunkDecision) {
    guard diff.hunks.contains(where: { $0.id == id }) else {
      return
    }

    decisions[id] = decision
  }

  /// Decide every hunk the same way.
  public func decideAll(_ decision: HunkDecision) {
    for hunk in diff.hunks {
      decisions[hunk.id] = decision
    }
  }

  /// How many hunks are decided.
  public var decidedCount: Int { decisions.count }
  public var approvedCount: Int { decisions.values.filter { $0 == .approved }.count }
  public var rejectedCount: Int { decisions.values.filter { $0 == .rejected }.count }
  public var hunkCount: Int { diff.hunks.count }

  /// Every hunk is decided.
  public var isComplete: Bool { decisions.count == diff.hunks.count }

  /// The answer can be sent: every hunk is decided.
  public var canSend: Bool { isComplete }

  /// The answer: a decision for every hunk. Meaningful only while `canSend`; the request refuses it
  /// otherwise (`InteractivePrompt.reply(to:)`).
  public var answer: InteractiveAnswer {
    .diff(decisions)
  }

  /// Empty the review: the decisions leave with the sheet.
  public func wipe() {
    decisions = [:]
  }
}
