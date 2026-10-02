import Foundation

/// The Hermes-specific Markdown fixes, applied before any parser sees the text.
///
/// A port of `expo/hermie/src/markdown/preprocess.ts`: the same rules in the
/// same order, checked against the TypeScript output by the `preprocessed`
/// field of every case in `contract/markdown/`. Like the original it is pure
/// and safe to run on every streaming flush:
///
/// - reasoning blocks (`<think>…`), closed or still open, are removed;
/// - fences are normalised (language sanitised, empty and URL-only fences
///   dropped, an unterminated fence left open so it already reads as code);
/// - `MEDIA:` delivery tags become links;
/// - stray spaces inside a `**` / `__` pair are dropped;
/// - citation markers (`word[1]`) are removed and bare URLs autolinked;
/// - a table gets the blank lines GFM needs around it.
///
/// Mathematics is not touched here, as in the original; the parser owns it.
public enum MarkdownPreprocessor {
  public static func preprocess(_ text: String) -> String {
    let cleaned = stripReasoningBlocks(text)
    let normalizedFences = normalizeFenceBlocks(cleaned)
    let withoutEmptyFences = Patterns.emptyFenceBlock.replace(normalizedFences) { match, _ in match[1] ?? "" }

    return Patterns.codeFenceSplit.split(withoutEmptyFences).map { part in
      // Fenced blocks pass through untouched: a `[1]` or a bare URL inside a
      // listing is the listing's own text.
      if part.hasPrefix("```") || part.hasPrefix("~~~") {
        return part
      }
      return spaceTableBlocks(normalizeVisibleProse(repairStrayEmphasisSpaces(renderMediaTags(part))))
    }.joined()
  }

  // MARK: - Patterns

  enum Patterns {
    static let reasoningTags = "think|thinking|reasoning|thought|reasoning_scratchpad|scratchpad|analysis"

    static let reasoningBlock = JSRegex(#"(?:<("# + reasoningTags + #")>[\s\S]*?</\1>\s*)+"#, caseInsensitive: true)
    static let openReasoningBlock = JSRegex(#"(^|\n)[ \t]*<("# + reasoningTags + #")>[\s\S]*\z"#, caseInsensitive: true)

    static let reasoningTagPrefixes: String = {
      var seen = Set<String>()
      var ordered: [String] = []
      for tag in reasoningTags.split(separator: "|") {
        for length in 1...tag.count {
          let prefix = String(tag.prefix(length))
          if seen.insert(prefix).inserted {
            ordered.append(prefix)
          }
        }
      }
      return ordered.joined(separator: "|")
    }()

    static let partialOpenReasoningTag = JSRegex(
      #"(^|\n)[ \t]*<(?:"# + reasoningTagPrefixes + #")?\z"#, caseInsensitive: true)

    static let fenceLine = JSRegex(#"^([ \t]*)(`{3,}|~{3,})([^\n]*)\z"#)
    static let emptyFenceBlock = JSRegex(#"(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|\z)"#)
    static let codeFenceSplit = JSRegex(#"((?:```|~~~)[\s\S]*?(?:```|~~~|\z))"#)
    static let inlineCodeSplit = JSRegex(#"(`[^`\n]+`)"#)
    static let urlOnlyLine = JSRegex(#"^\s*https?://\S+\s*\z"#, caseInsensitive: true)
    static let validLanguage = JSRegex(#"^[a-z0-9][a-z0-9+#-]*\z"#, caseInsensitive: true)
    static let whitespaceRun = JSRegex(#"\s+"#)

    // `\d` is written `[0-9]`: JavaScript's `\d` is ASCII even under `u`, ICU's is not.
    static let citationMarker = JSRegex(#"(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:[0-9]+(?:\s*,\s*[0-9]+)*)\](?!\()"#)
    static let rawURL = JSRegex(#"https?://[^\s<>"'`*]+[^\s<>"'`*.,;:!?]"#)

    static let linkSyntax = #"!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<[^\s<>]*>"#
    static let linkSyntaxSplit = JSRegex("(" + linkSyntax + ")")
    static let linkSyntaxWhole = JSRegex("^(?:" + linkSyntax + ")\\z")

    static let mediaDeliveryExtensions = [
      "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg", "mp4", "mov", "avi", "mkv", "webm", "3gp", "mp3",
      "m2a", "wav", "ogg", "opus", "m4a", "flac", "pdf", "docx", "doc", "odt", "rtf", "txt", "md", "epub", "xlsx",
      "xls", "ods", "csv", "tsv", "json", "xml", "yaml", "yml", "kmz", "kml", "geojson", "gpx", "pptx", "ppt", "odp",
      "key", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "apk", "ipa", "html", "htm"
    ]

    // Longest first (a stable sort, as in the original), so the alternation
    // never matches a short extension as the prefix of a longer one.
    static let mediaExtensionAlternation: String = mediaDeliveryExtensions.enumerated()
      .sorted { lhs, rhs in
        lhs.element.count != rhs.element.count ? lhs.element.count > rhs.element.count : lhs.offset < rhs.offset
      }
      .map(\.element)
      .joined(separator: "|")

    static let mediaPathAnchored =
      #"(?:~/|/|[A-Za-z]:[/\\])\S+?(?:[^\S\n]+\S+?)*?\.(?:"# + mediaExtensionAlternation
      + #")(?=[\s`"'*_,;:)\]}]|MEDIA:|\z)"#

    static let mediaValue = #"`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|"# + mediaPathAnchored + #"|\S+"#

    static let mediaLine = JSRegex(#"(^|\n)[\t ]*[`"']?MEDIA:\s*("# + mediaValue + #")[`"']?[\t ]*(\n|\z)"#)
    static let mediaTag = JSRegex(#"[`"']?MEDIA:\s*("# + mediaValue + #")[`"']?"#)

    static let tableDelimiter = JSRegex(#"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*\z"#)
    static let delimiterRun = JSRegex(#"\*+|_+"#)
    static let emphasisPunctuation = CharacterSet.punctuationCharacters.union(.symbols)
  }

  // MARK: - Reasoning blocks

  static func stripReasoningBlocks(_ text: String) -> String {
    // Removing a closed block between two words keeps one space, so `no` and
    // `Hermes` do not fuse into `noHermes`.
    let closed = Patterns.reasoningBlock.replace(text) { match, whole in
      let start = match.range.location
      let end = start + match.range.length
      let previous: UInt16? = start > 0 ? whole.character(at: start - 1) : nil
      let next: UInt16? = end < whole.length ? whole.character(at: end) : nil
      if let previous, let next, !jsIsSpace(previous), !jsIsSpace(next) {
        return " "
      }
      return ""
    }
    return replaceFirst(replaceFirst(closed, Patterns.openReasoningBlock), Patterns.partialOpenReasoningTag)
  }

  /// `text.replace(regex, '$1')` for a non-global regex: the first match only.
  private static func replaceFirst(_ text: String, _ regex: JSRegex) -> String {
    let ns = text as NSString
    guard let match = regex.regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else {
      return text
    }
    let lead = match.range(at: 1).location == NSNotFound ? "" : ns.substring(with: match.range(at: 1))
    return ns.replacingCharacters(in: match.range, with: lead)
  }

  // MARK: - MEDIA tags

  private static func unquoteMediaPath(_ value: String) -> String {
    let trimmed = value.jsTrimmed
    guard let quote = trimmed.first, ["\"", "'", "`"].contains(quote), trimmed.count >= 1, trimmed.last == quote else {
      return trimmed
    }
    // `slice(1, -1)` of a one-character string is empty.
    return trimmed.count >= 2 ? String(trimmed.dropFirst().dropLast()) : ""
  }

  private static func mediaLabel(_ path: String) -> String {
    let base = path.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? path
    return base.isEmpty ? path : base
  }

  private static func mediaLink(_ value: String) -> String {
    let path = unquoteMediaPath(value)
    return "[\(mediaLabel(path))](\(path))"
  }

  /// `MEDIA:/srv/out/report.pdf` → `[report.pdf](/srv/out/report.pdf)`.
  static func renderMediaTags(_ text: String) -> String {
    guard text.contains("MEDIA:") else { return text }
    let lines = Patterns.mediaLine.replace(text) { match, _ in
      (match[1] ?? "") + mediaLink(match[2] ?? "") + (match[3] ?? "")
    }
    return Patterns.mediaTag.replace(lines) { match, _ in mediaLink(match[1] ?? "") }
  }

  // MARK: - Fences

  private static func sanitizeLanguageTag(_ tag: String) -> String {
    let first = Patterns.whitespaceRun.split(tag.jsTrimmed).first ?? ""
    return Patterns.validLanguage.test(first) && first.jsLength <= 16 ? first.lowercased() : ""
  }

  private static func isURLOnlyBlock(_ lines: [String]) -> Bool {
    let nonEmpty = lines.filter(\.hasNonSpace)
    return !nonEmpty.isEmpty && nonEmpty.allSatisfy { Patterns.urlOnlyLine.test($0) }
  }

  private static func findClosingFence(_ lines: [String], start: Int, marker: String) -> Int {
    var cursor = start + 1
    while cursor < lines.count {
      if let close = Patterns.fenceLine.firstMatch(lines[cursor]) {
        let closeMarker = close[2] ?? ""
        let closeInfo = (close[3] ?? "").jsTrimmed
        if closeInfo.isEmpty, closeMarker.first == marker.first, closeMarker.jsLength >= marker.jsLength {
          return cursor
        }
      }
      cursor += 1
    }
    return -1
  }

  /// Rewrite every fence to `marker + sanitized language`, drop empty and
  /// URL-only fences, and leave an unterminated fence open.
  static func normalizeFenceBlocks(_ text: String) -> String {
    let sourceLines = text.components(separatedBy: "\n")
    var out: [String] = []
    var index = 0

    while index < sourceLines.count {
      let line = sourceLines[index]
      guard let match = Patterns.fenceLine.firstMatch(line) else {
        out.append(line)
        index += 1
        continue
      }

      let indent = match[1] ?? ""
      let marker = match[2] ?? "```"
      let infoRaw = (match[3] ?? "").jsTrimmed
      let languageToken = Patterns.whitespaceRun.split(infoRaw).first ?? ""
      let language = sanitizeLanguageTag(languageToken)

      // An info string that is not a language tag at all is prose the model
      // fenced by accident.
      if !infoRaw.isEmpty && language.isEmpty {
        out.append(trimEnd(indent + infoRaw))
        index += 1
        continue
      }

      let closeIndex = findClosingFence(sourceLines, start: index, marker: marker)
      let bodyLines = Array(sourceLines[(index + 1)..<(closeIndex == -1 ? sourceLines.count : closeIndex)])
      let body = bodyLines.joined(separator: "\n")

      if closeIndex != -1 && !body.hasNonSpace {
        index = closeIndex + 1
        continue
      }

      if closeIndex != -1 && isURLOnlyBlock(bodyLines) {
        out.append(contentsOf: bodyLines)
        index = closeIndex + 1
        continue
      }

      if closeIndex == -1 {
        if !body.hasNonSpace {
          index += 1
          continue
        }
        out.append(indent + marker + language)
        out.append(contentsOf: bodyLines)
        break
      }

      out.append(indent + marker + language)
      out.append(contentsOf: bodyLines)
      out.append(indent + marker)
      index = closeIndex + 1
    }

    return out.joined(separator: "\n")
  }

  /// JavaScript's `trimEnd()`.
  private static func trimEnd(_ text: String) -> String {
    var units = Array(text.utf16)
    while let last = units.last, jsIsSpace(last) {
      units.removeLast()
    }
    return String(decoding: units, as: UTF16.self)
  }

  // MARK: - Tables

  private static func isDelimiterRow(_ line: String) -> Bool {
    // The `-` check first: it is the cheap half and almost always false.
    line.contains("-") && Patterns.tableDelimiter.test(line)
  }

  /// Insert the blank line GFM wants above a table, and below it when the next
  /// line is ordinary prose.
  static func spaceTableBlocks(_ text: String) -> String {
    guard text.contains("|") else { return text }
    let lines = text.components(separatedBy: "\n")
    var out: [String] = []
    // `out.some(isDelimiterRow)` in the original; `out` only grows, so a flag
    // that turns on once says the same thing without rescanning.
    var outHasDelimiter = false

    func push(_ line: String) {
      out.append(line)
      if !outHasDelimiter && line.contains("-") && Patterns.tableDelimiter.test(line) {
        outHasDelimiter = true
      }
    }

    for index in lines.indices {
      let line = lines[index]
      let previous: String? = index > 0 ? lines[index - 1] : nil
      let following: String? = index + 1 < lines.count ? lines[index + 1] : nil
      let delimiterFollows = isDelimiterRow(following ?? "")
      let hasPipe = line.contains("|")

      if delimiterFollows, hasPipe, let previous, previous.hasNonSpace, !previous.contains("|") {
        push("")
      }

      push(line)

      if hasPipe, outHasDelimiter, let following, following.hasNonSpace, !following.contains("|"),
        !Patterns.tableDelimiter.test(line)
      {
        push("")
      }
    }

    return out.joined(separator: "\n")
  }

  // MARK: - Prose

  static func trimURLTail(_ url: String) -> String {
    var units = Array(url.utf16)
    let tailPunctuation: Set<UInt16> = Set("!\"'*,.:;?_~".utf16)
    let close = UInt16(UInt8(ascii: ")")), closeSquare = UInt16(UInt8(ascii: "]"))
    while let last = units.last {
      if last == close || last == closeSquare {
        let opener = last == close ? UInt16(UInt8(ascii: "(")) : UInt16(UInt8(ascii: "["))
        if units.count(where: { $0 == last }) <= units.count(where: { $0 == opener }) {
          break
        }
        units.removeLast()
        continue
      }
      guard tailPunctuation.contains(last) else { break }
      units.removeLast()
    }
    return String(decoding: units, as: UTF16.self)
  }

  private static func autolinkBareURLs(_ segment: String) -> String {
    Patterns.rawURL.replace(segment) { match, _ in
      let url = match[0] ?? ""
      let href = trimURLTail(url)
      guard !href.isEmpty else { return url }
      let rest = String(decoding: url.utf16.dropFirst(href.jsLength), as: UTF16.self)
      return "<\(href)>\(rest)"
    }
  }

  private static func rewriteProseSegment(_ segment: String) -> String {
    let withoutCitations = Patterns.citationMarker.replace(segment, with: "")
    return Patterns.linkSyntaxSplit.split(withoutCitations)
      .map { Patterns.linkSyntaxWhole.test($0) ? $0 : autolinkBareURLs($0) }
      .joined()
  }

  static func normalizeVisibleProse(_ text: String) -> String {
    Patterns.inlineCodeSplit.split(text)
      .map { $0.hasPrefix("`") ? $0 : rewriteProseSegment($0) }
      .joined()
  }

  // MARK: - Stray emphasis spaces

  private struct DelimiterRun {
    var char: UInt16
    var start: Int
    var end: Int
  }

  private static func maskInlineCode(_ line: String) -> [UInt16] {
    Patterns.inlineCodeSplit.split(line).flatMap { part -> [UInt16] in
      part.hasPrefix("`") ? Array(repeating: 0, count: part.jsLength) : Array(part.utf16)
    }
  }

  private static func isSpaceAt(_ text: [UInt16], _ index: Int) -> Bool {
    guard index >= 0, index < text.count else { return true }
    return jsIsSpace(text[index])
  }

  private static func isPunctuationAt(_ text: [UInt16], _ index: Int) -> Bool {
    guard index >= 0, index < text.count, let scalar = Unicode.Scalar(text[index]) else { return false }
    return Patterns.emphasisPunctuation.contains(scalar)
  }

  private static func isLeftFlanking(_ text: [UInt16], _ start: Int, _ end: Int) -> Bool {
    if isSpaceAt(text, end) { return false }
    return !isPunctuationAt(text, end) || isSpaceAt(text, start - 1) || isPunctuationAt(text, start - 1)
  }

  private static func isRightFlanking(_ text: [UInt16], _ start: Int, _ end: Int) -> Bool {
    if isSpaceAt(text, start - 1) { return false }
    return !isPunctuationAt(text, start - 1) || isSpaceAt(text, end) || isPunctuationAt(text, end)
  }

  private static let underscore = UInt16(UInt8(ascii: "_"))

  private static func canOpen(_ text: [UInt16], _ run: DelimiterRun) -> Bool {
    guard isLeftFlanking(text, run.start, run.end) else { return false }
    return run.char != underscore || !isRightFlanking(text, run.start, run.end) || isPunctuationAt(text, run.start - 1)
  }

  private static func canClose(_ text: [UInt16], _ run: DelimiterRun) -> Bool {
    guard isRightFlanking(text, run.start, run.end) else { return false }
    return run.char != underscore || !isLeftFlanking(text, run.start, run.end) || isPunctuationAt(text, run.end)
  }

  private static func delimiterRuns(_ masked: [UInt16]) -> [DelimiterRun] {
    var runs: [DelimiterRun] = []
    var index = 0
    let star = UInt16(UInt8(ascii: "*"))
    while index < masked.count {
      let char = masked[index]
      guard char == star || char == underscore else {
        index += 1
        continue
      }
      var end = index
      while end < masked.count && masked[end] == char { end += 1 }
      if end - index == 2 {
        runs.append(DelimiterRun(char: char, start: index, end: end))
      }
      index = end
    }
    return runs
  }

  private static func isInlineSpace(_ unit: UInt16) -> Bool {
    unit != 0x0A && jsIsSpace(unit)
  }

  private static func repairEmphasisLine(_ line: String) -> String {
    // Only a run of exactly two delimiters is a candidate; a line without one
    // has nothing to repair.
    guard line.contains("**") || line.contains("__") else { return line }
    let masked = maskInlineCode(line)
    let runs = delimiterRuns(masked)
    var cuts: [Range<Int>] = []

    var index = 0
    while index + 1 < runs.count {
      defer { index += 2 }
      let open = runs[index]
      let close = runs[index + 1]
      guard open.char == close.char else { continue }

      var openSpaceEnd = open.end
      while openSpaceEnd < masked.count && isInlineSpace(masked[openSpaceEnd]) { openSpaceEnd += 1 }
      var closeSpaceStart = close.start
      while closeSpaceStart > 0 && isInlineSpace(masked[closeSpaceStart - 1]) { closeSpaceStart -= 1 }
      let openBroken = openSpaceEnd > open.end
      let closeBroken = closeSpaceStart < close.start
      guard openBroken != closeBroken else { continue }

      let cut = openBroken ? open.end..<openSpaceEnd : closeSpaceStart..<close.start
      let contentStart = openBroken ? openSpaceEnd : open.end
      let contentEnd = openBroken ? close.start : closeSpaceStart
      let content = contentStart < contentEnd ? Array(masked[contentStart..<contentEnd]) : []
      guard content.contains(where: { !jsIsSpace($0) }) else { continue }

      var repaired = masked
      repaired.removeSubrange(cut)
      let shift = cut.count
      let movedClose = DelimiterRun(char: close.char, start: close.start - shift, end: close.end - shift)
      if canOpen(repaired, open) && canClose(repaired, movedClose) {
        cuts.append(cut)
      }
    }

    guard !cuts.isEmpty else { return line }
    var out = Array(line.utf16)
    for cut in cuts.reversed() {
      out.removeSubrange(cut)
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// `** bold**` and `**bold **` → `**bold**`, line by line.
  static func repairStrayEmphasisSpaces(_ text: String) -> String {
    guard text.contains("**") || text.contains("__") else { return text }
    return text.components(separatedBy: "\n").map(repairEmphasisLine).joined(separator: "\n")
  }
}
