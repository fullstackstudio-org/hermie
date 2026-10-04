import Foundation

/// A shared file's name as the person sees it and as a copy of it is saved.
///
/// A name is the bot's own text: it may hold a right-to-left override that makes `report.exe.pdf` read as
/// `report.fdp.exe`, a zero-width joiner, a line separator. The name on the card and the name the file is
/// saved under are both stripped of control and format characters (`\p{Cc}`, `\p{Cf}`) and of the line and
/// paragraph separators, so the saved name is the one the reader saw and neither can pretend to be another
/// file. Nothing else is changed in what is shown: the name is the text it is.
public enum OutboxText {
  /// The most bytes a saved name has (a name of 180 characters can be 720 bytes; file systems stop at 255).
  public static let savedNameMaximumBytes = 200

  /// What is never shown or saved: a control or format character, and a line or paragraph separator.
  static func isStripped(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .control, .format, .lineSeparator, .paragraphSeparator: true
    default: false
    }
  }

  /// `name` as drawn on a card and spoken by VoiceOver.
  public static func displayName(_ name: String) -> String {
    var scalars = String.UnicodeScalarView()
    scalars.append(contentsOf: name.unicodeScalars.filter { !isStripped($0) })
    let shown = String(scalars)
    return shown.isEmpty ? "file" : shown
  }

  /// The name a copy is saved under: the card's name, without what a file system refuses (`<>:"|?*` and a
  /// slash, which become `_`), without a leading or trailing space, never hidden (a leading dot gets a `_` before
  /// it), at most `savedNameMaximumBytes` bytes with its extension kept, and never empty or only dots.
  public static func savedName(_ name: String) -> String {
    let refused: Set<Unicode.Scalar> = ["<", ">", ":", "\"", "|", "?", "*", "/", "\\"]
    var scalars = String.UnicodeScalarView()
    for scalar in name.unicodeScalars where !isStripped(scalar) {
      scalars.append(refused.contains(scalar) ? "_" : scalar)
    }
    var cleaned = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty, cleaned.unicodeScalars.contains(where: { $0 != "." }) else { return "file" }
    // A name that starts with a dot is a hidden file on a Mac and in Files: what was saved would not be seen.
    if cleaned.unicodeScalars.first == "." { cleaned = "_" + cleaned }
    return limited(cleaned)
  }

  /// `name` cut to `savedNameMaximumBytes` bytes at a character boundary, its extension (up to 16 bytes) kept.
  private static func limited(_ name: String) -> String {
    guard name.utf8.count > savedNameMaximumBytes else { return name }
    var stem = name
    var tail = ""

    if let dot = name.lastIndex(of: "."), dot != name.startIndex {
      let extensionPart = String(name[dot...])
      if extensionPart.utf8.count <= 16 {
        stem = String(name[..<dot])
        tail = extensionPart
      }
    }

    var kept = ""
    var used = tail.utf8.count

    for character in stem {
      let size = String(character).utf8.count
      if used + size > savedNameMaximumBytes { break }
      kept.append(character)
      used += size
    }

    return kept + tail
  }
}
