import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// A message's words, put up to be selected in part: what `Select text` in the message's menu opens
/// (HERM-254). Plain text, the same words `Copy text` gives (`MessageMenu.selectableText`).
struct SelectTextRequest: Identifiable, Equatable, Sendable {
  /// The message's id: a request for another message replaces the sheet's content.
  let id: String
  let text: String
}

#if os(iOS)
  /// The words as a `UITextView`: selectable, not editable. It is the one view on iOS that gives the
  /// system selection handles, the magnifier, and Copy, Share and Look Up on any part of the text,
  /// which is what the bubble itself cannot do (a long press there opens the message's menu).
  struct SelectableTextView: UIViewRepresentable {
    let text: String
    let accessibilityLabel: String

    func makeUIView(context: Context) -> UITextView {
      let view = UITextView()
      view.isEditable = false
      view.isSelectable = true
      view.isScrollEnabled = true
      view.backgroundColor = .clear
      view.font = UIFont.preferredFont(forTextStyle: .body)
      view.adjustsFontForContentSizeCategory = true
      view.textColor = .label
      view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
      view.alwaysBounceVertical = true
      view.accessibilityLabel = accessibilityLabel
      view.text = text
      return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
      if view.text != text {
        view.text = text
      }
    }
  }
#endif

/// The sheet over the chat that shows the words to select.
struct SelectTextSheet: View {
  let request: SelectTextRequest
  let copyAll: @MainActor (String) -> Void
  let close: () -> Void

  var body: some View {
    NavigationStack {
      Group {
        #if os(iOS)
          SelectableTextView(text: request.text, accessibilityLabel: Strings.Chat.SelectText.panel)
        #else
          ScrollView {
            Text(verbatim: request.text)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding()
              .accessibilityLabel(Strings.Chat.SelectText.panel)
          }
        #endif
      }
      .navigationTitle(Strings.Chat.SelectText.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.Chat.SelectText.copyAll) { copyAll(request.text) }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.Chat.SelectText.done, action: close)
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("hermie.chat.selectText")
  }
}

extension View {
  /// The select-text sheet over this view while `request` holds a message.
  func selectTextSheet(
    _ request: Binding<SelectTextRequest?>, copyAll: @escaping @MainActor (String) -> Void
  ) -> some View {
    sheet(item: request) { current in
      SelectTextSheet(request: current, copyAll: copyAll) { request.wrappedValue = nil }
    }
  }
}
