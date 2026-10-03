import SwiftUI

/// "Jump to latest": shown while the reader is scrolled away from the bottom,
/// with the number of new messages that arrived meanwhile.
///
/// Give it to `TranscriptList`'s overlay. The count is the screen's to keep
/// (user and assistant rows that arrived while `isAtBottom` was false, reset on
/// return), as in the Expo app.
public struct JumpToLatestPill: View {
  private let state: TranscriptListState
  private let newCount: Int

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
          Label {
            if newCount > 0 {
              Text("\(Strings.Chat.Transcript.newMessages(count: newCount)) · \(Strings.Chat.Transcript.jumpToLatest)")
            } else {
              Text(Strings.Chat.Transcript.jumpToLatest)
            }
          } icon: {
            Image(systemName: "arrow.down")
          }
          .font(.callout.weight(.semibold))
          .foregroundStyle(.primary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          // A thick material, not clear glass: the text behind the pill must not read through
          // its label.
          .background(.thickMaterial, in: .capsule)
          .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
          .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
          .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.downArrow, modifiers: [.command])
        .accessibilityIdentifier("transcript.jumpToLatest")
        .padding(.bottom, 12)
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(reduceMotion ? nil : .snappy, value: state.isAtBottom)
  }
}
