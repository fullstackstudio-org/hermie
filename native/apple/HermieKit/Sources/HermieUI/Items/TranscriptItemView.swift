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
      .accessibilityIdentifier("row.\(row.id)")
      #if DEBUG
        .onAppear { RenderCounter.appeared(row.id) }
      #endif
  }

  @ViewBuilder private var content: some View {
    switch row.content {
    case .item(let visible):
      ItemContentView(visible: visible, markdown: row.markdown, opensAuthorRun: row.opensAuthorRun)
    case .botDmRollup(let members):
      BotDmRollupView(id: row.id, members: members)
    }
  }
}

/// The per-kind switch.
struct ItemContentView: View {
  let visible: VisibleItem
  let markdown: MarkdownDocument?
  let opensAuthorRun: Bool

  var body: some View {
    let presentation = visible.presentation
    switch visible.item {
    case .user(let item):
      UserBubbleView(item: item, presentation: presentation, markdown: markdown, opensAuthorRun: opensAuthorRun)
    case .assistant(let item):
      AssistantItemView(item: item, presentation: presentation, markdown: markdown)
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
