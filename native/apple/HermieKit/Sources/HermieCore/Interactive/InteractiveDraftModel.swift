import Foundation
import HermieProtocol
import Observation

/// A draft under review: the text as the agent wrote it, the person's edit of it, and a comment
/// for a rejection. Like the form it is the sheet's own state and goes only into the answer.
@MainActor
@Observable
public final class InteractiveDraftModel {
  public let params: ReviewDraftParams
  /// The text as it stands, edited or not.
  public var text: String
  /// A word for the agent with a rejection (at most `InteractivePrompt.commentLimit` code points).
  public var comment = ""

  public init(params: ReviewDraftParams) {
    self.params = params
    self.text = params.text ?? ""
  }

  /// The draft as it came.
  public var original: String {
    params.text ?? ""
  }

  public var isEditable: Bool {
    params.isEditable
  }

  /// The text differs from the draft, as the gateway compares them (trailing whitespace of a line
  /// does not count).
  public var isEdited: Bool {
    InteractivePrompt.trimmed(text) != InteractivePrompt.trimmed(original)
  }

  /// The rules the text breaks, which would make the gateway refuse it; empty when it takes it.
  public var problems: [DraftText.Problem] {
    DraftText.problems(in: text)
  }

  /// The text can be approved: not empty, within the contract's bound, no rule broken, and changed only when changing is allowed.
  public var canApprove: Bool {
    let scalars = text.unicodeScalars.count
    return scalars > 0 && scalars <= InteractivePrompt.draftLimit && problems.isEmpty && (isEditable || !isEdited)
  }

  /// The text is over the contract's bound.
  public var isTooLong: Bool {
    text.unicodeScalars.count > InteractivePrompt.draftLimit
  }

  /// Put the draft back as it came.
  public func revert() {
    text = original
  }

  public var approval: InteractiveAnswer {
    .approve(text: text)
  }

  public var rejection: InteractiveAnswer {
    .reject(comment: comment.isEmpty ? nil : comment)
  }

  /// The comment is within the contract's bound.
  public var commentIsTooLong: Bool {
    comment.unicodeScalars.count > InteractivePrompt.commentLimit
  }

  /// Empty the review: the text and the comment leave with the sheet.
  public func wipe() {
    text = original
    comment = ""
  }
}
