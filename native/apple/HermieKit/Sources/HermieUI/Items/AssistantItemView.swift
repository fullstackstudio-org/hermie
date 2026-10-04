import HermieMarkdown
import HermieProtocol
import HermieTranscript
import SwiftUI

/// The bot's reply, as Messages draws an incoming message: its words in the
/// grey bubble on the leading side, Markdown rendered inside it, the tail and
/// the time only on the last bubble of a group (`BubbleLayout`). Around the
/// bubble, not in it: who it answers, its thought (closed until opened), an
/// error card when it failed, and a footer with duration, tokens and model once
/// it is done. While it is being written and has no words yet there is no bubble: the
/// transcript's typing indicator (`TypingIndicatorRow`) stands in for it.
///
/// The bubble is no wider than three quarters of the column; a reply with a
/// table or code in it gets nearly the whole column, so neither is squeezed.
/// Tool calls, cron reports and the other routine rows keep their own cards
/// and lines, so a bubble is only ever the bot's words.
struct AssistantItemView: View {
  let item: AssistantItem
  let presentation: Presentation
  let markdown: MarkdownDocument?
  var bubble: BubbleLayout?
  /// Retry is offered under a failure: only on the newest turn (`TranscriptRow.retryable`).
  var retryable = true

  @Environment(\.transcriptItemActions) private var actions
  @Environment(\.transcriptExpansion) private var expansion

  private var hasBody: Bool { !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var closesGroup: Bool { bubble?.closesGroup ?? true }

  /// The failure card's Retry, or nil under an older turn's failure.
  private var retryAction: (@MainActor () -> Void)? {
    guard retryable else {
      return nil
    }

    let actions = self.actions
    let item = self.item
    return { actions.retry(item) }
  }

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
    VStack(alignment: .leading, spacing: ChatSpacing.bubbleCaption) {
      if let ts = bubble?.timeHeader {
        BubbleTimeHeader(ts: ts)
      }
      content
      // Outside the container that carries Copy: a custom action makes a line interactive, and
      // a one-line caption is far under the hit area the accessibility audit asks of one.
      if let meta = metaText {
        Text(meta)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .padding(.horizontal, ChatSpacing.captionInset)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let handle = item.replyToBotHandle {
        Text(Strings.Chat.Assistant.replyTo(handle: handle))
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .textCase(.uppercase)
          .padding(.leading, 6)
      }
      if let reasoning = item.reasoning, !reasoning.isEmpty {
        ReasoningDisclosure(
          box: expansion.box("reasoning:\(item.id)", default: false),
          label: reasoningLabel,
          text: reasoning
        )
        .padding(.leading, 6)
      }
      if hasBody {
        BubbleColumn(side: .incoming, width: Self.width(for: markdown)) {
          MessageBubble(side: .incoming, tail: closesGroup, fill: BubblePalette.incoming) {
            words
          }
        }
      }
      if let error = item.error {
        AssistantErrorCard(error: error, retry: retryAction)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if hasBody {
        Button(Strings.Chat.Menu.copyText) { actions.copy(item.text) }
      }
    }
  }

  /// The reply's words; an interim note (the reply so far) a level quieter.
  private var words: some View {
    Group {
      if let markdown {
        MarkdownView(markdown)
      } else {
        MarkdownView(MarkdownDocument(item.text))
      }
    }
    .environment(\.markdownFillsWidth, false)
    .foregroundStyle(item.interim ? .secondary : .primary)
  }

  /// Words get a bubble three quarters wide; a table, a listing, a formula or a diagram gets nearly
  /// the whole column.
  static func width(for document: MarkdownDocument?) -> BubbleWidth {
    guard let document else { return .text }
    let wide = document.blocks.contains { block in
      switch block.kind {
      case .table, .code, .math, .mermaid: true
      default: false
      }
    }
    return wide ? .wide : .text
  }

  private var reasoningLabel: String {
    if item.streaming && !hasBody {
      return Strings.Chat.Assistant.thinking
    }
    return Strings.Chat.Assistant.thoughtFor(seconds: max(1, Int((item.durationS ?? 0).rounded())))
  }

  /// Under the bubble, on a line of its own: the time when the bubble closes its group, then the
  /// footer.
  private var metaText: String? {
    var parts: [String] = []
    if closesGroup, !item.streaming, hasBody, let clock = ItemFormat.clock(item.ts) {
      parts.append(clock)
    }
    if let footer = footerText {
      parts.append(footer)
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
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

/// `ErrorCard`: what went wrong, and a retry unless the gateway is already
/// reconnecting on its own.
struct AssistantErrorCard: View {
  let error: AssistantFailure
  /// Nil: no Retry (an older turn's failure).
  let retry: (@MainActor () -> Void)?

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
      } else if let retry {
        Button(Strings.Chat.Assistant.retry, action: retry)
          .buttonStyle(.bordered)
      }
    }
    .cardSurface(tint: .red)
    .accessibilityElement(children: .contain)
  }
}
