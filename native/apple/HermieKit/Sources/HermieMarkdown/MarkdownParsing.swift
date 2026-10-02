import Foundation

/// Turns one slice of preprocessed Markdown into blocks.
///
/// `MarkdownDocument` cuts a reply into slices (`MarkdownSlicer`) and calls
/// this once per slice whose source changed, so an implementation sees short
/// pieces and never the whole reply. Display mathematics never reaches it: the
/// slicer recognises it. The returned blocks carry slice `0` in their ids; the
/// document restamps them.
public protocol MarkdownParsing: Sendable {
  func parse(_ source: String) -> [MarkdownBlock]
}

/// The parser on Foundation's `AttributedString(markdown:)`, which reads full
/// CommonMark with the GFM tables and strikethrough, and reports block
/// structure through presentation intents.
///
/// What Foundation does not give, and how this adapter closes the gap so the
/// result matches the TypeScript reference (`contract/markdown/`):
///
/// - **Inline mathematics** (`$…$`, `\(…\)`) is masked before parsing, with the
///   rules of `math/marked-math.ts`, so `a_i` does not open emphasis; the
///   placeholders come back as runs with the `.math` trait.
/// - **A single tilde** is escaped: the TypeScript lexer strikes only `~~…~~`,
///   because the text people paste is shell (`~/dir`, `root@box:~#`).
/// - **Task items**: the `[ ]` / `[x]` marker is read off the item's text.
/// - **Column alignment**: Foundation reports a column without a colon as
///   left-aligned; the delimiter row is read from the source instead.
/// - **Empty list items and table cells**, which carry no text run and so no
///   presentation intent, are restored from the list ordinals and cell indices
///   (and an empty item gets a placeholder so it has a run at all).
/// - Code block text loses the trailing line break; a `mermaid` fence becomes a
///   `.mermaid` block.
public struct FoundationMarkdownParser: MarkdownParsing {
  public init() {}

  public func parse(_ source: String) -> [MarkdownBlock] {
    let prepared = InlineMask.prepare(source)
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .full,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    guard let attributed = try? AttributedString(markdown: prepared.text, options: options) else {
      return [MarkdownBlock(id: MarkdownBlockID(slice: 0, path: [0]), kind: .paragraph(MarkdownInline([MarkdownRun(source)])))]
    }
    let root = TreeBuilder.build(attributed)
    var converter = Converter(math: prepared.math, links: prepared.links, alignments: prepared.alignments)
    return converter.blocks(of: root.children, path: [])
  }
}

// MARK: - Masking

/// Private-use characters Foundation treats as ordinary text.
enum Placeholder {
  static let mathOpen: Character = "\u{E000}"
  static let mathClose: Character = "\u{E001}"
  /// Stands in an empty list item, so the item has a run and therefore exists.
  static let emptyItem: Character = "\u{E002}"
  /// Around the number of a link whose label Foundation would flatten.
  static let linkOpen: Character = "\u{E003}"
  static let linkClose: Character = "\u{E004}"

  static func isPlaceholder(_ char: Character) -> Bool {
    char == mathOpen || char == emptyItem || char == linkOpen
  }
}

/// A link whose label holds inline formatting, which Foundation drops inside a
/// link: the label is parsed on its own and the destination applied to it.
struct MaskedLink: Sendable {
  var label: String
  var destination: String

  /// The destination without its title, angle brackets or escapes.
  static func href(_ raw: String) -> String {
    var text = raw.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("<"), let close = text.firstIndex(of: ">") {
      text = String(text[text.index(after: text.startIndex)..<close])
    } else if let space = text.firstIndex(where: { $0 == " " || $0 == "\t" }) {
      text = String(text[..<space])
    }
    var out = ""
    var escaped = false
    for char in text {
      if !escaped && char == "\\" {
        escaped = true
        continue
      }
      out.append(char)
      escaped = false
    }
    return out
  }
}

enum InlineMask {
  struct Prepared {
    var text: String
    var math: [String]
    var links: [MaskedLink]
    /// The column alignments of each table, in source order.
    var alignments: [[MarkdownColumnAlignment?]]
  }

  static let dollarMath = JSRegex(#"\$(?![\s$])((?:[^$\n]|\n(?!\s*\n))*?[^\s$])\$(?![0-9])"#)
  static let parenMath = JSRegex(#"\\\(((?:[^\n]|\n(?!\s*\n))*?)\\\)"#)
  static let autolink = JSRegex(#"<(?:[A-Za-z][A-Za-z0-9.+-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)>"#)
  static let bareListMarker = JSRegex(#"^[ \t]*(?:[-+*]|[0-9]{1,9}[.)])[ \t]*\z"#)
  static let listMarker = JSRegex(#"^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]{1,4}|\z)"#)
  static let emptyHeading = JSRegex(#"^ {0,3}#{1,6}[ \t]*\z"#)
  static let tableDelimiter = JSRegex(#"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*\z"#)

  static func prepare(_ source: String) -> Prepared {
    var math: [String] = []
    var links: [MaskedLink] = []
    var alignments: [[MarkdownColumnAlignment?]] = []
    var out: [String] = []
    var prose: [String] = []
    var fence: (char: Character, count: Int)?
    var previousBlank = true
    var indentedCode = false
    var listOpen = false
    var itemContentIndent = 0
    var previousLine = ""

    func flushProse() {
      guard !prose.isEmpty else { return }
      out.append(mask(prose.joined(separator: "\n"), math: &math, links: &links))
      prose.removeAll()
    }

    for rawLine in source.components(separatedBy: "\n") {
      var line = rawLine
      let content = Substring(line).drop(while: { $0 == " " || $0 == "\t" || $0 == ">" })
      let indent = Substring(line).prefix(while: { $0 == " " }).count

      if let open = fence {
        flushProse()
        out.append(line)
        let run = content.prefix(while: { $0 == open.char }).count
        if run >= open.count && !content.dropFirst(run).hasNonSpaceCharacter {
          fence = nil
        }
        previousBlank = false
        continue
      }

      if !line.hasNonSpace {
        prose.append(line)
        previousBlank = true
        previousLine = line
        continue
      }

      if indent >= 4 && !listOpen && (previousBlank || indentedCode) {
        indentedCode = true
        flushProse()
        out.append(line)
        previousBlank = false
        continue
      }
      indentedCode = false

      if let first = content.first, first == "`" || first == "~" {
        let run = content.prefix(while: { $0 == first }).count
        if run >= 3 && !(first == "`" && content.dropFirst(run).contains("`")) {
          flushProse()
          out.append(line)
          fence = (first, run)
          previousBlank = false
          continue
        }
      }

      // An empty list item or heading has no text run, so Foundation gives
      // it no presentation intent and it would vanish; a placeholder keeps
      // it. A bare marker directly under an item's text, at that item's
      // content indent, is a setext underline instead, and stays as it is.
      let isMarker = MarkdownSlicerLine.isListMarker(Substring(line))
      if bareListMarker.test(line) && (previousBlank || (listOpen && indent < itemContentIndent)) {
        line += " " + String(Placeholder.emptyItem)
      } else if emptyHeading.test(line) {
        line += " " + String(Placeholder.emptyItem)
      }
      if isMarker {
        listOpen = true
        if let marker = listMarker.firstMatch(line) {
          let width = marker.range.length
          itemContentIndent = width == (line as NSString).length ? width + 1 : width
        }
      } else if indent == 0 && previousBlank {
        listOpen = false
      }

      if previousLine.contains("|"), tableDelimiter.test(String(content)), content.contains("-") {
        alignments.append(columnAlignments(String(content)))
      }

      prose.append(line)
      previousBlank = false
      previousLine = line
    }
    flushProse()
    return Prepared(text: out.joined(separator: "\n"), math: math, links: links, alignments: alignments)
  }

  static func columnAlignments(_ row: String) -> [MarkdownColumnAlignment?] {
    var cells = row.jsTrimmed
    if cells.hasPrefix("|") { cells.removeFirst() }
    if cells.hasSuffix("|") { cells.removeLast() }
    return cells.split(separator: "|", omittingEmptySubsequences: false).map { cell in
      let trimmed = cell.trimmingCharacters(in: .whitespaces)
      switch (trimmed.hasPrefix(":"), trimmed.hasSuffix(":")) {
      case (true, true): return .center
      case (false, true): return .trailing
      case (true, false): return .leading
      case (false, false): return nil
      }
    }
  }

  private static let backtick = UInt16(UInt8(ascii: "`"))
  private static let backslash = UInt16(UInt8(ascii: "\\"))
  private static let dollar = UInt16(UInt8(ascii: "$"))
  private static let tilde = UInt16(UInt8(ascii: "~"))
  private static let lessThan = UInt16(UInt8(ascii: "<"))
  private static let closeSquare = UInt16(UInt8(ascii: "]"))
  private static let openSquare = UInt16(UInt8(ascii: "["))
  private static let bang = UInt16(UInt8(ascii: "!"))
  private static let openParen = UInt16(UInt8(ascii: "("))
  private static let closeParen = UInt16(UInt8(ascii: ")"))

  private static func isASCIIPunctuation(_ unit: UInt16) -> Bool {
    (0x21...0x2F).contains(unit) || (0x3A...0x40).contains(unit) || (0x5B...0x60).contains(unit)
      || (0x7B...0x7E).contains(unit)
  }

  struct InlineLinkRange {
    var label: Range<Int>
    var destination: Range<Int>
    var end: Int
    var labelNeedsParsing: Bool
  }

  private static let formatting = Set("*_`~$".utf16)

  /// `[label](destination)` starting at `start`, with balanced brackets in the
  /// label and balanced parentheses in the destination.
  static func inlineLink(_ units: [UInt16], at start: Int) -> InlineLinkRange? {
    var depth = 0
    var cursor = start
    var labelEnd: Int?
    var needsParsing = false
    while cursor < units.count {
      let unit = units[cursor]
      if unit == backslash {
        needsParsing = true
        cursor += 2
        continue
      }
      if formatting.contains(unit) { needsParsing = true }
      if unit == openSquare {
        depth += 1
      } else if unit == closeSquare {
        depth -= 1
        if depth == 0 {
          labelEnd = cursor
          break
        }
      }
      cursor += 1
    }
    guard let labelEnd, labelEnd + 1 < units.count, units[labelEnd + 1] == openParen else { return nil }
    var parens = 0
    cursor = labelEnd + 1
    while cursor < units.count {
      let unit = units[cursor]
      if unit == 0x0A { return nil }
      if unit == backslash {
        cursor += 2
        continue
      }
      if unit == openParen {
        parens += 1
      } else if unit == closeParen {
        parens -= 1
        if parens == 0 {
          return InlineLinkRange(
            label: (start + 1)..<labelEnd, destination: (labelEnd + 2)..<cursor, end: cursor + 1,
            labelNeedsParsing: needsParsing)
        }
      }
      cursor += 1
    }
    return nil
  }

  /// One run of prose: inline maths to placeholders, a lone `~` escaped. Code
  /// spans, escapes, autolinks and link destinations are copied untouched.
  static func mask(_ text: String, math: inout [String], links: inout [MaskedLink]) -> String {
    let ns = text as NSString
    let units = Array(text.utf16)
    var out: [UInt16] = []
    out.reserveCapacity(units.count + 8)
    var index = 0

    func anchored(_ regex: JSRegex) -> NSTextCheckingResult? {
      regex.regex.firstMatch(
        in: text, options: [.anchored], range: NSRange(location: index, length: units.count - index))
    }

    func emitMath(_ result: NSTextCheckingResult) -> Bool {
      let source = ns.substring(with: result.range(at: 1))
      guard source.hasNonSpace else { return false }
      out.append(contentsOf: (String(Placeholder.mathOpen) + String(math.count) + String(Placeholder.mathClose)).utf16)
      math.append(source)
      index = result.range.location + result.range.length
      return true
    }

    while index < units.count {
      let unit = units[index]

      switch unit {
      case backtick:
        var run = 0
        while index + run < units.count && units[index + run] == backtick { run += 1 }
        var cursor = index + run
        var closing: Int?
        while cursor < units.count {
          if units[cursor] == backtick {
            var other = 0
            while cursor + other < units.count && units[cursor + other] == backtick { other += 1 }
            if other == run {
              closing = cursor + other
              break
            }
            cursor += other
          } else {
            cursor += 1
          }
        }
        let end = closing ?? index + run
        out.append(contentsOf: units[index..<end])
        index = end

      case backslash:
        if index + 1 < units.count, units[index + 1] == openParen, let result = anchored(parenMath), emitMath(result) {
          continue
        }
        if index + 1 < units.count, isASCIIPunctuation(units[index + 1]) {
          out.append(contentsOf: units[index...(index + 1)])
          index += 2
        } else {
          out.append(unit)
          index += 1
        }

      case dollar:
        // `$$` inside a line opens nothing; the second `$` may still open.
        if index + 1 < units.count, units[index + 1] == dollar {
          out.append(unit)
          index += 1
          continue
        }
        if let result = anchored(dollarMath), emitMath(result) {
          continue
        }
        out.append(unit)
        index += 1

      case lessThan:
        if let result = anchored(autolink) {
          let end = result.range.location + result.range.length
          out.append(contentsOf: units[index..<end])
          index = end
        } else {
          out.append(unit)
          index += 1
        }

      case openSquare where index == 0 || units[index - 1] != bang:
        if let link = inlineLink(units, at: index), link.labelNeedsParsing {
          let label = String(decoding: units[link.label], as: UTF16.self)
          let destination = String(decoding: units[link.destination], as: UTF16.self)
          let masked = mask(label, math: &math, links: &links)
          out.append(contentsOf: (String(Placeholder.linkOpen) + String(links.count) + String(Placeholder.linkClose)).utf16)
          links.append(MaskedLink(label: masked, destination: MaskedLink.href(destination)))
          index = link.end
        } else {
          out.append(unit)
          index += 1
        }

      case closeSquare where index + 1 < units.count && units[index + 1] == openParen:
        // A link destination: copied as written, balanced parentheses included.
        var depth = 0
        var cursor = index + 1
        while cursor < units.count {
          if units[cursor] == openParen {
            depth += 1
          } else if units[cursor] == closeParen {
            depth -= 1
            if depth == 0 {
              cursor += 1
              break
            }
          } else if units[cursor] == 0x0A || units[cursor] == 0x20 {
            break
          }
          cursor += 1
        }
        out.append(contentsOf: units[index..<cursor])
        index = cursor

      case tilde:
        var run = 0
        while index + run < units.count && units[index + run] == tilde { run += 1 }
        if run == 1 {
          out.append(backslash)
        }
        out.append(contentsOf: units[index..<(index + run)])
        index += run

      default:
        out.append(unit)
        index += 1
      }
    }

    return String(decoding: out, as: UTF16.self)
  }
}

/// The list-marker shape, shared with the slicer.
enum MarkdownSlicerLine {
  static func isListMarker(_ line: Substring) -> Bool {
    let indent = line.prefix(while: { $0 == " " }).count
    guard indent <= 3 else { return false }
    let body = line.dropFirst(indent)
    guard let first = body.first else { return false }
    var rest: Substring
    if first == "-" || first == "+" || first == "*" {
      rest = body.dropFirst()
    } else if first.isASCII && first.isNumber {
      let digits = body.prefix(while: { $0.isASCII && $0.isNumber })
      guard digits.count <= 9 else { return false }
      rest = body.dropFirst(digits.count)
      guard let delimiter = rest.first, delimiter == "." || delimiter == ")" else { return false }
      rest = rest.dropFirst()
    } else {
      return false
    }
    return rest.isEmpty || rest.first == " " || rest.first == "\t"
  }
}

// MARK: - Presentation intents to a tree

final class IntentNode {
  let kind: PresentationIntent.Kind?
  let identity: Int
  var children: [IntentNode] = []
  var runs: [MarkdownRun] = []
  /// A raw HTML block, which carries no presentation intent of its own.
  var isHTML = false

  init(kind: PresentationIntent.Kind?, identity: Int) {
    self.kind = kind
    self.identity = identity
  }
}

enum TreeBuilder {
  static func build(_ attributed: AttributedString) -> IntentNode {
    let root = IntentNode(kind: nil, identity: -1)
    var stack: [IntentNode] = []
    var openHTML: IntentNode?

    for run in attributed.runs {
      let components = Array((run.presentationIntent?.components ?? []).reversed())
      var shared = 0
      while shared < stack.count, shared < components.count, stack[shared].identity == components[shared].identity {
        shared += 1
      }
      stack.removeSubrange(shared...)
      for component in components[shared...] {
        let node = IntentNode(kind: component.kind, identity: component.identity)
        (stack.last ?? root).children.append(node)
        stack.append(node)
      }

      let text = String(attributed[run.range].characters)
      let inline = run.inlinePresentationIntent ?? []

      if inline.contains(.blockHTML) {
        let parent = stack.last ?? root
        if let open = openHTML, parent.children.last === open {
          open.runs.append(MarkdownRun(text))
        } else {
          let node = IntentNode(kind: nil, identity: -2)
          node.isHTML = true
          node.runs = [MarkdownRun(text)]
          parent.children.append(node)
          openHTML = node
        }
        continue
      }
      openHTML = nil

      guard let leaf = stack.last else { continue }
      let isBreak = inline.contains(.softBreak) || inline.contains(.lineBreak)
      leaf.runs.append(
        MarkdownRun(isBreak ? "\n" : text, traits: traits(inline), link: run.link.map(\.absoluteString)))
    }

    return root
  }

  static func traits(_ inline: InlinePresentationIntent) -> MarkdownTraits {
    var traits: MarkdownTraits = []
    if inline.contains(.stronglyEmphasized) { traits.insert(.bold) }
    if inline.contains(.emphasized) { traits.insert(.italic) }
    if inline.contains(.strikethrough) { traits.insert(.strikethrough) }
    if inline.contains(.code) { traits.insert(.code) }
    return traits
  }
}

// MARK: - Tree to blocks

struct Converter {
  let math: [String]
  let links: [MaskedLink]
  let alignments: [[MarkdownColumnAlignment?]]
  var tableIndex = 0

  init(math: [String], links: [MaskedLink], alignments: [[MarkdownColumnAlignment?]]) {
    self.math = math
    self.links = links
    self.alignments = alignments
  }

  mutating func blocks(of nodes: [IntentNode], path: [Int]) -> [MarkdownBlock] {
    var out: [MarkdownBlock] = []
    for node in nodes {
      let id = MarkdownBlockID(slice: 0, path: path + [out.count])
      if let kind = self.kind(of: node, id: id) {
        out.append(MarkdownBlock(id: id, kind: kind))
      }
    }
    return out
  }

  mutating func kind(of node: IntentNode, id: MarkdownBlockID) -> MarkdownBlock.Kind? {
    if node.isHTML {
      let text = node.runs.map(\.text).joined()
      return .html(String(text.trimmingTrailingWhitespace))
    }
    guard let kind = node.kind else { return nil }

    switch kind {
    case .paragraph:
      let inline = self.inline(node.runs)
      return inline.isEmpty ? nil : .paragraph(inline)

    case .header(let level):
      return .heading(level: level, inline(node.runs))

    case .codeBlock(let hint):
      var text = node.runs.map(\.text).joined()
      if text.hasSuffix("\n") { text.removeLast() }
      let language = hint.flatMap { $0.isEmpty ? nil : String($0.split(whereSeparator: \.isWhitespace).first ?? "") }
      if language?.lowercased() == "mermaid" {
        return .mermaid(text)
      }
      return .code(MarkdownCodeBlock(language: language, text: text))

    case .thematicBreak:
      return .rule

    case .blockQuote:
      return .quote(blocks(of: node.children, path: id.path))

    case .orderedList, .unorderedList:
      return .list(list(node, ordered: kind == .orderedList, id: id))

    case .table:
      return .table(table(node))

    default:
      // A list item, row or cell outside its container does not happen; read
      // what it holds rather than lose it.
      let children = blocks(of: node.children, path: id.path)
      return children.isEmpty ? nil : .quote(children)
    }
  }

  // MARK: Lists

  private static let taskMarker = JSRegex(#"^\[([ xX])\] +(?=\S)"#)

  mutating func list(_ node: IntentNode, ordered: Bool, id: MarkdownBlockID) -> MarkdownList {
    var items: [MarkdownListItem] = []
    var start = 1
    var previousOrdinal: Int?

    for (offset, child) in node.children.enumerated() {
      guard case .listItem(let ordinal) = child.kind else { continue }
      if offset == 0 { start = ordinal }
      // An empty item has no run and so never shows up; its ordinal does.
      if let previous = previousOrdinal, ordinal > previous + 1 {
        for _ in (previous + 1)..<ordinal {
          items.append(MarkdownListItem(blocks: []))
        }
      }
      previousOrdinal = ordinal
      let itemPath = id.path + [items.count]
      var blocks = self.blocks(of: child.children, path: itemPath)
      var checked: Bool?
      if case .paragraph(var inline) = blocks.first?.kind, let first = inline.runs.first,
        let match = Self.taskMarker.firstMatch(first.text)
      {
        checked = match[1] != " "
        let units = first.text.utf16
        inline.runs[0].text = String(decoding: units.dropFirst(match.range.length), as: UTF16.self)
        if inline.runs[0].text.isEmpty { inline.runs.removeFirst() }
        blocks[0].kind = .paragraph(inline)
      }
      items.append(MarkdownListItem(checked: checked, blocks: blocks))
    }
    return MarkdownList(ordered: ordered, start: start, items: items)
  }

  // MARK: Tables

  mutating func table(_ node: IntentNode) -> MarkdownTable {
    guard case .table(let columns) = node.kind else {
      return MarkdownTable(alignments: [], header: [], rows: [])
    }
    let count = columns.count
    var source: [MarkdownColumnAlignment?]? = tableIndex < alignments.count ? alignments[tableIndex] : nil
    tableIndex += 1
    if source?.count != count { source = nil }
    let aligned: [MarkdownColumnAlignment?] =
      source
      ?? columns.map { column -> MarkdownColumnAlignment? in
        switch column.alignment {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
      }

    var header = Array(repeating: MarkdownInline(), count: count)
    var rows: [[MarkdownInline]] = []

    for row in node.children {
      var cells = Array(repeating: MarkdownInline(), count: count)
      for cell in row.children {
        guard case .tableCell(let column) = cell.kind, column < count else { continue }
        cells[column] = inline(cell.runs)
      }
      switch row.kind {
      case .tableHeaderRow:
        header = cells
      case .tableRow(let index):
        while rows.count < index - 1 {
          rows.append(Array(repeating: MarkdownInline(), count: count))
        }
        rows.append(cells)
      default:
        break
      }
    }
    return MarkdownTable(alignments: aligned, header: header, rows: rows)
  }

  // MARK: Inline

  func inline(_ runs: [MarkdownRun]) -> MarkdownInline {
    var out = MarkdownInline()
    for run in runs {
      guard run.text.contains(where: Placeholder.isPlaceholder) else {
        out.append(run)
        continue
      }
      var plain = ""
      var cursor = run.text.startIndex
      func flush() {
        out.append(MarkdownRun(plain, traits: run.traits, link: run.link))
        plain = ""
      }
      while cursor < run.text.endIndex {
        let char = run.text[cursor]
        let closer = char == Placeholder.mathOpen ? Placeholder.mathClose : Placeholder.linkClose
        if char == Placeholder.mathOpen || char == Placeholder.linkOpen,
          let close = run.text[cursor...].firstIndex(of: closer),
          let number = Int(run.text[run.text.index(after: cursor)..<close])
        {
          if char == Placeholder.mathOpen, number < math.count {
            flush()
            out.append(MarkdownRun(math[number], traits: run.traits.union(.math), link: run.link))
            cursor = run.text.index(after: close)
            continue
          }
          if char == Placeholder.linkOpen, number < links.count {
            flush()
            let link = links[number]
            for labelRun in linkLabel(link).runs {
              out.append(
                MarkdownRun(
                  labelRun.text, traits: labelRun.traits.union(run.traits), link: labelRun.link ?? link.destination))
            }
            cursor = run.text.index(after: close)
            continue
          }
        }
        if char != Placeholder.emptyItem {
          plain.append(char)
        }
        cursor = run.text.index(after: cursor)
      }
      flush()
    }
    // An empty item's placeholder leaves at most the space before it.
    if out.runs.allSatisfy({ !$0.text.hasNonSpace }) {
      return MarkdownInline()
    }
    return out
  }

  /// A masked link's label, parsed on its own.
  private func linkLabel(_ link: MaskedLink) -> MarkdownInline {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    guard let attributed = try? AttributedString(markdown: link.label, options: options) else {
      return MarkdownInline([MarkdownRun(link.label)])
    }
    let runs = attributed.runs.map { run in
      MarkdownRun(String(attributed[run.range].characters), traits: TreeBuilder.traits(run.inlinePresentationIntent ?? []))
    }
    return inline(runs)
  }

}

extension StringProtocol {
  var trimmingTrailingWhitespace: SubSequence {
    var end = endIndex
    while end > startIndex {
      let previous = index(before: end)
      guard self[previous].isWhitespace else { break }
      end = previous
    }
    return self[startIndex..<end]
  }
}
