import SwiftUI

/// "Jump to latest": a small round glass button with a down arrow, centred above the composer while
/// the reader is scrolled away from the bottom, as ChatGPT has it. A badge with the number of new
/// messages that arrived meanwhile sits on it when there are any.
///
/// Give it to `TranscriptList`'s overlay. The count is the screen's to keep (user and assistant rows
/// that arrived while `isAtBottom` was false, reset on return), as in the Expo app.
public struct JumpToLatestPill: View {
  private let state: TranscriptListState
  private let newCount: Int

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 40

  public init(state: TranscriptListState, newCount: Int = 0) {
    self.state = state
    self.newCount = newCount
  }

  public var body: some View {
    ZStack {
      if !state.isAtBottom {
        Button {
          state.scrollToBottom(animated: !reduceMotion)
        } label: {
          Image(systemName: "arrow.down")
            .font(.body.weight(.semibold))
            .foregroundStyle(.primary)
            .frame(width: diameter, height: diameter)
            // Glass tinted with the page, so the words behind it do not read through the arrow.
            .glassEffect(.regular.tint(ComposerView.fieldTint).interactive(), in: .circle)
            .overlay(alignment: .topTrailing) {
              if newCount > 0 {
                Text(verbatim: Self.badge(newCount))
                  .font(.caption2.weight(.bold).monospacedDigit())
                  .foregroundStyle(.white)
                  .padding(.horizontal, 5)
                  .frame(minWidth: 18, minHeight: 18)
                  .background(BubblePalette.outgoing, in: .capsule)
                  .offset(x: 6, y: -6)
                  .accessibilityHidden(true)
              }
            }
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.downArrow, modifiers: [.command])
        .accessibilityLabel(Self.label(newCount: newCount))
        .accessibilityIdentifier("transcript.jumpToLatest")
        .padding(.bottom, 12)
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(reduceMotion ? nil : .snappy, value: state.isAtBottom)
  }

  /// The badge's number, capped so it stays a badge.
  static func badge(_ count: Int) -> String {
    count > 99 ? "99+" : String(count)
  }

  /// What VoiceOver says: the way down, with the number of new messages when there are some.
  static func label(newCount: Int) -> String {
    guard newCount > 0 else { return Strings.Chat.Transcript.jumpToLatest }
    return "\(Strings.Chat.Transcript.newMessages(count: newCount)) · \(Strings.Chat.Transcript.jumpToLatest)"
  }
}
