import HermieCore
import HermieTranscript
import SwiftUI

/// A form, a file request or a draft review the bot asked for: a compact card with what it is, what
/// the agent called it, and how it stands. Open, it says it waits for an answer and opens the sheet
/// again (after Later); closed, it says how it ended. Never a value: the transcript's `RequestItem`
/// has nothing that could hold one, only the status, how many files and whether a draft was edited.
///
/// The agent's title is shown as plain text, cleaned and bounded, never as Markdown.
struct InteractiveRequestCardView: View {
  let item: RequestItem
  let presentation: Presentation

  @Environment(\.transcriptInteractive) private var interactive

  /// The sheet can be raised for this request: the chat holds it as open.
  private var canOpen: Bool {
    item.state == .open && interactive?.openPrompts.contains { $0.id == item.requestID } == true
  }

  var body: some View {
    let kind = Self.kind(of: item)
    let state = Self.state(of: item)
    let title = InteractivePrompt.line(item.title, limit: InteractivePrompt.titleLimit)

    HStack(alignment: .top, spacing: 10) {
      Image(systemName: Self.icon(of: item))
        .foregroundStyle(item.state == .open ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .frame(width: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        if let kind {
          Text(kind)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        }
        Text(verbatim: title)
          .font(.callout.weight(.semibold))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
        Text(state)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      if canOpen, let interactive {
        Button(NativeStrings.Interactive.Card.openAction) {
          interactive.present(item.requestID)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .accessibilityIdentifier("request.card.open")
      }
    }
    .cardSurface(tint: item.state == .open ? .orange : nil)
    .accessibilityElement(children: .contain)
    .accessibilityLabel([kind, title, state].compactMap(\.self).joined(separator: ". "))
    .accessibilityIdentifier("request.card")
  }

  // MARK: Words

  /// What kind of request it is, in the app's words; nil for a method this build does not know.
  static func kind(of item: RequestItem) -> String? {
    switch item.method {
    case "input.form": NativeStrings.Interactive.Card.form
    case "input.file": NativeStrings.Interactive.Card.file
    case "review.draft": NativeStrings.Interactive.Card.draft
    default: nil
    }
  }

  static func icon(of item: RequestItem) -> String {
    if item.state == .cancelled {
      return "xmark.circle"
    }

    switch item.method {
    case "input.file": return "paperclip"
    case "review.draft": return "text.badge.checkmark"
    default: return "list.bullet.rectangle"
    }
  }

  /// How it stands: waiting, how it was answered (by the summary's keys alone), or how it ended.
  static func state(of item: RequestItem) -> String {
    typealias Words = NativeStrings.Interactive.Card

    switch item.state {
    case .open:
      return Words.open
    case .answered:
      let summary = item.answerSummary

      if summary?.decision == "approved" {
        return summary?.edited == true ? Words.approvedEdited : Words.approved
      }

      if summary?.decision == "rejected" {
        return Words.rejected
      }

      if summary?.status == "skipped" {
        return Words.skipped
      }

      if let count = summary?.count {
        return Words.files(count)
      }

      return Words.answered
    default:
      switch item.cancelReason {
      case "timeout": return Words.timedOut
      case "resolved": return Words.answeredElsewhere
      default: return Words.ended
      }
    }
  }
}
