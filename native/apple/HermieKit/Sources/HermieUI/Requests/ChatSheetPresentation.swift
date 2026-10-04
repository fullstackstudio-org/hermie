import SwiftUI

/**
 How a chat's request sheets (approval, clarify, confirm, secure prompt, form, file request, draft
 review) are put on screen.

 On the iPhone and the iPad they are sheets (`.sheet(item:)`), as before. On the Mac a sheet is
 window-modal: it blocks the whole window, the sidebar included, so a request that came up in one
 chat stopped the person from going to another one (HERM-251). There the chat screen hosts them in
 its own pane instead (`ChatSheetHost`): the request comes up over the chat it belongs to, with the
 chat under it dimmed and switched off, and the sidebar, the toolbar's search and every other chat
 stay usable. Choosing another chat takes the pane away with its chat, and the chat's feed puts the
 request away as Later does (`ChatFeed.stop`).

 The sheets' own content is the same in both: their Later, Close and Esc buttons, their timers and
 their tap guards. Esc in the pane is the sheet's Cancel button (`.keyboardShortcut(.cancelAction)`),
 and `onExitCommand` hands it to the sheet's dismissal like a sheet's own Esc would.

 A screen that does not host them (a preview, the lab, a test) gets the sheet, so a request is never
 left without a way onto the screen.
 */
extension View {
  /// A request sheet of a chat: a sheet, or a pane over the chat where the screen hosts one.
  func chatSheet<Item: Identifiable, Sheet: View>(
    item: Binding<Item?>,
    @ViewBuilder content: @escaping (Item) -> Sheet
  ) -> some View {
    modifier(ChatSheetPresentation(item: item, sheet: content))
  }

  /// Host the chat's request sheets in this view's own pane (the Mac's chat screen). `covered`: a
  /// request is up, so the chat under it takes no clicks and no keys.
  func chatSheetHost(covered: Bool) -> some View {
    modifier(ChatSheetHost(covered: covered))
  }
}

extension EnvironmentValues {
  /// The chat screen hosts its request sheets in a pane of its own (`ChatSheetHost`).
  @Entry var chatSheetHosted = false
}

/// One request sheet that wants the pane.
struct ChatSheetEntry {
  let id: AnyHashable
  let view: AnyView
  /// Put it away as the sheet's own dismissal (Esc, a swipe) does.
  let dismiss: @MainActor () -> Void
}

/// The request sheets that want the pane, innermost first; the chat raises one at a time
/// (`ChatSheetOrder`), and the last one wins if two meet for a frame.
struct ChatSheetKey: PreferenceKey {
  static var defaultValue: [ChatSheetEntry] { [] }

  static func reduce(value: inout [ChatSheetEntry], nextValue: () -> [ChatSheetEntry]) {
    value.append(contentsOf: nextValue())
  }
}

struct ChatSheetPresentation<Item: Identifiable, Sheet: View>: ViewModifier {
  @Binding var item: Item?
  let sheet: (Item) -> Sheet

  @Environment(\.chatSheetHosted) private var hosted

  func body(content: Content) -> some View {
    if hosted {
      // Added to what the views inside already asked for, never in its place: a chat stacks three of
      // these (approvals, secure prompts, interactive requests), and `preference(key:value:)` from the
      // outer one would hide an inner one's request, leaving the chat covered with nothing to answer.
      let entries = self.entries
      content.transformPreference(ChatSheetKey.self) { $0.append(contentsOf: entries) }
    } else {
      content.sheet(item: $item, content: sheet)
    }
  }

  private var entries: [ChatSheetEntry] {
    guard let item else {
      return []
    }

    let binding = $item

    return [ChatSheetEntry(id: AnyHashable(item.id), view: AnyView(sheet(item)), dismiss: { binding.wrappedValue = nil })]
  }
}

/// The pane a chat screen shows its request in: over the chat only, never over the window.
struct ChatSheetHost: ViewModifier {
  let covered: Bool

  func body(content: Content) -> some View {
    content
      .environment(\.chatSheetHosted, true)
      // Under the request the chat takes nothing: no click, no typing into the composer (a value
      // typed for a secure prompt must never land in the message field).
      .disabled(covered)
      .accessibilityHidden(covered)
      .overlayPreferenceValue(ChatSheetKey.self) { entries in
        if let entry = entries.last {
          ChatSheetPane(entry: entry)
        }
      }
  }
}

/// The request over its chat: the chat dimmed behind it, the request's own view on a card.
struct ChatSheetPane: View {
  let entry: ChatSheetEntry

  @FocusState private var focused: Bool

  /// The card's size on a large window; on a small one it takes what there is, less the margin.
  static let maxWidth: CGFloat = 560
  static let maxHeight: CGFloat = 720
  static let margin: CGFloat = 20

  var body: some View {
    ZStack {
      Rectangle()
        .fill(.black.opacity(0.25))
        // Takes the clicks meant for the chat under it; a click there is not an answer and not Later.
        .contentShape(.rect)
        .onTapGesture {}
        .accessibilityHidden(true)

      entry.view
        .id(entry.id)
        // The card takes the keyboard when it comes up (the composer under it gave it up and takes
        // none while covered), so Esc reaches the request and Tab stays among its own controls.
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        #if os(macOS)
          .focusSection()
        #endif
        .onAppear { focused = true }
        .frame(maxWidth: Self.maxWidth, maxHeight: Self.maxHeight)
        .background(.background, in: .rect(cornerRadius: 16))
        .clipShape(.rect(cornerRadius: 16))
        .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
        .padding(Self.margin)
        #if os(macOS)
          .onExitCommand { entry.dismiss() }
        #endif
        .accessibilityAddTraits(.isModal)
    }
    .accessibilityIdentifier("chat.requestPane")
  }
}
