import Foundation

/**
 Markdown to the words, for a place that cannot show Markdown: what "Copy text" puts on the pasteboard
 (`packages/markdown/src/plain-text.ts`, `plainTextBlock`), and the links a message holds
 (`messageLinks` in the Expo app's `chat-ui/message-menu.ts`).

 Deliberately not the parser in this module: that one produces blocks to draw and costs real time; a
 copy needs a string, once, when the reader asks. The two may disagree on an exotic construct; the
 renderer is what the reader opened the chat to see.

 What goes: heading hashes and setext underlines, emphasis and strike runs, fence lines and inline
 backticks, list and task markers, blockquote arrows, thematic breaks, and table pipes with their
 delimiter row. A link collapses to its text. What stands inside a fence is kept as it is.
 */
public enum MarkdownPlainText {
  /// The most links one message's menu lists: a menu taller than the window is not a menu.
  public static let maxLinks = 8

  /// The words of `markdown`, lines kept: no markup, no trailing blanks, no more than one empty line
  /// in a row, trimmed. Empty in, empty out.
  public static func block(_ markdown: String) -> String {
    guard !markdown.isEmpty else {
      return ""
    }

    let joined = lines(markdown).joined(separator: "\n")
    var out: [String] = []

    for line in joined.split(separator: "\n", omittingEmptySubsequences: false) {
      var trimmed = Substring(line)

      while let last = trimmed.last, last == " " || last == "\t" {
        trimmed = trimmed.dropLast()
      }

      out.append(String(trimmed))
    }

    return Patterns.blankRun.replace(out.joined(separator: "\n"), with: "\n\n").jsTrimmed
  }

  /// Whether copying `markdown` as text and as Markdown give different strings: when they would be the
  /// same, only one line is offered, because two identical lines read as a bug.
  public static func differs(_ markdown: String) -> Bool {
    block(markdown) != markdown
  }

  /// Every link in `text`, in the order it appears, without duplicates, at most `limit`: `[text](href)`,
  /// `<https://…>` and a bare URL the writer left without any syntax around it.
  public static func links(in text: String, limit: Int = maxLinks) -> [String] {
    guard !text.isEmpty else {
      return []
    }

    var seen: Set<String> = []
    var out: [String] = []

    func add(_ href: String?) {
      guard let trimmed = href?.jsTrimmed, !trimmed.isEmpty, seen.insert(trimmed).inserted else {
        return
      }

      out.append(trimmed)
    }

    for match in Patterns.link.matches(text) {
      add(match[1] ?? match[2])
    }

    for match in Patterns.bareURL.matches(text) {
      add(match[0])
    }

    return Array(out.prefix(limit))
  }

  // MARK: The stripping

  private static func lines(_ markdown: String) -> [String] {
    var out: [String] = []
    var inFence = false

    for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
      if Patterns.fence.test(raw) {
        // The fence line itself is never content, in either direction.
        inFence.toggle()
        continue
      }

      if inFence {
        // Verbatim: the point of a fence is that what is inside it is not markup.
        out.append(raw)
        continue
      }

      if Patterns.tableDelimiter.test(raw) || Patterns.setextOrRule.test(raw) {
        continue
      }

      var line = Patterns.quoteMarker.replace(raw, with: "")
      line = Patterns.heading.replace(line, with: "")
      line = Patterns.listMarker.replace(line, with: "")
      // A table row reads as its cells with the rails taken off.
      line = Patterns.leadingRail.replace(line, with: "")
      line = Patterns.trailingRail.replace(line, with: "")
      line = Patterns.rail.replace(line, with: " ")
      out.append(inline(line))
    }

    return out
  }

  private static func inline(_ line: String) -> String {
    // Code spans first: their content is literal, and a `*` inside one is not emphasis.
    var text = Patterns.codeSpan.replace(line) { match, _ in (match[2] ?? "").jsTrimmed }
    text = Patterns.image.replace(text) { match, _ in match[1] ?? "" }
    text = Patterns.markdownLink.replace(text) { match, _ in match[1] ?? "" }
    text = Patterns.refLink.replace(text) { match, _ in match[1] ?? "" }
    text = Patterns.autolink.replace(text) { match, _ in match[1] ?? "" }

    // Twice: `**a _b_ c**` needs the inner run resolved before the outer one can match across it.
    for _ in 0..<2 {
      text = Patterns.starEmphasis.replace(text) { match, _ in match[2] ?? "" }
      text = Patterns.underEmphasis.replace(text) { match, _ in (match[1] ?? "") + (match[3] ?? "") }
    }

    // Backtick runs the span rule could not pair are syntax with no content.
    text = text.replacingOccurrences(of: "`", with: "")
    return Patterns.escape.replace(text) { match, _ in match[1] ?? "" }
  }

  private enum Patterns {
    static let fence = JSRegex(#"^\s{0,3}(?:`{3,}|~{3,})"#)
    static let heading = JSRegex(#"^\s{0,3}#{1,6}(?:\s+|\z)"#)
    static let setextOrRule = JSRegex(#"^\s{0,3}(?:=+|-{2,}|\*{3,}|_{3,})\s*\z"#)
    static let listMarker = JSRegex(#"^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?"#)
    static let quoteMarker = JSRegex(#"^\s*(?:>\s?)+"#)
    static let tableDelimiter = JSRegex(#"^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*\z"#)
    static let leadingRail = JSRegex(#"^\s*\|"#)
    static let trailingRail = JSRegex(#"\|\s*\z"#)
    static let rail = JSRegex(#"\|"#)
    static let image = JSRegex(#"!\[([^\]]*)\]\([^)]*\)"#)
    static let markdownLink = JSRegex(#"\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)"#)
    static let refLink = JSRegex(#"\[([^\]]*)\]\[[^\]]*\]"#)
    static let autolink = JSRegex(#"<((?:https?|mailto):[^>\s]+)>"#)
    static let starEmphasis = JSRegex(#"(\*{1,3}|~{2})(?!\s)([^\n]*?[^\s\\])\1"#)
    static let underEmphasis = JSRegex(#"(^|[^\w])(_{1,3})(?!\s)([^\n]*?[^\s\\])\2(?![\w])"#)
    static let escape = JSRegex(#"\\([\\`*_{}\[\]()#+\-.!>~|])"#)
    static let codeSpan = JSRegex(#"(`+)([^`]|[^`][\s\S]*?[^`])\1"#)
    static let blankRun = JSRegex(#"\n{3,}"#)
    // For the links of a message.
    static let link = JSRegex(#"\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)|<((?:https?|mailto):[^>\s]+)>"#)
    static let bareURL = JSRegex(#"\bhttps?://[^\s<>()\[\]"']+"#)
  }
}
