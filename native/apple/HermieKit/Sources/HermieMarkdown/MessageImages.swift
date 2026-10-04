import Foundation

/// A picture a message names: what to draw as a thumbnail under its words.
public struct MessageImage: Sendable, Hashable, Identifiable {
  /// What the attachment opener takes: an `@image:` / `@file:` reference, a `/api/files/…` path, or
  /// an absolute path (a gateway on this device).
  public var reference: String
  /// The file's own name, for the caption of a picture that cannot be shown and for VoiceOver.
  public var name: String
  /// The alternative text of a Markdown image, when it had one.
  public var alt: String?

  public var id: String { reference }

  public init(reference: String, name: String, alt: String? = nil) {
    self.reference = reference
    self.name = name
    self.alt = alt
  }

  /// What VoiceOver says: the description the author gave it, or the file's name.
  public var label: String {
    if let alt, !alt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return alt }
    return name
  }
}

/// Which pictures a message holds, read from its text and its attachments.
///
/// Only what this device can plausibly load is a picture: a file the gateway serves under
/// `/api/files/`, or an absolute path (which opens when the gateway runs on this device, and says
/// so when it does not). A web address is never fetched by a message (the sender is untrusted, and
/// a request is a way to say "this person read it"), so a Markdown image from the web stays what the
/// Markdown parser makes of it: its alt text.
public enum MessageImages {
  /// What a file is called when it is a picture the system can decode.
  public static let imageExtensions: Set<String> = [
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif", "ico"
  ]

  /// Whether `path` names a picture by its extension, ignoring a query or fragment.
  public static func isImagePath(_ path: String) -> Bool {
    var end = path.endIndex
    if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { end = cut }
    let bare = path[..<end]
    guard let dot = bare.lastIndex(of: "."), bare.index(after: dot) < bare.endIndex else { return false }
    return imageExtensions.contains(bare[bare.index(after: dot)...].lowercased())
  }

  // MARK: Attachments

  /// The attachments of a turn split into the pictures and the rest. A picture is an `@image:`
  /// reference, or any reference whose file name says it is one.
  public static func split(attachments references: [String]) -> (images: [MessageImage], others: [String]) {
    var images: [MessageImage] = []
    var others: [String] = []
    for reference in references {
      let value = unwrapped(reference)
      // A picture this device could load: an `@image:` reference holding only a file name (a turn the
      // owner just sent, whose bytes went to the gateway out of band) is a chip until the gateway's
      // own row replaces it.
      if (reference.hasPrefix("@image:") || isImagePath(value)) && isLoadable(value) {
        images.append(MessageImage(reference: reference, name: fileName(of: value)))
      } else {
        others.append(reference)
      }
    }
    return (images, others)
  }

  /// `images` without repeats, in order: two names for one file (`@image:/api/files/a.png` and
  /// `/api/files/a.png`) are one picture.
  public static func unique(_ images: [MessageImage]) -> [MessageImage] {
    var seen = Set<String>()
    return images.filter { seen.insert(unwrapped($0.reference)).inserted }
  }

  // MARK: Text

  /// The pictures a reply names, in order, without repeats: `![alt](/api/files/chart.png)`, and a
  /// `MEDIA:` delivery of a picture (which the preprocessor turns into a link).
  public static func extract(from text: String) -> [MessageImage] {
    guard text.contains("](") || text.contains("MEDIA:") else { return [] }
    return extract(preprocessed: MarkdownPreprocessor.preprocess(text))
  }

  /// `extract(from:)` for text the preprocessor has already seen.
  public static func extract(preprocessed source: String) -> [MessageImage] {
    guard source.contains("](") else { return [] }
    var found: [MessageImage] = []
    var seen = Set<String>()
    var fence: Character?

    for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = line.drop(while: { $0 == " " })
      if let marker = trimmed.first, marker == "`" || marker == "~", trimmed.prefix(3).allSatisfy({ $0 == marker }), trimmed.count >= 3 {
        if fence == nil {
          fence = marker
        } else if fence == marker {
          fence = nil
        }
        continue
      }
      guard fence == nil, line.contains("](") else { continue }

      let prose = blankingCodeSpans(String(line))
      let matches = Patterns.link.matches(in: prose, range: NSRange(prose.startIndex..., in: prose))
      for match in matches {
        guard
          let bang = Range(match.range(at: 1), in: prose), let altRange = Range(match.range(at: 2), in: prose),
          let destRange = Range(match.range(at: 3), in: prose)
        else { continue }
        let isImageSyntax = !prose[bang].isEmpty
        let destination = destination(of: String(prose[destRange]))
        guard isLoadable(destination), isImageSyntax ? couldBePicture(destination) : isImagePath(destination) else {
          continue
        }
        guard seen.insert(destination).inserted else { continue }
        let alt = String(prose[altRange]).trimmingCharacters(in: .whitespaces)
        found.append(MessageImage(reference: destination, name: fileName(of: destination), alt: alt.isEmpty ? nil : alt))
      }
    }
    return found
  }

  // MARK: Pieces

  private enum Patterns {
    /// `![alt](dest)` and `[label](dest)`: group 1 is the bang, 2 the label, 3 the destination.
    static let link: NSRegularExpression = {
      // The destination may hold spaces (a `MEDIA:` path does) and balanced parentheses.
      let pattern = #"(!?)\[([^\]\n]*)\]\(\s*((?:<[^>\n]*>|[^()\n]|\([^()\n]*\))+?)\s*\)"#
      return try! NSRegularExpression(pattern: pattern)
    }()
    static let scheme = try! NSRegularExpression(pattern: #"^[A-Za-z][A-Za-z0-9+.-]*:"#)
    static let title = try! NSRegularExpression(pattern: #"\s+(?:"[^"]*"|'[^']*')$"#)
  }

  /// A line with the contents of its inline code spans replaced by spaces, so a link written inside
  /// backticks is not read as one.
  static func blankingCodeSpans(_ line: String) -> String {
    guard line.contains("`") else { return line }
    var out = ""
    var inCode = false
    for character in line {
      if character == "`" {
        inCode.toggle()
        out.append(" ")
      } else {
        out.append(inCode ? " " : character)
      }
    }
    return out
  }

  /// The destination as a path: without angle brackets or a title.
  static func destination(of raw: String) -> String {
    var text = raw.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("<"), let close = text.firstIndex(of: ">") {
      return String(text[text.index(after: text.startIndex)..<close])
    }
    let range = NSRange(text.startIndex..., in: text)
    if let match = Patterns.title.firstMatch(in: text, range: range), let cut = Range(match.range, in: text) {
      text = String(text[..<cut.lowerBound])
    }
    return text
  }

  /// A path this device might load: absolute, or under the gateway's files, and not a web address,
  /// a `data:` URI or anything else with a scheme.
  static func isLoadable(_ destination: String) -> Bool {
    guard !destination.isEmpty, !destination.contains("\0"), !destination.contains("\\") else { return false }
    let range = NSRange(destination.startIndex..., in: destination)
    if Patterns.scheme.firstMatch(in: destination, range: range) != nil { return false }
    // `//host/path` is a web address that takes the page's scheme, not a path.
    if destination.hasPrefix("//") { return false }
    return destination.hasPrefix("/") || destination.hasPrefix("api/files/")
  }

  /// A Markdown image whose destination is not named like a picture is still one when the gateway
  /// serves it (`/api/files/…` has no extension in some deliveries).
  static func couldBePicture(_ destination: String) -> Bool {
    isImagePath(destination) || destination.hasPrefix("/api/files/") || destination.hasPrefix("api/files/")
  }

  /// A reference without its `@file:` / `@image:` marker and its quotes.
  static func unwrapped(_ reference: String) -> String {
    var value = Substring(reference.trimmingCharacters(in: .whitespacesAndNewlines))
    for prefix in ["@file:", "@image:"] where value.hasPrefix(prefix) {
      value = value.dropFirst(prefix.count)
      break
    }
    let quotes: Set<Character> = ["\"", "'", "`"]
    if let first = value.first, quotes.contains(first) { value = value.dropFirst() }
    if let last = value.last, quotes.contains(last) { value = value.dropLast() }
    return String(value)
  }

  /// The last path component, without a query or fragment, percent-decoded for display.
  static func fileName(of path: String) -> String {
    var bare = Substring(path)
    if let cut = bare.firstIndex(where: { $0 == "?" || $0 == "#" }) { bare = bare[..<cut] }
    let last = bare.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? String(bare)
    return last.removingPercentEncoding ?? last
  }
}
