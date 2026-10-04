#if os(macOS)
  import CoreTransferable
  import HermieCore
  import SwiftUI

  /// A chat being dragged in the list: which gateway's, and which bot. A drop from another gateway's
  /// window is refused.
  struct DraggedChat: Codable, Transferable, Sendable {
    let gatewayID: String
    let bot: String

    static var transferRepresentation: some TransferRepresentation {
      CodableRepresentation(contentType: .json)
    }
  }

  /**
   A chat row the Mac drags and drops on: a chat dropped on it lands next to it, in its folder or at the
   top level (`ChatListSections.dropAnchor`), which is how a chat is reordered and moved between
   folders with the pointer. The row it would land beside is outlined while a chat is over it.

   Reordering by keyboard is the Chat menu's Move Up and Move Down and the VoiceOver actions; the
   pointer's is this.
   */
  struct ChatRowDragDrop: ViewModifier {
    let gatewayID: String
    let bot: String
    /// Where a chat dropped here lands, or nil to refuse it.
    let anchor: (String) -> ChatListArrangement.Anchor?
    let drop: (String, ChatListArrangement.Anchor) -> Void

    @State private var targeted = false

    func body(content: Content) -> some View {
      let dragged = DraggedChat(gatewayID: gatewayID, bot: bot)

      content
        .draggable(dragged)
        .dropDestination(for: DraggedChat.self) { items, _ in
          guard let item = items.first, item.gatewayID == gatewayID, let anchor = anchor(item.bot) else {
            return false
          }

          drop(item.bot, anchor)
          return true
        } isTargeted: { targeted = $0 }
        .overlay {
          if targeted {
            RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor, lineWidth: 2)
              .allowsHitTesting(false)
          }
        }
    }
  }

  /// A folder's header as a drop target: a chat dropped on it goes to the end of the folder.
  struct FolderDrop: ViewModifier {
    let gatewayID: String
    let drop: (String) -> Void

    @State private var targeted = false

    func body(content: Content) -> some View {
      content
        .dropDestination(for: DraggedChat.self) { items, _ in
          guard let item = items.first, item.gatewayID == gatewayID else {
            return false
          }

          drop(item.bot)
          return true
        } isTargeted: { targeted = $0 }
        .background {
          if targeted {
            RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.25))
              .allowsHitTesting(false)
          }
        }
    }
  }
#endif
