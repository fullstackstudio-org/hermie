/// A reply as blocks, kept up to date while it streams.
///
/// Every update preprocesses the whole text (cheap, and not prefix-stable:
/// a reasoning block or a table can change what came before) and cuts it into
/// slices. Slices whose source did not change keep their blocks and their
/// identity and are not parsed again; only the open tail is. Two mechanisms
/// make that hold:
///
/// 1. **Settled prefix.** All slices but the last two are kept as they are and
///    only the text after them is cut again, provided the new text still starts
///    with exactly the same source. (Two, as in the TypeScript splitter: the
///    last slice's first line may still have been arriving when it was cut.) A
///    slice with an unclosed display-math opener is never settled, because the
///    closing `$$` could arrive later and swallow what follows.
/// 2. **Source match.** A re-cut slice whose source equals a previous one takes
///    over its blocks and identity instead of being parsed; the rest are parsed
///    and inherit the identity of the slice that stood at their position, so a
///    growing tail paragraph stays the same view.
///
/// `parseCount` counts the slices handed to the parser over the document's
/// life, for tests and diagnostics.
public struct MarkdownDocument: Sendable {
  public private(set) var text: String
  public private(set) var blocks: [MarkdownBlock]
  /// How many slices the parser has been asked to parse so far.
  public private(set) var parseCount = 0

  private struct Entry: Sendable {
    var slice: MarkdownSlice
    var id: Int
    var blocks: [MarkdownBlock]
  }

  /// The slices, by identity, in order; and the ones the last update parsed.
  /// For tests: together they show that only the tail is ever parsed again.
  var sliceIDs: [Int] { entries.map(\.id) }
  private(set) var lastParsedSliceIDs: [Int] = []

  private let parser: any MarkdownParsing
  private var source = ""
  private var entries: [Entry] = []
  private var nextSliceID = 0

  public init(_ text: String = "", parser: any MarkdownParsing = FoundationMarkdownParser()) {
    self.text = ""
    self.blocks = []
    self.parser = parser
    update(text: text)
  }

  /// Appends a streamed chunk.
  public mutating func append(_ chunk: String) {
    update(text: text + chunk)
  }

  /// Replaces the text; settled blocks are reused where the source allows.
  public mutating func update(text newText: String) {
    if newText == text {
      return
    }
    text = newText
    lastParsedSliceIDs = []
    let newSource = MarkdownPreprocessor.preprocess(newText)

    var keep = max(0, entries.count - 2)
    if let unstable = entries.firstIndex(where: \.slice.unstable) {
      keep = min(keep, unstable)
    }
    var resume = keep < entries.count ? entries[keep].slice.offset : 0
    if keep == 0 || !newSource.utf16.starts(with: source.utf16.prefix(resume)) {
      keep = 0
      resume = 0
    }

    let utf16 = newSource.utf16
    let tail = newSource[utf16.index(utf16.startIndex, offsetBy: resume)...]
    let fresh = MarkdownSlicer.slices(of: tail, base: resume)

    let old = Array(entries[keep...])
    var claimed = Array(repeating: false, count: old.count)
    var built: [Entry?] = Array(repeating: nil, count: fresh.count)

    // Same source: take the old entry over whole.
    var bySource: [MarkdownSlice.Kind: [String: [Int]]] = [:]
    for (index, entry) in old.enumerated() {
      bySource[entry.slice.kind, default: [:]][entry.slice.raw, default: []].append(index)
    }
    for (index, slice) in fresh.enumerated() {
      guard var candidates = bySource[slice.kind]?[slice.raw], !candidates.isEmpty else { continue }
      let match = candidates.removeFirst()
      bySource[slice.kind]?[slice.raw] = candidates
      claimed[match] = true
      var entry = old[match]
      entry.slice = slice
      built[index] = entry
    }

    // New source: parse, inheriting the identity of the slice at that position.
    for (index, slice) in fresh.enumerated() where built[index] == nil {
      let id: Int
      if index < old.count && !claimed[index] {
        claimed[index] = true
        id = old[index].id
      } else {
        id = nextSliceID
        nextSliceID += 1
      }
      built[index] = Entry(slice: slice, id: id, blocks: parse(slice, id: id))
    }

    entries = Array(entries[..<keep]) + built.compactMap { $0 }
    source = newSource
    blocks = entries.flatMap(\.blocks)
  }

  private mutating func parse(_ slice: MarkdownSlice, id: Int) -> [MarkdownBlock] {
    switch slice.kind {
    case .math(let latex):
      return [MarkdownBlock(id: MarkdownBlockID(slice: id, path: [0]), kind: .math(latex))]
    case .markdown:
      parseCount += 1
      lastParsedSliceIDs.append(id)
      return parser.parse(slice.raw).map { $0.restamped(slice: id) }
    }
  }
}

extension MarkdownDocument: Equatable {
  public static func == (lhs: MarkdownDocument, rhs: MarkdownDocument) -> Bool {
    lhs.text == rhs.text && lhs.blocks == rhs.blocks
  }
}
