// The Markdown block model: what a reply is made of once it has been parsed,
// as plain value types that know nothing about SwiftUI.
//
// Inline content is our own small model (`MarkdownInline`, a list of runs with
// traits and an optional link) rather than an `AttributedString`, for four
// reasons:
//
// 1. It is the shape the contract fixtures compare (`contract/markdown/`), so a
//    test reads it directly instead of decoding Foundation's attribute scopes.
// 2. It carries nothing about presentation. Fonts, the tint, the code
//    background and Dynamic Type are decided by the view at render time from
//    the environment; an `AttributedString` built by the parser would have to
//    bake some of that in or leave it half done.
// 3. It is independent of the parser behind `MarkdownParsing`, so the
//    pre-approved fallback parser could produce it unchanged.
// 4. Equality is cheap and exact, which is what keeps a settled block's view
//    from updating while the tail of a reply streams.
//
// The view turns a `MarkdownInline` into an `AttributedString` (see
// `MarkdownInline+AttributedString.swift`).

/// Inline traits a run can carry. Combined freely: a bold link, struck code.
public struct MarkdownTraits: OptionSet, Sendable, Hashable {
  public let rawValue: UInt8

  public init(rawValue: UInt8) {
    self.rawValue = rawValue
  }

  public static let bold = MarkdownTraits(rawValue: 1 << 0)
  public static let italic = MarkdownTraits(rawValue: 1 << 1)
  public static let strikethrough = MarkdownTraits(rawValue: 1 << 2)
  public static let code = MarkdownTraits(rawValue: 1 << 3)
  /// A LaTeX expression; `text` is its source. Drawn as source in v1.
  public static let math = MarkdownTraits(rawValue: 1 << 4)
}

/// One stretch of inline text with the same traits and link.
public struct MarkdownRun: Sendable, Hashable {
  /// The visible text. A soft or hard line break is `"\n"`.
  public var text: String
  public var traits: MarkdownTraits
  /// The destination exactly as written (it may be relative, or a path).
  public var link: String?

  public init(_ text: String, traits: MarkdownTraits = [], link: String? = nil) {
    self.text = text
    self.traits = traits
    self.link = link
  }
}

/// A paragraph's, heading's or table cell's inline content.
public struct MarkdownInline: Sendable, Hashable {
  public var runs: [MarkdownRun]

  public init(_ runs: [MarkdownRun] = []) {
    self.runs = runs
  }

  /// The text with every trait dropped, as a reader would copy it.
  public var plainText: String {
    runs.map(\.text).joined()
  }

  public var isEmpty: Bool {
    runs.allSatisfy { $0.text.isEmpty }
  }

  /// Appends a run, merging it into the last one when traits and link agree.
  mutating func append(_ run: MarkdownRun) {
    guard !run.text.isEmpty else { return }
    if let last = runs.last, last.traits == run.traits, last.link == run.link {
      runs[runs.count - 1].text += run.text
    } else {
      runs.append(run)
    }
  }
}

/// Where a block sits: the top-level slice it was parsed from, and its path of
/// indices inside that slice (a list item's second block is `[0, 1, 1]`).
///
/// A settled slice keeps its number for the life of the document, so every
/// block parsed from it keeps its identity while the tail streams.
public struct MarkdownBlockID: Sendable, Hashable, CustomStringConvertible {
  public var slice: Int
  public var path: [Int]

  public init(slice: Int, path: [Int]) {
    self.slice = slice
    self.path = path
  }

  public var description: String {
    "\(slice):" + path.map(String.init).joined(separator: ".")
  }
}

public struct MarkdownCodeBlock: Sendable, Hashable {
  /// The first word of the fence's info string, if any.
  public var language: String?
  /// The listing, without the trailing newline.
  public var text: String

  public init(language: String?, text: String) {
    self.language = language
    self.text = text
  }
}

public struct MarkdownListItem: Sendable, Hashable {
  /// `nil` for an ordinary item; `true` / `false` for a task item.
  public var checked: Bool?
  public var blocks: [MarkdownBlock]

  public init(checked: Bool? = nil, blocks: [MarkdownBlock]) {
    self.checked = checked
    self.blocks = blocks
  }
}

public struct MarkdownList: Sendable, Hashable {
  public var ordered: Bool
  /// The first item's number; meaningful only when `ordered`.
  public var start: Int
  public var items: [MarkdownListItem]

  public init(ordered: Bool, start: Int = 1, items: [MarkdownListItem]) {
    self.ordered = ordered
    self.start = start
    self.items = items
  }
}

public enum MarkdownColumnAlignment: String, Sendable, Hashable {
  case leading = "left"
  case center
  case trailing = "right"
}

public struct MarkdownTable: Sendable, Hashable {
  /// One entry per column; `nil` where the delimiter row gave no alignment.
  public var alignments: [MarkdownColumnAlignment?]
  public var header: [MarkdownInline]
  /// Every row has exactly `header.count` cells.
  public var rows: [[MarkdownInline]]

  public init(alignments: [MarkdownColumnAlignment?], header: [MarkdownInline], rows: [[MarkdownInline]]) {
    self.alignments = alignments
    self.header = header
    self.rows = rows
  }
}

/// One block of a reply.
public struct MarkdownBlock: Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable {
    case paragraph(MarkdownInline)
    case heading(level: Int, MarkdownInline)
    case list(MarkdownList)
    case quote([MarkdownBlock])
    case table(MarkdownTable)
    case code(MarkdownCodeBlock)
    /// A `$$ … $$` or `\[ … \]` expression; the LaTeX source.
    case math(String)
    /// A `mermaid` fence; the diagram source.
    case mermaid(String)
    case rule
    /// A raw HTML block, shown as the literal characters.
    case html(String)
  }

  public var id: MarkdownBlockID
  public var kind: Kind

  public init(id: MarkdownBlockID, kind: Kind) {
    self.id = id
    self.kind = kind
  }

  /// The same block (and every block inside it) moved to another slice.
  func restamped(slice: Int) -> MarkdownBlock {
    var copy = self
    copy.id.slice = slice
    switch kind {
    case .quote(let children):
      copy.kind = .quote(children.map { $0.restamped(slice: slice) })
    case .list(var list):
      for index in list.items.indices {
        list.items[index].blocks = list.items[index].blocks.map { $0.restamped(slice: slice) }
      }
      copy.kind = .list(list)
    default:
      break
    }
    return copy
  }
}
