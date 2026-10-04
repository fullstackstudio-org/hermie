import Foundation
import HermieProtocol
import Observation

/// Text of a draft that the person has to be able to see as it is: the characters that are
/// invisible or that change how text reads (bidirectional controls, zero-width and other format
/// characters, control characters, line separators, spaces that are not the plain one), shown as a
/// visible code instead of vanishing.
public enum DraftText {
  /// A character that does not show as itself, and where it is.
  public struct Hidden: Sendable, Equatable, Identifiable {
    public var scalar: Unicode.Scalar
    /// How many times the text holds it.
    public var count: Int
    public var id: UInt32 { scalar.value }

    /// `U+202E`.
    public var code: String {
      String(format: "U+%04X", scalar.value)
    }
  }

  /// A character the gateway refuses in an approved text (`text:not_verbatim`): a tab or other
  /// control, a format or bidi character, a line or paragraph separator, anything unassigned or
  /// private. A line feed is the one control that is fine.
  public static func isNotVerbatim(_ scalar: Unicode.Scalar) -> Bool {
    if scalar == "\n" {
      return false
    }

    switch scalar.properties.generalCategory {
    case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
      return true
    default:
      return false
    }
  }

  /// A character that is shown as a code in the draft: what the gateway refuses, and the spaces
  /// that look like a plain one.
  public static func isRevealed(_ scalar: Unicode.Scalar) -> Bool {
    if isNotVerbatim(scalar) {
      return scalar != "\n"
    }

    return scalar.properties.generalCategory == .spaceSeparator && scalar != " "
  }

  /// The text with every revealed character replaced by its code in angle brackets,
  /// `a⟨U+202E⟩b`. Line feeds and plain spaces stay.
  public static func reveal(_ text: String) -> String {
    guard text.unicodeScalars.contains(where: isRevealed) else {
      return text
    }

    var out = String.UnicodeScalarView()

    for scalar in text.unicodeScalars {
      if isRevealed(scalar) {
        out.append(contentsOf: String(format: "\u{27E8}U+%04X\u{27E9}", scalar.value).unicodeScalars)
      } else {
        out.append(scalar)
      }
    }

    return String(out)
  }

  /// The revealed characters of a text, once each with its count, in the order they first appear.
  public static func hidden(in text: String) -> [Hidden] {
    var found: [Hidden] = []

    for scalar in text.unicodeScalars where isRevealed(scalar) {
      if let index = found.firstIndex(where: { $0.scalar == scalar }) {
        found[index].count += 1
      } else {
        found.append(Hidden(scalar: scalar, count: 1))
      }
    }

    return found
  }

  /// What the gateway makes of an approved text before it judges it: it is split on LF only, the
  /// whitespace at the end of every line is removed, and then at the end of the whole text (so
  /// trailing blank lines go). `str.isspace()` in Python: the Unicode white space and the four
  /// separators U+001C to U+001F. Counted in code points, as the gateway counts: a CR LF is two
  /// characters here, though Swift reads them as one.
  public static func gatewayTrimmed(_ text: String) -> String {
    func isSpace(_ scalar: Unicode.Scalar) -> Bool {
      scalar.properties.isWhitespace || (0x1C...0x1F).contains(scalar.value)
    }

    func trimmed(_ scalars: [Unicode.Scalar]) -> [Unicode.Scalar] {
      var scalars = scalars

      while let last = scalars.last, isSpace(last) {
        scalars.removeLast()
      }

      return scalars
    }

    var lines: [[Unicode.Scalar]] = [[]]

    for scalar in text.unicodeScalars {
      if scalar == "\n" {
        lines.append([])
      } else {
        lines[lines.count - 1].append(scalar)
      }
    }

    var joined: [Unicode.Scalar] = []

    for (index, line) in lines.enumerated() {
      if index > 0 {
        joined.append("\n")
      }

      joined.append(contentsOf: trimmed(line))
    }

    var view = String.UnicodeScalarView()
    view.append(contentsOf: trimmed(joined))
    return String(view)
  }

  /// The characters of an approved text the gateway would refuse (`text:not_verbatim`), after its
  /// own trimming.
  public static func refused(in text: String) -> [Hidden] {
    var found: [Hidden] = []

    for scalar in gatewayTrimmed(text).unicodeScalars where isNotVerbatim(scalar) {
      if let index = found.firstIndex(where: { $0.scalar == scalar }) {
        found[index].count += 1
      } else {
        found.append(Hidden(scalar: scalar, count: 1))
      }
    }

    return found
  }

  /// The text without the characters the gateway refuses.
  public static func removingRefused(from text: String) -> String {
    var out = String.UnicodeScalarView()

    for scalar in text.unicodeScalars where !isNotVerbatim(scalar) {
      out.append(scalar)
    }

    return String(out)
  }
}

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

  /// The characters of the text that would make the gateway refuse it.
  public var refusedCharacters: [DraftText.Hidden] {
    DraftText.refused(in: text)
  }

  /// The text can be approved: not empty, within the contract's bound, nothing the gateway would
  /// refuse, and changed only when changing is allowed.
  public var canApprove: Bool {
    let scalars = text.unicodeScalars.count
    return scalars > 0 && scalars <= InteractivePrompt.draftLimit && refusedCharacters.isEmpty && (isEditable || !isEdited)
  }

  /// The text is over the contract's bound.
  public var isTooLong: Bool {
    text.unicodeScalars.count > InteractivePrompt.draftLimit
  }

  /// Take the characters the gateway would refuse out of the text.
  public func removeRefusedCharacters() {
    text = DraftText.removingRefused(from: text)
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
