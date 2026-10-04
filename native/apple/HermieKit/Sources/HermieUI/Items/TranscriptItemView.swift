import HermieMarkdown
import HermieTranscript
import SwiftUI

/// One transcript row, whatever it holds: the view `TranscriptList` builds
/// for each `TranscriptRow`.
///
/// `Equatable` on its row, so SwiftUI skips a row whose item did not change.
/// The actions and the disclosure memory come from the environment
/// (`transcriptItemActions`, `transcriptExpansion`), which the chat screen sets
/// once per chat.
public struct TranscriptItemView: View, Equatable {
  public let row: TranscriptRow
  let gaps: Gaps

  /// The room above a row, by what the row is. The chat has the rows carry it themselves (and its
  /// list no spacing of its own), because a row that draws nothing must take no room at all, which
  /// a spacing between rows cannot give it.
  struct Gaps: Equatable, Sendable {
    /// Above a bubble that continues its group.
    var within: CGFloat
    /// Above a row that opens a group, and above every row that is not a bubble.
    var between: CGFloat

    /// The labs', which keep their list's own spacing.
    static let lab = Gaps(within: 0, between: 8)
    /// The chat's (`ChatSpacing`).
    static let chat = Gaps(within: ChatSpacing.withinGroup, between: ChatSpacing.betweenGroups)
  }

  public init(row: TranscriptRow) {
    self.init(row: row, gaps: .lab)
  }

  init(row: TranscriptRow, gaps: Gaps) {
    self.row = row
    self.gaps = gaps
  }

  public nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row && lhs.gaps == rhs.gaps
  }

  public var body: some View {
    #if DEBUG
      let _ = RenderCounter.tick(row.id)
    #endif
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      // Bubbles of one group sit close; a new group, and every other row, gets room above it.
      .padding(.top, Self.gap(above: row, gaps: gaps))
      .accessibilityIdentifier("row.\(row.id)")
      #if DEBUG
        .onAppear { RenderCounter.appeared(row.id) }
      #endif
  }

  /// The room above a row: none for a row that draws nothing (a hidden placeholder, quiet's
  /// stand-in for the running tool), the small gap inside a group of bubbles, the large one
  /// otherwise.
  nonisolated static func gap(above row: TranscriptRow, gaps: Gaps = .lab) -> CGFloat {
    if TranscriptRowBuilder.drawsNothing(row) { return 0 }
    return row.bubble.map { $0.opensGroup ? gaps.between : gaps.within } ?? gaps.between
  }

  @ViewBuilder private var content: some View {
    switch row.content {
    case .item(let visible):
      ItemContentView(
        visible: visible, markdown: row.markdown, opensAuthorRun: row.opensAuthorRun, bubble: row.bubble,
        retryable: row.retryable)
    case .botDmRollup(let members):
      BotDmRollupView(id: row.id, members: members)
    case .toolGroup(let members):
      ToolGroupView(id: row.id, members: members)
    case .typingIndicator:
      TypingIndicatorRow()
    }
  }
}

/// The per-kind switch.
struct ItemContentView: View {
  let visible: VisibleItem
  let markdown: MarkdownDocument?
  let opensAuthorRun: Bool
  var bubble: BubbleLayout?
  /// A failed reply offers Retry (`TranscriptRow.retryable`).
  var retryable = true

  var body: some View {
    let presentation = visible.presentation
    switch visible.item {
    case .user(let item):
      UserBubbleView(
        item: item, presentation: presentation, markdown: markdown, opensAuthorRun: opensAuthorRun, bubble: bubble)
    case .assistant(let item):
      AssistantItemView(item: item, presentation: presentation, markdown: markdown, bubble: bubble, retryable: retryable)
    case .tool(let item):
      ToolItemView(item: item, presentation: presentation)
    case .status(let item):
      StatusLineView(item: item, presentation: presentation)
    case .notice(let item):
      NoticeItemView(item: item, presentation: presentation)
    case .botDmIn, .botDmOut:
      BotDmAsideView(item: visible.item, presentation: presentation)
    case .cronDelivery(let item):
      CronDeliveryCardView(item: item, presentation: presentation, markdown: markdown)
    case .approval(let item):
      ApprovalCardView(item: item, presentation: presentation)
    case .clarify(let item):
      ClarifyCardView(item: item, presentation: presentation)
    case .request(let item):
      InteractiveRequestCardView(item: item, presentation: presentation)
    case .subagentGroup(let item):
      SubagentGroupView(item: item, presentation: presentation)
    case .unknown(let item):
      UnknownItemView(item: item, presentation: presentation)
    }
  }
}
