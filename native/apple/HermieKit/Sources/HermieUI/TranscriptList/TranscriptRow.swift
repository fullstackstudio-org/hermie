import HermieMarkdown
import HermieTranscript

/// One row of the transcript list: a visible item, or a run of bot-to-bot
/// messages rolled up into one line.
///
/// Built off the main actor by `TranscriptRowBuilder`, together with the
/// Markdown each row draws, so the main actor only swaps the array in.
///
/// Equality is O(1), on a stamp taken when the row is made: the item's id and
/// `version`, its presentation, and whether the selectors took its thought
/// away. It has to be: SwiftUI compares the whole array every time the list's
/// inputs change, so a deep comparison here ran over every row of the
/// transcript on every streamed delta (5.7 s of a 7.4 s main-thread profile in
/// the spike). It relies on the engine's contract that every mutation of an
/// item bumps its `version` (`ItemBase.version`); the only other things that
/// change what a row draws are the selectors' presentation and thought
/// stripping, and both are in the stamp.
public struct TranscriptRow: Identifiable, Equatable, Sendable {
  public enum Content: Equatable, Sendable {
    case item(VisibleItem)
    /// More than `TranscriptRowBuilder.rollupThreshold` bot-to-bot rows in a
    /// row (`dm-rollup.ts`), drawn as one line that opens in place.
    case botDmRollup([VisibleItem])
  }

  /// What equality compares. See the type's notes.
  struct Stamp: Equatable, Sendable {
    var version: Int
    var presentation: Presentation
    var thought: Bool
    /// The members' versions and presentations, for a roll-up.
    var members: [Int]

    init(_ content: Content) {
      switch content {
      case .item(let visible):
        version = visible.item.version
        presentation = visible.presentation
        thought = visible.item.asAssistant?.reasoning != nil
        members = []
      case .botDmRollup(let rows):
        version = rows.count
        presentation = .collapsed
        thought = false
        members = rows.flatMap { [$0.item.version, Presentation.allCases.firstIndex(of: $0.presentation) ?? 0] }
      }
    }
  }

  public let id: String
  public let content: Content
  /// The parsed Markdown of the row's main text (an assistant reply, a user
  /// turn, a cron report), when the builder parsed it. A view without one
  /// parses the text itself.
  public var markdown: MarkdownDocument?
  /// This user turn opens a run by its author: show the name and avatar. Only
  /// meaningful in a shared chat.
  public var opensAuthorRun: Bool
  let stamp: Stamp

  public init(id: String, content: Content, markdown: MarkdownDocument? = nil, opensAuthorRun: Bool = true) {
    self.id = id
    self.content = content
    self.markdown = markdown
    self.opensAuthorRun = opensAuthorRun
    self.stamp = Stamp(content)
  }

  public init(_ visible: VisibleItem, markdown: MarkdownDocument? = nil) {
    self.init(id: visible.item.id, content: .item(visible), markdown: markdown)
  }

  /// Equal when they draw the same thing, decided on the stamp; the document
  /// is a function of the item's text, so it is left out too.
  public static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
    lhs.stamp == rhs.stamp && lhs.opensAuthorRun == rhs.opensAuthorRun && lhs.id == rhs.id
  }

  /// The single item, when this row is one.
  public var visibleItem: VisibleItem? {
    if case .item(let visible) = content { visible } else { nil }
  }
}

/// Turns `visibleItems` into rows, keeping each row's Markdown parsed across
/// calls.
///
/// A value type meant to live wherever snapshots are made (the transcript
/// store, off the main actor): call `rows(for:)` with every new list of
/// visible items. An item whose `version` did not change keeps its document;
/// one that changed is updated incrementally (`MarkdownDocument.update(text:)`),
/// so a streaming reply re-parses only its tail.
public struct TranscriptRowBuilder: Sendable {
  /// A run of more bot-to-bot rows than this rolls up (`ROLLUP_THRESHOLD`).
  public static let rollupThreshold = 3

  private struct Parsed: Sendable {
    var version: Int
    var document: MarkdownDocument
  }

  private var parsed: [String: Parsed] = [:]
  /// Whether user turns from different people are told apart.
  public var sharedChat: Bool

  public init(sharedChat: Bool = false) {
    self.sharedChat = sharedChat
  }

  /// Documents parsed so far, for tests and the lab's memory readout.
  public var documentCount: Int { parsed.count }

  public mutating func rows(for visible: [VisibleItem]) -> [TranscriptRow] {
    var next: [String: Parsed] = [:]
    next.reserveCapacity(parsed.count + 8)
    var rows: [TranscriptRow] = []
    rows.reserveCapacity(visible.count)

    var run: [VisibleItem] = []
    var lastAuthor: String??

    func flushRun() {
      if run.count > Self.rollupThreshold {
        rows.append(TranscriptRow(id: "rollup:\(run[0].item.id)", content: .botDmRollup(run)))
      } else {
        for member in run {
          rows.append(TranscriptRow(member))
        }
      }
      run.removeAll(keepingCapacity: true)
    }

    for entry in visible {
      switch entry.item {
      case .botDmIn, .botDmOut:
        run.append(entry)
        lastAuthor = nil
        continue
      default:
        // A hidden placeholder draws nothing, so it does not break a run.
        if entry.presentation == .hiddenPlaceholder && !run.isEmpty {
          continue
        }
        if !run.isEmpty { flushRun() }
      }

      var row = TranscriptRow(entry)
      if let text = Self.markdownSource(entry.item) {
        let id = entry.item.id
        let version = entry.item.version
        var document: MarkdownDocument
        if let cached = parsed[id] {
          document = cached.document
          if cached.version != version {
            document.update(text: text)
          }
        } else {
          document = MarkdownDocument(text)
        }
        next[id] = Parsed(version: version, document: document)
        row.markdown = document
      }
      if case .user(let user) = entry.item {
        let author: String? = user.author?.id
        row.opensAuthorRun = lastAuthor.map { $0 != author } ?? true
        lastAuthor = .some(author)
      } else if entry.presentation != .hiddenPlaceholder {
        lastAuthor = nil
      }
      rows.append(row)
    }
    if !run.isEmpty { flushRun() }

    parsed = next
    return rows
  }

  /// The text a row draws as Markdown, if it draws one.
  static func markdownSource(_ item: TranscriptItem) -> String? {
    switch item {
    case .assistant(let assistant): assistant.text
    case .user(let user): user.text
    case .cronDelivery(let cron): cron.body
    default: nil
    }
  }
}
