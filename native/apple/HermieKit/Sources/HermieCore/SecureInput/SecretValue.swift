import Foundation

/// What a person types into the secure input sheet: a password, an API key, a
/// one-time code.
///
/// It lives only in the sheet's state and, for the moment it takes to send it,
/// in the reply frame. Nothing that describes it shows the text: not
/// `description`, not `debugDescription`, not a mirror (`dump`, the debugger,
/// string interpolation). `revealed` is the one way in and out, for the field
/// that edits it and for the answer that sends it.
public struct SecretValue: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  /// The text itself. Read it only to put it in the field or in the answer.
  public var revealed: String

  public init(_ text: String = "") {
    revealed = text
  }

  public var isEmpty: Bool { revealed.isEmpty }

  /// Forget the text. (A Swift string cannot be wiped in place; this drops the
  /// last reference this value holds.)
  public mutating func clear() {
    revealed = ""
  }

  public var description: String { "SecretValue(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}
