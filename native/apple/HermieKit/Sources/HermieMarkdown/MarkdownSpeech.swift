import Foundation

/**
 Markdown as the words worth saying, for something that is going to read them aloud
 (`features/voice/speech-text.ts` in the Expo app).

 A speech engine reads characters in order, cannot skim and cannot go back, so the question is not
 "what is the text" (that is `MarkdownPlainText`) but "what is worth the listener's time":

 - **A code block is read as its shape**, not its contents: forty lines of source spoken one symbol at
 a time is ninety seconds of noise. Up to `shortCodeLines` short lines are read out, because a
 one-liner is often the answer.
 - **A table is read row by row**, cells separated by commas, the delimiter row dropped.
 - **Mathematics is read as its source**, never stripped: `a_1 + b_2` between dollar signs must not
 lose its subscripts to the emphasis rule.
 - **A link reads its label**, never its address.
 - A line that ends without punctuation gets a full stop, because an engine pauses on punctuation,
 not on a newline.

 Safe on an empty string and on a reply that is still arriving: an unclosed fence is summarised from
 what has come so far.
 */
public enum MarkdownSpeech {
  /// How many lines a fenced block may have and still be read out in full.
  public static let shortCodeLines = 2
  /// And how many characters, so two very long lines are still summarised.
  public static let shortCodeCharacters = 80
  /// How much of a text is sampled to guess its language.
  public static let languageSampleCharacters = 600

  /// What a speech engine should be handed for `markdown`.
  ///
  /// - Parameter codeBlock: the sentence for a block that is summarised, from its line count
  ///   (`Strings.Chat.Voice.codeBlock`); the caller owns the language.
  public static func text(_ markdown: String, codeBlock: (Int) -> String) -> String {
    guard !markdown.isEmpty else {
      return ""
    }

    let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var out: [String] = []
    var at = 0

    while at < lines.count {
      let raw = lines[at]

      if Patterns.rule.test(raw) {
        at += 1
        continue
      }

      // A fenced listing: collect to the closing fence, or to the end of what has arrived, and
      // describe it rather than recite it.
      if Patterns.fence.test(raw) {
        var body: [String] = []
        at += 1

        while at < lines.count, !Patterns.fence.test(lines[at]) {
          body.append(lines[at])
          at += 1
        }

        // Past the closing fence when there was one; an unclosed block already ran off the end.
        at += 1

        let content = body.joined(separator: "\n").jsTrimmed
        let count = body.filter { $0.hasNonSpace }.count

        if !content.isEmpty, count <= shortCodeLines, content.jsLength <= shortCodeCharacters {
          out.append(stopped(content))
        } else if count > 0 {
          out.append(stopped(codeBlock(count)))
        }

        continue
      }

      // Display mathematics, one-line and fenced: the one block whose source is the content.
      if let math = Patterns.mathOneLine.firstMatch(raw) {
        out.append(stopped((math[1] ?? "").jsTrimmed))
        at += 1
        continue
      }

      if Patterns.mathFence.test(raw) {
        var body: [String] = []
        at += 1

        while at < lines.count, !Patterns.mathFence.test(lines[at]) {
          body.append(lines[at])
          at += 1
        }

        at += 1

        let source = Patterns.spaceRun.replace(body.joined(separator: " "), with: " ").jsTrimmed

        if !source.isEmpty {
          out.append(stopped(source))
        }

        continue
      }

      // A table: every row that follows, the delimiter dropped, each row ended so the engine pauses.
      if Patterns.tableRow.test(raw) {
        while at < lines.count, Patterns.tableRow.test(lines[at]) {
          let row = lines[at]
          at += 1

          if Patterns.tableDelimiter.test(row) {
            continue
          }

          let joined = cells(row).joined(separator: ", ")

          if !joined.isEmpty {
            out.append(stopped(joined))
          }
        }

        continue
      }

      at += 1

      let words = inline(raw)

      if words.hasNonSpace {
        out.append(stopped(words))
      }
    }

    return Patterns.newlineRun.replace(out.joined(separator: "\n"), with: "\n").jsTrimmed
  }

  // MARK: Language

  /// The function words of the seven languages the apps' copy is written in or near.
  private static let markers: [(code: String, words: [String])] = [
    ("en", ["the", "and", "that", "with", "this", "from", "you", "have", "which", "would"]),
    ("nl", ["de", "het", "een", "niet", "dat", "van", "voor", "maar", "zijn", "wordt"]),
    ("de", ["der", "die", "das", "und", "nicht", "mit", "ist", "auch", "werden", "einen"]),
    ("fr", ["les", "des", "une", "est", "pas", "pour", "dans", "que", "vous", "avec"]),
    ("es", ["los", "las", "una", "que", "por", "para", "con", "como", "pero", "este"]),
    ("it", ["che", "per", "con", "una", "del", "nel", "sono", "come", "questo", "alla"]),
    ("pt", ["que", "não", "uma", "para", "com", "como", "mas", "dos", "este", "você"])
  ]

  /**
   Which language a text is probably in, or nil.

   A cheap heuristic: how many of each language's most common function words show up in the first
   few hundred characters. It exists because a Dutch reply read by an English voice is unpleasant in a
   way a wrong region never is, and the alternative is a model for a question whose fallback (the
   device's own voice) is right most of the time. It answers nil far more readily than it guesses: two
   hits are the floor, and the winner has to be clear of the runner-up.
   */
  public static func guessLanguage(_ text: String) -> String? {
    let sample = String(text.prefix(languageSampleCharacters)).lowercased()
    let words = sample.split { !$0.isLetter }.map(String.init)

    guard words.count >= 4 else {
      return nil
    }

    let seen = Set(words)
    let scores = markers
      .map { (code: $0.code, score: $0.words.filter { seen.contains($0) }.count) }
      .sorted { $0.score > $1.score }

    guard let best = scores.first, best.score >= 2, best.score > (scores.dropFirst().first?.score ?? 0) else {
      return nil
    }

    return best.code
  }

  // MARK: Pieces

  /// A full stop on a line that ends without one, so the engine pauses.
  private static func stopped(_ line: String) -> String {
    let text = line.jsTrimmed

    guard !text.isEmpty else {
      return ""
    }

    return Patterns.endsStopped.test(text) ? text : text + "."
  }

  /// The private-use character a masked span is parked under: nothing in the inline pass matches it.
  private static let mask = "\u{E000}"

  /// One line's inline markup removed, with any mathematics left exactly as it was.
  private static func inline(_ line: String) -> String {
    var spans: [String] = []
    let masked = Patterns.inlineMath.replace(line) { match, _ in
      spans.append((match[1] ?? "").jsTrimmed)
      return "\(mask)\(spans.count - 1)\(mask)"
    }

    let stripped = MarkdownPlainText.block(masked)

    guard !spans.isEmpty else {
      return stripped
    }

    return Patterns.maskedSpan.replace(stripped) { match, _ in
      Int(match[1] ?? "").flatMap { spans.indices.contains($0) ? spans[$0] : nil } ?? ""
    }
  }

  /// A table row's cells, in order, the outer rails taken off.
  private static func cells(_ row: String) -> [String] {
    var text = row.jsTrimmed

    if text.hasPrefix("|") { text.removeFirst() }
    if text.hasSuffix("|") { text.removeLast() }

    return text.split(separator: "|", omittingEmptySubsequences: false)
      .map { inline(String($0)).jsTrimmed }
      .filter { !$0.isEmpty }
  }

  private enum Patterns {
    static let fence = JSRegex(#"^\s{0,3}(?:`{3,}|~{3,})"#)
    static let mathFence = JSRegex(#"^\s*\$\$\s*\z"#)
    static let mathOneLine = JSRegex(#"^\s*\$\$(.+)\$\$\s*\z"#)
    static let tableRow = JSRegex(#"^\s*\|.*\|\s*\z"#)
    static let tableDelimiter = JSRegex(#"^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*\z"#)
    static let rule = JSRegex(#"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*\z"#)
    static let inlineMath = JSRegex(#"\$([^$\n]+)\$"#)
    static let maskedSpan = JSRegex("\u{E000}(\\d+)\u{E000}")
    static let endsStopped = JSRegex(#"[.!?:;,]\z"#)
    static let spaceRun = JSRegex(#"\s+"#)
    static let newlineRun = JSRegex(#"\n{2,}"#)
  }
}
