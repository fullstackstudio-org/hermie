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

  public init(row: TranscriptRow) {
    self.row = row
  }

  public nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.row == rhs.row
  }

  public var body: some View {
    #if DEBUG
      let _ = RenderCounter.tick(row.id)
    #endif
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      // Bubbles of one group sit close; a new group, and every other row, gets room above it.
      .padding(.top, Self.gap(above: row))
      .accessibilityIdentifier("row.\(row.id)")
      #if DEBUG
        .onAppear { RenderCounter.appeared(row.id) }
      #endif
  }

  /// The room above a row that opens a group, on top of the list's spacing between rows (2 points
  /// in the chat, so the bubbles of one group sit as close as Messages draws them).
  nonisolated static let groupGap: CGFloat = 8

  /// The room above a row: none inside a group of bubbles, none for a row that draws nothing (a
  /// hidden placeholder, quiet's stand-in for the running tool), the group gap otherwise.
  nonisolated static func gap(above row: TranscriptRow) -> CGFloat {
    if TranscriptRowBuilder.drawsNothing(row) { return 0 }
    return row.bubble.map { $0.opensGroup ? groupGap : 0 } ?? groupGap
  }

  @ViewBuilder private var content: some View {
    switch row.content {
    case .item(let visible):
      ItemContentView(visible: visible, markdown: row.markdown, opensAuthorRun: row.opensAuthorRun, bubble: row.bubble)
    case .botDmRollup(let members):
      BotDmRollupView(id: row.id, members: members)
    case .toolGroup(let members):
      ToolGroupView(id: row.id, members: members)
    }
  }
}

/// The per-kind switch.
struct ItemContentView: View {
  let visible: VisibleItem
  let markdown: MarkdownDocument?
  let opensAuthorRun: Bool
  var bubble: BubbleLayout?

  var body: some View {
    let presentation = visible.presentation
    switch visible.item {
    case .user(let item):
      UserBubbleView(
        item: item, presentation: presentation, markdown: markdown, opensAuthorRun: opensAuthorRun, bubble: bubble)
    case .assistant(let item):
      AssistantItemView(item: item, presentation: presentation, markdown: markdown, bubble: bubble)
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
    case .subagentGroup(let item):
      SubagentGroupView(item: item, presentation: presentation)
    case .unknown(let item):
      UnknownItemView(item: item, presentation: presentation)
    }
  }
}
