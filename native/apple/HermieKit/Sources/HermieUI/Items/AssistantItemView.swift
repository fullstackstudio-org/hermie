import HermieMarkdown
import HermieProtocol
import HermieTranscript
import SwiftUI

/// The bot's reply: its thought (closed until opened), the reply as Markdown,
/// a streaming indicator while it is being written, an error card when it
/// failed, and a footer with duration, tokens and model once it is done.
///
/// Drawn without a bubble, full width, as replies are on the system's own
/// assistants: a long answer reads as a page, not a balloon.
struct AssistantItemView: View {
  let item: AssistantItem
  let presentation: Presentation
  let markdown: MarkdownDocument?

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptExpansion) private var expansion

  private var hasBody: Bool { !item.text.isEmpty }

  var body: some View {
    switch presentation {
    case .hiddenPlaceholder:
      EmptyView()
    case .chip:
      ItemChip(text: ItemFormat.preview(item.text, limit: 80), systemImage: "text.bubble")
    case .full, .collapsed:
      reply
    }
  }

  private var reply: some View {
    VStack(alignment: .leading, spacing: 8) {
      content
      // Outside the container that carries Copy: a custom action makes a line interactive, and
      // a one-line caption is far under the hit area the accessibility audit asks of one.
      if let footer = footerText {
        Text(footer)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.trailing, 24)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let handle = item.replyToBotHandle {
        Text(Strings.Chat.Assistant.replyTo(handle: handle))
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .textCase(.uppercase)
      }
      if let reasoning = item.reasoning, !reasoning.isEmpty {
        ReasoningDisclosure(
          box: expansion.box("reasoning:\(item.id)", default: false),
          label: reasoningLabel,
          text: reasoning
        )
      }
      if hasBody {
        Group {
          if let markdown {
            MarkdownView(markdown)
          } else {
            MarkdownView(MarkdownDocument(item.text))
          }
        }
        .foregroundStyle(item.interim ? .secondary : .primary)
      }
      if item.streaming {
        StreamingIndicator()
      }
      if let error = item.error {
        AssistantErrorCard(error: error) { actions.retry(item) }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if hasBody {
        Button(Strings.Chat.Menu.copyText) { actions.copy(item.text) }
      }
    }
  }

  private var reasoningLabel: String {
    if item.streaming && !hasBody {
      return Strings.Chat.Assistant.thinking
    }
    return Strings.Chat.Assistant.thoughtFor(seconds: max(1, Int((item.durationS ?? 0).rounded())))
  }

  /// `chat.assistant.footer`: duration · tokens · model, only for a finished,
  /// non-interim reply drawn in full that has usage. A duration never shows
  /// on its own.
  private var footerText: String? {
    guard presentation == .full, !item.streaming, !item.interim, let usage = item.usage else { return nil }
    var parts: [String] = []
    let duration = ItemFormat.duration(item.durationS)
    if !duration.isEmpty { parts.append(duration) }
    if usage.input != nil || usage.output != nil {
      parts.append(
        Strings.Chat.Assistant.tokens(input: ItemFormat.count(usage.input ?? 0), output: ItemFormat.count(usage.output ?? 0)))
    }
    if let model = usage.model, !model.isEmpty {
      parts.append(prettyModelName(model))
    }
    guard parts.count > (duration.isEmpty ? 0 : 1) else { return nil }
    return Strings.Chat.Assistant.footer(parts: parts)
  }
}

/// A reply's thought, closed by default; the same silhouette a bot-to-bot
/// aside has.
struct ReasoningDisclosure: View {
  let box: TranscriptExpansion.Box
  let label: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      DisclosureHeader(box: box) {
        Label(label, systemImage: "brain")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      if box.isExpanded {
        Text(text)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .padding(.leading, 10)
          .overlay(alignment: .leading) {
            Rectangle().fill(.quaternary).frame(width: 2)
          }
      }
    }
  }
}

/// Dots while a reply is being written. Still under Reduce Motion.
struct StreamingIndicator: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Image(systemName: "ellipsis")
      .font(.title3)
      .foregroundStyle(.secondary)
      .symbolEffect(.variableColor.iterative, options: .repeat(.continuous), isActive: !reduceMotion)
      .accessibilityLabel(Strings.App.Chat.Subtitle.typing)
  }
}

/// `ErrorCard`: what went wrong, and a retry unless the gateway is already
/// reconnecting on its own.
struct AssistantErrorCard: View {
  let error: AssistantFailure
  let retry: @MainActor () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(Strings.Chat.Assistant.errorTitle, systemImage: "exclamationmark.triangle.fill")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.red)
      Text(error.message)
        .font(.callout)
        .textSelection(.enabled)
      if error.recoverable == true {
        Text(Strings.Chat.Assistant.reconnecting)
          .font(.footnote)
          .foregroundStyle(.secondary)
      } else {
        Button(Strings.Chat.Assistant.retry, action: retry)
          .buttonStyle(.bordered)
      }
    }
    .cardSurface(tint: .red)
    .accessibilityElement(children: .contain)
  }
}
