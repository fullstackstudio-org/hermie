import SwiftUI

/// The row a followed search hit scrolled to, marked for a moment: a soft wash of the tint behind the
/// whole row, which fades out when the mark goes. It is part of the row's value (`TranscriptRow.flash`),
/// so setting it redraws that row and no other.
struct FoundRowMark: ViewModifier {
  let active: Bool

  func body(content: Content) -> some View {
    content
      .background {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.tint.opacity(active ? 0.16 : 0))
          .padding(.horizontal, 4)
          .animation(.easeOut(duration: 0.6), value: active)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
  }
}

/// Over the top of the transcript, when a search hit's words were not in the visible text of the chat
/// it opened: the sentence, where it can be read, until it goes by itself.
struct ChatFindNotice: View {
  let feed: ChatFeed

  var body: some View {
    if let notice = feed.findNotice {
      Text(verbatim: notice)
        .font(.footnote)
        .multilineTextAlignment(.leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: .rect(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, ChatSpacing.edgeMargin)
        .padding(.top, 8)
        .transition(.opacity)
        .accessibilityIdentifier("hermie.chat.findNotice")
    }
  }
}
