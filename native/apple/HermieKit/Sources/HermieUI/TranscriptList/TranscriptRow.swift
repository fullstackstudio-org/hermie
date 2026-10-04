import Foundation
import HermieMarkdown
import HermieTranscript

/// One row of the transcript list: a visible item, a run of bot-to-bot
/// messages rolled up into one line, or a run of tool calls gathered into one
/// group.
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
/// stripping, and both are in the stamp, and where the row sits among its
/// neighbours (its bubble's group, the author run), which is compared too.
public struct TranscriptRow: Identifiable, Equatable, Sendable {
  public enum Content: Equatable, Sendable {
    case item(VisibleItem)
    /// More than `TranscriptRowBuilder.rollupThreshold` bot-to-bot rows in a
    /// row (`dm-rollup.ts`), drawn as one line that opens in place.
    case botDmRollup([VisibleItem])
    /// The tool calls between two messages, drawn as one compact group ("5
    /// steps") that opens to the list of them. A single call is a group of one.
    case toolGroup([VisibleItem])
    /// The bot is working and has nothing on screen yet: its three dots, as the last row, where the
    /// reply will appear. Not an item of the transcript; the feed adds it and takes it away
    /// (`TypingIndicatorGate`).
    case typingIndicator
  }

  /// The one typing row's id: stable, so the row is inserted and removed, never replaced.
  public static let typingIndicatorID = "typing-indicator"

  /// What equality compares. See the type's notes.
  struct Stamp: Equatable, Sendable {
    var version: Int
    var presentation: Presentation
    var thought: Bool
    /// The members' versions and presentations, for a roll-up or a group.
    var members: [Int]

    init(_ content: Content) {
      switch content {
      case .item(let visible):
        version = visible.item.version
        presentation = visible.presentation
        thought = visible.item.asAssistant?.reasoning != nil
        members = []
      case .botDmRollup(let rows), .toolGroup(let rows):
        version = rows.count
        presentation = .collapsed
        thought = false
        members = rows.flatMap { [$0.item.version, Presentation.allCases.firstIndex(of: $0.presentation) ?? 0] }
      case .typingIndicator:
        version = 0
        presentation = .full
        thought = false
        members = []
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
  /// Where the row's bubble sits in its group, for a message drawn as one
  /// (a person's turn, the bot's reply); `nil` for every other row.
  public var bubble: BubbleLayout?
  let stamp: Stamp

  public init(
    id: String, content: Content, markdown: MarkdownDocument? = nil, opensAuthorRun: Bool = true,
    bubble: BubbleLayout? = nil
  ) {
    self.id = id
    self.content = content
    self.markdown = markdown
    self.opensAuthorRun = opensAuthorRun
    self.bubble = bubble
    self.stamp = Stamp(content)
  }

  public init(_ visible: VisibleItem, markdown: MarkdownDocument? = nil) {
    self.init(id: visible.item.id, content: .item(visible), markdown: markdown)
  }

  /// Equal when they draw the same thing, decided on the stamp; the document
  /// is a function of the item's text, so it is left out too.
  public static func == (lhs: TranscriptRow, rhs: TranscriptRow) -> Bool {
    lhs.stamp == rhs.stamp && lhs.opensAuthorRun == rhs.opensAuthorRun && lhs.bubble == rhs.bubble
      && lhs.id == rhs.id
  }

  /// The single item, when this row is one.
  public var visibleItem: VisibleItem? {
    if case .item(let visible) = content { visible } else { nil }
  }

  /// This is the typing row, not one of the transcript's own.
  public var isTypingIndicator: Bool {
    if case .typingIndicator = content { true } else { false }
  }
}

/// Where a message's bubble sits among its neighbours, as Messages groups
/// them: consecutive messages from the same sender form a group, only the last
/// bubble of a group has the tail and the time under it, and a line with the
/// date and time goes above the first message and above one that follows a
/// long pause.
public struct BubbleLayout: Equatable, Sendable {
  /// Who said it, for the grouping: the owner (or a person in a shared chat,
  /// by author id), or the bot. A turn an agent sent on a person's behalf (`viaClient`, the agent's
  /// name) is a sender of its own: it never joins the person's own bubbles, so the line that names
  /// the agent stays under it.
  public enum Sender: Equatable, Sendable {
    case person(authorID: String?, viaClient: String? = nil)
    case bot
  }

  public var sender: Sender
  /// The first bubble of its group: the space above it is a group's.
  public var opensGroup: Bool
  /// The last bubble of its group: it carries the tail and the time.
  public var closesGroup: Bool
  /// Unix seconds, when a date-and-time line goes above this bubble.
  public var timeHeader: Double?

  public init(sender: Sender, opensGroup: Bool, closesGroup: Bool, timeHeader: Double? = nil) {
    self.sender = sender
    self.opensGroup = opensGroup
    self.closesGroup = closesGroup
    self.timeHeader = timeHeader
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
  /// The typing row, to go after `rows`: the bot's bubble, in a group of its own (the bubble above
  /// it, if it is the bot's, has closed its group with a tail and a time of its own).
  public static func typingIndicatorRow() -> TranscriptRow {
    TranscriptRow(
      id: TranscriptRow.typingIndicatorID, content: .typingIndicator,
      bubble: BubbleLayout(sender: .bot, opensGroup: true, closesGroup: true))
  }

  /// A pause between two messages this long (seconds) starts a new group and
  /// puts the date and time above the next one, as Messages does.
  public static let timeHeaderGap: Double = 60 * 60

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

  /// - Parameter historyComplete: the oldest of these rows is the chat's first: no earlier page
  ///   can be loaded. Only then does the first message get the date line above it, so a page of
  ///   history arriving later does not take that line away and move the reader's rows by its height.
  public mutating func rows(for visible: [VisibleItem], historyComplete: Bool = true) -> [TranscriptRow] {
    var next: [String: Parsed] = [:]
    next.reserveCapacity(parsed.count + 8)
    var rows: [TranscriptRow] = []
    rows.reserveCapacity(visible.count)

    var run: [VisibleItem] = []
    var tools: [VisibleItem] = []
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

    func flushTools() {
      guard let first = tools.first else { return }
      rows.append(TranscriptRow(id: Self.toolGroupID(first.item.id), content: .toolGroup(tools)))
      tools.removeAll(keepingCapacity: true)
    }

    for entry in visible {
      switch entry.item {
      case .botDmIn, .botDmOut:
        flushTools()
        run.append(entry)
        lastAuthor = nil
        continue
      case .tool:
        // Every call joins the run, hidden or silent ones too (the group draws only those that
        // draw something), and every other item ends it, hidden or not. What a group holds then
        // depends on the items alone, never on their presentation: when a turn ends the
        // selectors hide rows between runs, and a rule that let a hidden row join two runs merged
        // them, removing a dozen row ids above the reader at once (the lazy list then drew an
        // empty viewport).
        if !run.isEmpty { flushRun() }
        tools.append(entry)
        lastAuthor = nil
        continue
      default:
        flushTools()
        // A hidden placeholder draws nothing, so it does not break a run of bot-to-bot rows.
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
    flushTools()

    Self.layOutBubbles(&rows, historyComplete: historyComplete)
    parsed = next
    return rows
  }

  /// The id of the group a run of tool calls starting with `firstID` is: stable while the run
  /// grows, so a call joining it changes the group rather than replacing it.
  static func toolGroupID(_ firstID: String) -> String {
    "tools:\(firstID)"
  }

  /// `todo`, `todo_list` and `react_to_message` draw nothing unless they failed.
  static func drawsNothing(_ tool: ToolItem) -> Bool {
    silentToolNames.contains(tool.name) && tool.status != .error && tool.isError != true
  }

  /// Who a row's bubble is from, when it is drawn as a bubble: a person's turn, or the bot's reply
  /// with words in it. A demoted row (a chip) is not, and neither is a reply still on its way with
  /// no words: the typing row stands for it.
  static func bubbleSender(_ row: TranscriptRow) -> BubbleLayout.Sender? {
    guard let visible = row.visibleItem, visible.presentation == .full || visible.presentation == .collapsed else {
      return nil
    }
    switch visible.item {
    case .user(let user):
      return .person(authorID: user.author?.id, viaClient: user.author?.via?.client)
    case .assistant(let assistant):
      return assistant.text.contains { !$0.isWhitespace } ? .bot : nil
    default:
      return nil
    }
  }

  /// Groups the message rows as Messages does. A group is the bubbles of one sender with nothing
  /// visible between them (a tool group, a status line or a card ends it) and no pause of an hour.
  /// The date line goes above a message after a pause or on a new day, and above the chat's first
  /// message once the whole history is loaded.
  static func layOutBubbles(_ rows: inout [TranscriptRow], historyComplete: Bool = true, calendar: Calendar = .current) {
    var previous: (index: Int, sender: BubbleLayout.Sender, ts: Double?)?
    var lastMessageTS: Double?
    var seenMessage = false

    for index in rows.indices {
      guard let sender = bubbleSender(rows[index]) else {
        // A row that draws nothing (a hidden placeholder, a group of hidden calls) does not part
        // a group.
        if !drawsNothing(rows[index]) {
          previous = nil
        }
        continue
      }
      let ts = rows[index].visibleItem?.item.base.ts
      let paused = Self.paused(from: lastMessageTS, to: ts)
      let newDay = Self.newDay(from: lastMessageTS, to: ts, calendar: calendar)
      let header: Double? = ((!seenMessage && historyComplete) || paused || newDay) ? ts : nil
      var opens = true
      if let before = previous, before.sender == sender, before.index < index, !paused {
        opens = false
        rows[before.index].bubble?.closesGroup = false
      }
      rows[index].bubble = BubbleLayout(sender: sender, opensGroup: opens, closesGroup: true, timeHeader: header)
      previous = (index, sender, ts)
      if let ts { lastMessageTS = ts }
      seenMessage = true
    }
  }

  /// The row draws nothing at all.
  static func drawsNothing(_ row: TranscriptRow) -> Bool {
    switch row.content {
    case .item(let visible):
      visible.presentation == .hiddenPlaceholder
    case .botDmRollup, .typingIndicator: false
    case .toolGroup(let members): drawnTools(members).isEmpty
    }
  }

  /// The members of a tool group that draw something: not hidden by the selectors, and not a
  /// silent tool that worked.
  static func drawnTools(_ members: [VisibleItem]) -> [VisibleItem] {
    members.filter { member in
      guard case .tool(let tool) = member.item else { return false }
      return member.presentation != .hiddenPlaceholder && !drawsNothing(tool)
    }
  }

  private static func newDay(from earlier: Double?, to later: Double?, calendar: Calendar) -> Bool {
    guard let earlier, let later else { return false }
    return !calendar.isDate(Date(timeIntervalSince1970: earlier), inSameDayAs: Date(timeIntervalSince1970: later))
  }

  private static func paused(from earlier: Double?, to later: Double?) -> Bool {
    guard let earlier, let later else { return false }
    return later - earlier >= timeHeaderGap
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
