import Foundation

/// One top-level piece of a (preprocessed) reply, cut where the blocks before
/// it can no longer change the blocks after it.
///
/// The slicer is deliberately conservative: it cuts only where a cut is
/// certain (a blank line before an unindented line that cannot continue the
/// previous block, an unindented fence, an ATX heading, a display-math block),
/// and a slice may hold several blocks. A missed cut costs re-parsing a little
/// more of the tail while a reply streams; a wrong cut would change what the
/// reply says. The parser behind `MarkdownParsing` turns each slice into blocks.
struct MarkdownSlice: Sendable, Hashable {
  enum Kind: Sendable, Hashable {
    case markdown
    /// A display expression the slicer recognised; the LaTeX between the delimiters.
    case math(String)
  }

  /// The slice's source, from its first to its last non-blank line.
  var raw: String
  var kind: Kind
  /// Where `raw` starts in the text that was sliced, in UTF-16 code units.
  var offset: Int
  /// Whether text appended later could change this slice or the cut after it:
  /// it holds a display-math opener that has not closed yet.
  var unstable: Bool
}

enum MarkdownSlicer {
  // The two display-math tokenizers of `math/marked-math.ts`. `\d` would be
  // Unicode-wide in ICU; none is needed here.
  static let dollarBlock = JSRegex(#"^ {0,3}\$\$([^$][\s\S]*?)\$\$[ \t]*(?:\n+|\z)"#)
  static let bracketBlock = JSRegex(#"^ {0,3}\\\[([\s\S]*?)\\\][ \t]*(?:\n+|\z)"#)

  /// The display expression starting exactly at the start of `text`, if one does.
  static func mathBlock(at text: Substring) -> (length: Int, source: String)? {
    let string = String(text)
    for regex in [dollarBlock, bracketBlock] {
      if let match = regex.firstMatch(string), match.range.location == 0, let source = match[1], source.hasNonSpace {
        return (match.range.length, source)
      }
    }
    return nil
  }

  /// Slices `text`, reporting offsets relative to `base`.
  static func slices(of text: Substring, base: Int = 0) -> [MarkdownSlice] {
    var scanner = Scanner(text: text, base: base)
    return scanner.run()
  }

  private struct Fence {
    var char: Character
    var count: Int
    var topLevel = false
  }

  private struct Line {
    var text: Substring
    /// UTF-16 offset of the line's start within the sliced text.
    var offset: Int
  }

  private struct Scanner {
    let text: Substring
    let base: Int
    var lines: [Line] = []

    init(text: Substring, base: Int) {
      self.text = text
      self.base = base
      var offset = 0
      for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        lines.append(Line(text: line, offset: offset))
        offset += line.utf16.count + 1
      }
    }

    var out: [MarkdownSlice] = []
    /// First and last content line of the open slice.
    var first: Int?
    var last = 0
    var unstable = false

    mutating func close() {
      guard let first else { return }
      let start = lines[first].offset
      let end = lines[last].offset + lines[last].text.utf16.count
      let raw = utf16Slice(start, end)
      out.append(MarkdownSlice(raw: raw, kind: .markdown, offset: base + start, unstable: unstable))
      self.first = nil
      unstable = false
    }

    func utf16Slice(_ start: Int, _ end: Int) -> String {
      let utf16 = text.utf16
      let from = utf16.index(utf16.startIndex, offsetBy: start)
      let to = utf16.index(from, offsetBy: end - start)
      return String(text[from..<to])
    }

    mutating func run() -> [MarkdownSlice] {
      var fence: Fence?
      var htmlEnd: HTMLZone?
      var openIsList = false
      var previousBlank = true
      var index = 0

      while index < lines.count {
        let line = lines[index].text

        if let open = fence {
          include(index)
          if Self.closesFence(line, open) {
            fence = nil
            // A fence opened without indentation sits at top level: nothing
            // after it can continue it.
            if open.topLevel {
              close()
            }
          }
          previousBlank = false
          index += 1
          continue
        }

        if let zone = htmlEnd {
          include(index)
          if zone.closes(line) {
            htmlEnd = nil
          }
          previousBlank = false
          index += 1
          continue
        }

        if !line.hasNonSpaceCharacter {
          previousBlank = true
          index += 1
          continue
        }

        let indent = Self.indent(of: line)
        let isListMarker = indent <= 3 && Self.isListMarker(line)
        var opensMathLater = false

        // Display mathematics, which the parser cannot see: tried wherever
        // marked tries its block tokenizer and clips a paragraph for it.
        if indent <= 3, Self.mayOpenMath(line), !(openIsList && !previousBlank) {
          let rest = text[text.utf16.index(text.utf16.startIndex, offsetBy: lines[index].offset)...]
          if let math = MarkdownSlicer.mathBlock(at: rest) {
            close()
            // The match ends at the end of the text or just after a line break,
            // so the next line to scan is the first one starting at or after it.
            let start = lines[index].offset
            let end = start + math.length
            let raw = utf16Slice(start, end).trimmingTrailingBlankLines
            out.append(MarkdownSlice(raw: raw, kind: .math(math.source), offset: base + start, unstable: false))
            while index < lines.count && lines[index].offset < end {
              index += 1
            }
            openIsList = false
            previousBlank = true
            continue
          }
          // An opener that has not closed yet may close later and swallow
          // everything after it, so nothing from here on is settled.
          opensMathLater = true
        }

        let fenceOpen = indent <= 3 ? Self.fenceOpener(in: line) : nil
        let heading = indent == 0 && Self.isATXHeading(line)

        let cut: Bool
        if first == nil {
          cut = false
        } else if indent == 0 && (fenceOpen != nil || heading) {
          cut = true
        } else if previousBlank && indent == 0 && !(openIsList && isListMarker) {
          cut = true
        } else {
          cut = false
        }

        if cut {
          close()
        }
        if first == nil {
          openIsList = false
        }
        include(index)
        if opensMathLater {
          unstable = true
        }

        if isListMarker {
          openIsList = true
        } else if indent == 0 && previousBlank {
          openIsList = false
        }

        if let fenceOpen {
          fence = Fence(char: fenceOpen.char, count: fenceOpen.count, topLevel: indent == 0)
        } else if indent <= 3, let zone = HTMLZone.opening(line) {
          if !zone.closes(line, sameLineAsOpener: true) {
            htmlEnd = zone
          }
        }

        previousBlank = false
        index += 1

        if heading {
          close()
        }
      }

      close()
      return out
    }

    mutating func include(_ index: Int) {
      if first == nil {
        first = index
      }
      last = index
    }

    // MARK: Line shapes

    static func indent(of line: Substring) -> Int {
      var width = 0
      for char in line {
        if char == " " {
          width += 1
        } else if char == "\t" {
          width += 4 - width % 4
        } else {
          break
        }
      }
      return width
    }

    static func fenceOpener(in line: Substring) -> Fence? {
      let body = line.drop(while: { $0 == " " || $0 == "\t" })
      guard let char = body.first, char == "`" || char == "~" else { return nil }
      let count = body.prefix(while: { $0 == char }).count
      guard count >= 3 else { return nil }
      // A backtick fence's info string may not contain a backtick.
      if char == "`" && body.dropFirst(count).contains("`") {
        return nil
      }
      return Fence(char: char, count: count)
    }

    static func closesFence(_ line: Substring, _ open: Fence) -> Bool {
      guard indent(of: line) <= 3 else { return false }
      let body = line.drop(while: { $0 == " " || $0 == "\t" })
      let count = body.prefix(while: { $0 == open.char }).count
      return count >= open.count && !body.dropFirst(count).hasNonSpaceCharacter
    }

    static func isATXHeading(_ line: Substring) -> Bool {
      let hashes = line.prefix(while: { $0 == "#" }).count
      guard (1...6).contains(hashes) else { return false }
      let rest = line.dropFirst(hashes)
      return rest.isEmpty || rest.first == " " || rest.first == "\t"
    }

    static func isListMarker(_ line: Substring) -> Bool {
      MarkdownSlicerLine.isListMarker(line)
    }

    static func mayOpenMath(_ line: Substring) -> Bool {
      let body = line.drop(while: { $0 == " " })
      return body.hasPrefix("$$") || body.hasPrefix("\\[")
    }
  }

  /// The HTML blocks CommonMark lets run across blank lines (kinds 1 to 5).
  struct HTMLZone {
    let end: String

    static func opening(_ line: Substring) -> HTMLZone? {
      let body = line.drop(while: { $0 == " " }).lowercased()
      for tag in ["script", "pre", "style", "textarea"] where body.hasPrefix("<" + tag) {
        let after = body.dropFirst(tag.count + 1)
        if after.isEmpty || after.first == ">" || after.first == " " || after.first == "\t" {
          return HTMLZone(end: "</" + tag + ">")
        }
      }
      if body.hasPrefix("<!--") { return HTMLZone(end: "-->") }
      if body.hasPrefix("<?") { return HTMLZone(end: "?>") }
      if body.hasPrefix("<![cdata[") { return HTMLZone(end: "]]>") }
      if body.hasPrefix("<!"), let next = body.dropFirst(2).first, next.isLetter { return HTMLZone(end: ">") }
      return nil
    }

    func closes(_ line: Substring, sameLineAsOpener: Bool = false) -> Bool {
      let lower = line.lowercased()
      guard sameLineAsOpener else { return lower.contains(end) }
      // On the opening line the end marker must come after the opener itself.
      let body = lower.drop(while: { $0 == " " })
      return body.dropFirst(2).contains(end)
    }
  }
}

extension Substring {
  var hasNonSpaceCharacter: Bool {
    contains { !$0.isWhitespace }
  }
}

extension StringProtocol {
  var trimmingTrailingBlankLines: String {
    var lines = self.split(separator: "\n", omittingEmptySubsequences: false)
    while let last = lines.last, !last.contains(where: { !$0.isWhitespace }) {
      lines.removeLast()
    }
    return lines.joined(separator: "\n")
  }
}
