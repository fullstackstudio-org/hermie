import HermieCore
import HermieTranscript
import SwiftUI

/// What the row of actions under a bot turn offers, decided from the closing reply and what the chat
/// says about it, so a test holds the rules without a screen.
///
/// The row is ChatGPT's: Copy, Share and, on the newest turn, Retry, then a "…" menu with the rest
/// (`MessageMenuItems`). There is one per turn, under its last reply (`TranscriptRow.turnReply`), and
/// it acts on all of the turn's words. It is drawn under a reply that is done and has words; never
/// while the reply is still being written, and never under a failed reply (that one has its own card
/// with its own Retry).
struct ReplyActionsPlan: Equatable, Sendable {
  /// How loud the row is: the newest turn's at full strength, older turns' quieter.
  enum Emphasis: Equatable, Sendable {
    case latest, earlier
  }

  var emphasis: Emphasis
  /// Retry is in the row: only on the newest turn, and only where the chat can ask for it again.
  var retry: Bool

  /// The row under `item`, which closes `turn`, or nil where there is none.
  /// - Parameters:
  ///   - turn: what `TranscriptRow.turnReply` says; nil for a row that does not close a turn.
  ///   - canRegenerate: the chat's menu offers Regenerate on this reply now (the reader's own prompt
  ///     stands before it and none after, `MessageMenu`).
  static func make(for item: AssistantItem, presentation: Presentation, turn: TurnReply?, canRegenerate: Bool) -> Self? {
    guard let turn else { return nil }
    guard presentation == .full || presentation == .collapsed else { return nil }
    guard !item.streaming, !item.interim, item.error == nil else { return nil }
    guard item.text.contains(where: { !$0.isWhitespace }) else { return nil }

    return ReplyActionsPlan(emphasis: turn.latest ? .latest : .earlier, retry: turn.latest && canRegenerate)
  }
}

/// The action row under a bot turn: icons only, in the secondary colour, each with its words for
/// VoiceOver. Copy puts the turn's Markdown on the pasteboard, Share hands the same text to the system
/// share sheet, Retry asks for the reply again, and "…" opens the message's menu, which acts on the
/// whole turn too.
struct ReplyActionsView: View {
  let item: AssistantItem
  let presentation: Presentation
  let turn: TurnReply

  @Environment(\.transcriptItemActions) private var actions

  var body: some View {
    // Read here, in a view of its own, so the row follows the chat (the newest reply moves on, the
    // reader's prompt arrives) without the transcript row being redrawn for it.
    let canRegenerate = actions.messageMenu(.assistant(item)).entry(.regenerate) != nil

    if let plan = ReplyActionsPlan.make(
      for: item, presentation: presentation, turn: turn, canRegenerate: canRegenerate)
    {
      ReplyActionButtons(item: item, turn: turn, plan: plan)
    }
  }
}

struct ReplyActionButtons: View {
  let item: AssistantItem
  let turn: TurnReply
  let plan: ReplyActionsPlan

  @Environment(\.transcriptItemActions) private var actions
  @State private var copied = false
  @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 18
  @ScaledMetric(relativeTo: .body) private var target: CGFloat = 36

  /// The closing reply as if it held the whole turn's words: what Copy, Share and the menu act on. It
  /// keeps the reply's id, so Retry, Branch and the rest still point at the reply the chat knows.
  private var turnItem: TranscriptItem {
    var whole = item
    whole.text = turn.text
    return .assistant(whole)
  }

  /// The words the buttons hand on: the turn's Markdown, as written.
  private var words: String {
    MessageMenu.copyMarkdown(of: turnItem) ?? MessageMenu.copyText(of: turnItem) ?? turn.text
  }

  var body: some View {
    HStack(spacing: 0) {
      Button {
        actions.copy(words)
        copied = true
      } label: {
        icon(copied ? "checkmark" : "doc.on.doc")
      }
      .accessibilityLabel(copied ? NativeStrings.ReplyActions.copied : NativeStrings.ReplyActions.copy)
      .accessibilityIdentifier("reply.copy")
      .task(id: copied) {
        guard copied else { return }
        try? await Task.sleep(for: .seconds(1.5))
        copied = false
      }

      ShareLink(item: words) {
        icon("square.and.arrow.up")
      }
      .accessibilityLabel(NativeStrings.ReplyActions.share)
      .accessibilityIdentifier("reply.share")

      if plan.retry {
        Button {
          actions.chooseMessageAction(.regenerate, .assistant(item))
        } label: {
          icon("arrow.clockwise")
        }
        .accessibilityLabel(NativeStrings.ReplyActions.retry)
        .accessibilityIdentifier("reply.retry")
      }

      Menu {
        MessageMenuItems(item: turnItem)
      } label: {
        icon("ellipsis")
      }
      .menuIndicator(.hidden)
      .accessibilityLabel(NativeStrings.ReplyActions.more)
      .accessibilityIdentifier("reply.more")
    }
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    // The first glyph stands under the first letter of the words, not a touch target's width in.
    .padding(.leading, -(target - glyph) / 2)
    .opacity(plan.emphasis == .latest ? 1 : Self.earlierOpacity)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("reply.actions")
  }

  /// A light glyph of about 18 points in a 36 point touch target, ChatGPT's proportions.
  private func icon(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: glyph, weight: .light))
      .frame(width: target, height: target)
      .contentShape(.rect)
  }

  /// The older turns' rows, quieter: still readable, no louder than the page.
  static let earlierOpacity = 0.5
}

extension NativeStrings {
  enum ReplyActions {
    /// Copy (the button under a reply)
    static var copy: String { String(localized: "native.reply.copy", table: "Native", bundle: .module) }
    /// Copied (the Copy button for a moment after it was pressed)
    static var copied: String { String(localized: "native.reply.copied", table: "Native", bundle: .module) }
    /// Share (the button under a reply)
    static var share: String { String(localized: "native.reply.share", table: "Native", bundle: .module) }
    /// Try again (the button under the newest reply)
    static var retry: String { String(localized: "native.reply.retry", table: "Native", bundle: .module) }
    /// More (the "…" button under a reply, which opens the message's menu)
    static var more: String { String(localized: "native.reply.more", table: "Native", bundle: .module) }
  }
}
