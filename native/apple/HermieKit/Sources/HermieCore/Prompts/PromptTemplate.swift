import Foundation

/**
 The fill-in fields of a reusable prompt (NX-13): `{{name}}` in the text of a snippet, replaced by
 what the person types into a small form when the snippet is used.

 The grammar is deliberately small, so a snippet reads the same on every device and a name can be
 shown as a form label:

 - A field is `{{` name `}}` with optional spaces inside the braces. The name is one to
   `maxNameLength` characters: letters, digits, spaces, `_`, `-` and `.`, not starting or ending
   with a space. Anything else between the braces (`{{}}`, `{{ a{b }}`, a name that is too long) is
   ordinary text and is left exactly as written.
 - The same name twice is one field, asked once, filled in both places. Names are case-sensitive.
 - A backslash straight before `{{` makes it literal text: `\{{name}}` is sent as `{{name}}`.
 - A field left empty fills in as nothing. Filling never fails and never runs anything: the values
   are put in as text, and a value that itself holds `{{…}}` is NOT read again.

 Pure functions on strings, so the rules are the same in the form, the composer and the tests.
 */
public enum PromptTemplate {
  /// The longest field name.
  public static let maxNameLength = 40

  /// A piece of a snippet: text to keep, or a field to fill.
  enum Piece: Equatable {
    case text(String)
    case field(String)
  }

  /// The field names in the order they first appear, each once.
  public static func fields(in text: String) -> [String] {
    var seen = Set<String>()
    var names: [String] = []

    for case .field(let name) in pieces(of: text) where seen.insert(name).inserted {
      names.append(name)
    }

    return names
  }

  /// The snippet with each field replaced by its value (an absent value is empty).
  public static func fill(_ text: String, with values: [String: String]) -> String {
    pieces(of: text).map { piece in
      switch piece {
      case .text(let text): text
      case .field(let name): values[name] ?? ""
      }
    }.joined()
  }

  /// Whether a name between braces is a field name.
  public static func isFieldName(_ name: String) -> Bool {
    guard !name.isEmpty, name.count <= maxNameLength, name.first != " ", name.last != " " else {
      return false
    }

    return name.unicodeScalars.allSatisfy { scalar in
      scalar.properties.isAlphabetic || scalar.properties.numericType != nil || scalar == "_" || scalar == "-"
        || scalar == "." || scalar == " "
    }
  }

  // MARK: Reading

  static func pieces(of text: String) -> [Piece] {
    let scalars = Array(text.unicodeScalars)
    var pieces: [Piece] = []
    var buffer = String.UnicodeScalarView()
    var index = 0

    func flush() {
      if !buffer.isEmpty {
        pieces.append(.text(String(buffer)))
        buffer = String.UnicodeScalarView()
      }
    }

    while index < scalars.count {
      let scalar = scalars[index]

      // `\{{`: the braces are text, the backslash is not.
      if scalar == "\\", index + 2 < scalars.count, scalars[index + 1] == "{", scalars[index + 2] == "{" {
        buffer.append(contentsOf: [scalars[index + 1], scalars[index + 2]])
        index += 3
        continue
      }

      if scalar == "{", index + 1 < scalars.count, scalars[index + 1] == "{",
        let close = closing(scalars, after: index + 2)
      {
        let inner = String(String.UnicodeScalarView(scalars[(index + 2)..<close]))
        let name = inner.trimmingCharacters(in: .whitespaces)

        if isFieldName(name) {
          flush()
          pieces.append(.field(name))
          index = close + 2
          continue
        }
      }

      buffer.append(scalar)
      index += 1
    }

    flush()
    return pieces
  }

  /// The index of the `}}` that closes a field opened before `start`, or nil. A brace or a line
  /// break inside ends the search: that is not a field.
  private static func closing(_ scalars: [Unicode.Scalar], after start: Int) -> Int? {
    var index = start

    while index + 1 < scalars.count {
      let scalar = scalars[index]

      if scalar == "}", scalars[index + 1] == "}" {
        return index
      }

      if scalar == "{" || scalar == "}" || scalar.properties.generalCategory == .control || index - start > maxNameLength + 8 {
        return nil
      }

      index += 1
    }

    return nil
  }
}
