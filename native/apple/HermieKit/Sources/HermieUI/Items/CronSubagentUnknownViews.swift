import HermieMarkdown
import HermieTranscript
import SwiftUI

/// A scheduled job's report delivered into the chat: the scheduler speaking,
/// not a person, so a card rather than a bubble. Open unless `quiet` folded it.
struct CronDeliveryCardView: View {
  let item: CronDeliveryItem
  let presentation: Presentation
  let markdown: MarkdownDocument?

  @Environment(\.transcriptExpansion) private var expansion
  @Environment(\.transcriptItemActions) private var actions

  private var name: String {
    item.nameRedacted == true || item.jobName.isEmpty ? Strings.Chat.Cron.unnamed : item.jobName
  }

  var body: some View {
    let box = expansion.box("cron:\(item.id)", default: presentation == .full)
    VStack(alignment: .leading, spacing: 8) {
      DisclosureHeader(box: box) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: "clock.arrow.circlepath")
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            Text(Strings.Chat.Cron.eyebrow)
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
            Text(name)
              .font(.subheadline.weight(.semibold))
            Text(ItemFormat.clock(item.ts).map { Strings.Chat.Cron.ranAt(time: $0) } ?? Strings.Chat.Cron.delivered)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      if box.isExpanded {
        if item.body.isEmpty {
          Text(Strings.Chat.Cron.emptyBody)
            .font(.callout)
            .foregroundStyle(.secondary)
        } else if let markdown {
          MarkdownView(markdown).markdownChartWords()
        } else {
          MarkdownView(MarkdownDocument(item.body)).markdownChartWords()
        }
      }
    }
    .cardSurface()
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if !item.body.isEmpty {
        Button(Strings.Chat.Menu.copyText) { actions.copy(item.body) }
      }
    }
  }
}

/// A fan-out of subagents: its status and goals. `chip` when bot-to-bot is
/// hidden or at `quiet`, the goals one line each when `collapsed`, wrapped when
/// `full`. A child's own progress lives in the agents sheet, which reads the
/// chat's subagent tree; this row only has the group.
struct SubagentGroupView: View {
  let item: SubagentGroupItem
  let presentation: Presentation

  private var statusText: String {
    switch item.status {
    case .dispatched: Strings.Chat.Subagents.GroupStatus.dispatched
    case .running: Strings.Chat.Subagents.GroupStatus.running
    case .done: Strings.Chat.Subagents.GroupStatus.done
    case .failed: Strings.Chat.Subagents.GroupStatus.failed
    case .other(let raw): raw
    }
  }

  private var symbol: String {
    switch item.status {
    case .done: "checkmark.circle.fill"
    case .failed: "xmark.circle.fill"
    case .running: "circle.dotted.circle"
    default: "circle"
    }
  }

  private var title: String { "\(Strings.Chat.Subagents.title) · \(statusText)" }

  var body: some View {
    switch presentation {
    case .hiddenPlaceholder:
      EmptyView()
    case .chip:
      ItemChip(
        text: "\(title) · \(Strings.Chat.Subagents.goals(count: item.goals.count))",
        systemImage: "person.3",
        tone: item.status == .failed ? .danger : .neutral
      )
    case .collapsed, .full:
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Label(title, systemImage: "person.3")
            .font(.subheadline.weight(.semibold))
          Spacer()
          Text(Strings.Chat.Subagents.goals(count: item.goals.count))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        ForEach(Array(item.goals.enumerated()), id: \.offset) { _, goal in
          Label {
            Text(goal)
              .font(.footnote)
              .lineLimit(presentation == .full ? nil : 1)
          } icon: {
            Image(systemName: symbol)
              .imageScale(.small)
              .foregroundStyle(item.status == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
          }
        }
        if let completion = item.completion, !completion.isEmpty {
          FoldableText(text: completion, limit: 400)
            .foregroundStyle(.secondary)
        }
      }
      .cardSurface()
      .accessibilityElement(children: .combine)
    }
  }
}

/// A kind this build does not know. The Expo app draws nothing; here one quiet
/// line says something is there, so a newer gateway's row is not silently lost.
struct UnknownItemView: View {
  let item: UnknownItem
  let presentation: Presentation

  var body: some View {
    if presentation == .hiddenPlaceholder {
      EmptyView()
    } else {
      ItemChip(text: NativeStrings.Transcript.unsupportedItem(item.kindName), systemImage: "questionmark.square.dashed")
        .accessibilityElement(children: .combine)
    }
  }
}
