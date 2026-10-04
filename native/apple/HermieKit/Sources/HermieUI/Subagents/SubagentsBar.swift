import HermieCore
import SwiftUI

/**
 The bar above the composer while a delegation runs: "3 agents working · 0:42 · Show". It opens the
 agents sheet, where each child can be steered, stopped or read. It is there only while a child is
 queued or running, and says nothing else: the dots at its left are still, because agents being busy
 is information and the only thing in the app that moves is a bot that needs an answer.

 The clock is the only part that changes by itself (once a second, from the oldest running child's
 start); VoiceOver reads the count and not the clock, which would change under it.
 */
struct SubagentsBar: View {
  let chat: ChatRef
  let model: ChatModel

  @State private var showing = false

  var body: some View {
    let bar = model.subagentBar

    // Held up while the sheet is: the sheet is presented from the bar, and it stays until it is closed
    // even when the last child finished, so what the agents did can still be read.
    if bar.isShown || showing {
      Button {
        showing = true
      } label: {
        HStack(spacing: 8) {
          pips

          Text(Strings.Chat.Subagents.barCount(count: bar.running))
            .font(.footnote.weight(.semibold))

          Text(verbatim: "·")
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)

          clock(bar)

          Spacer(minLength: 0)

          Text(Strings.Chat.Subagents.barOpen)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(minHeight: 36)
        .background(.regularMaterial, in: .capsule)
        .contentShape(.capsule)
      }
      .buttonStyle(.plain)
      .padding(.horizontal, ChatSpacing.edgeMargin)
      .padding(.bottom, 6)
      .accessibilityLabel(Strings.Chat.Subagents.barCount(count: bar.running))
      .accessibilityHint(NativeStrings.Subagents.barHint)
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("hermie.chat.agentsBar")
      .sheet(isPresented: $showing) {
        SubagentsSheet(chat: chat, model: model)
      }
    }
  }

  /// Three still dots at falling opacity: more than three is a crowd, not a count.
  private var pips: some View {
    HStack(spacing: 3) {
      ForEach([1.0, 0.7, 0.45], id: \.self) { opacity in
        Circle()
          .fill(Color.green)
          .opacity(opacity)
          .frame(width: 5, height: 5)
      }
    }
    .accessibilityHidden(true)
  }

  private func clock(_ bar: SubagentBar) -> some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      Text(verbatim: SubagentBar.clock(bar.elapsed(atMs: context.date.timeIntervalSince1970 * 1000)))
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
    }
    .accessibilityHidden(true)
  }
}
