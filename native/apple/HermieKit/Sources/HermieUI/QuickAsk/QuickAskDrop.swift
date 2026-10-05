#if os(macOS)
  import HermieCore
  import SwiftUI
  import UniformTypeIdentifiers

  /// What a dragged item becomes in the quick ask.
  enum QuickAskDropKind: Equatable {
    /// A file or a picture: a chip in the attachment tray, as in a chat.
    case attachment
    /// Words or a link: typed into the field, or attached as a text file when they are long.
    case words
    /// Anything else: left alone.
    case ignored
  }

  /// What came of handing a drop to the quick ask.
  struct QuickAskDropReceipt {
    /// Items that went to the tray.
    var attached: Int
    /// Items that are read as words.
    var words: Int
    /// Done when every file is copied in and every piece of words is in the field (or the tray).
    var finished: Task<Void, Never>
  }

  /**
   Dragging files, pictures or words onto the quick ask.

   Files and pictures take the chat's own road (`AttachmentIntake.addDropped`): one chip each at
   once, copied in and uploaded as in a chat. Words and links, which a chat refuses as attachments,
   are what a quick ask is for: they go to the model (`QuickAskModel.acceptText`), which types them
   into the field, or attaches them as a text file when there are too many to type.
   */
  @MainActor
  enum QuickAskDrop {
    /// The types a drag is asked for: what a chat takes, and words and links.
    static let types: [UTType] = AttachmentIntake.dropTypes + [.text, .url]

    // MARK: Routes

    /// Decided from the type identifiers an item offers and nothing else, so a test needs no pasteboard.
    nonisolated static func kind(forTypeIdentifiers identifiers: [String]) -> QuickAskDropKind {
      if AttachmentIntake.route(forTypeIdentifiers: identifiers) != .unsupported {
        return .attachment
      }

      let known = identifiers.compactMap { UTType($0) }

      return known.contains { $0.conforms(to: .text) || $0.conforms(to: .url) } ? .words : .ignored
    }

    nonisolated static func kind(of provider: NSItemProvider) -> QuickAskDropKind {
      kind(forTypeIdentifiers: provider.registeredTypeIdentifiers)
    }

    // MARK: Taking a drop

    /// Hand what was dropped to the quick ask. Nothing is taken while there is no chat to take it
    /// (no gateway, or none signed in): the receipt says so with zeros.
    @discardableResult
    static func take(_ providers: [NSItemProvider], into model: QuickAskModel) -> QuickAskDropReceipt {
      guard let tray = model.composer?.tray else {
        return QuickAskDropReceipt(attached: 0, words: 0, finished: Task {})
      }

      var attachable: [NSItemProvider] = []
      var worded: [NSItemProvider] = []

      for provider in providers {
        switch kind(of: provider) {
        case .attachment: attachable.append(provider)
        case .words: worded.append(provider)
        case .ignored: break
        }
      }

      var tasks: [Task<Void, Never>] = []

      if !attachable.isEmpty {
        tasks.append(AttachmentIntake.addDropped(attachable, to: tray).finished)
      }

      for provider in worded {
        tasks.append(
          Task {
            if let text = await words(of: provider) {
              model.acceptText(text)
            }
          })
      }

      let started = tasks

      return QuickAskDropReceipt(
        attached: attachable.count, words: worded.count,
        finished: Task {
          for task in started {
            await task.value
          }
        })
    }

    /// The words a provider holds: its text, else its link written out.
    private static func words(of provider: NSItemProvider) async -> String? {
      if provider.canLoadObject(ofClass: NSString.self) {
        let text: String? = await withCheckedContinuation { continuation in
          _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            continuation.resume(returning: object as? String)
          }
        }

        if let text {
          return text
        }
      }

      if provider.canLoadObject(ofClass: URL.self) {
        return await withCheckedContinuation { continuation in
          _ = provider.loadObject(ofClass: URL.self) { url, _ in
            continuation.resume(returning: url?.absoluteString)
          }
        }
      }

      return nil
    }
  }

  /// Dragging over the quick ask: the same hint and the same way out of it as over a chat.
  private struct QuickAskDropDelegate: DropDelegate {
    let model: QuickAskModel
    @Binding var state: AttachmentDropState

    private var accepts: Bool { model.composer != nil }

    func validateDrop(info: DropInfo) -> Bool {
      accepts
        && info.itemProviders(for: QuickAskDrop.types).contains { QuickAskDrop.kind(of: $0) != .ignored }
    }

    func dropEntered(info: DropInfo) {
      state.entered(blocked: !accepts)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
      state.updated(blocked: !accepts)
      return DropProposal(operation: accepts ? .copy : .forbidden)
    }

    func dropExited(info: DropInfo) {
      state.exited()
    }

    func performDrop(info: DropInfo) -> Bool {
      state.dropped()

      guard accepts else {
        return false
      }

      let receipt = QuickAskDrop.take(info.itemProviders(for: QuickAskDrop.types), into: model)

      return receipt.attached + receipt.words > 0
    }
  }

  private struct QuickAskDropTarget: ViewModifier {
    let model: QuickAskModel

    @State private var state = AttachmentDropState()

    func body(content: Content) -> some View {
      content
        .overlay {
          if state.hint != nil {
            RoundedRectangle(cornerRadius: 16)
              .strokeBorder(.tint, style: StrokeStyle(lineWidth: 2, dash: [8, 5]))
              .background(.regularMaterial.opacity(0.9), in: .rect(cornerRadius: 16))
              .overlay {
                Label(NativeStrings.QuickAsk.drop, systemImage: "square.and.arrow.down")
                  .font(.callout.weight(.semibold))
                  .padding(.horizontal, 16)
                  .padding(.vertical, 10)
                  .background(.thinMaterial, in: .capsule)
              }
              .padding(4)
              .allowsHitTesting(false)
              .accessibilityHidden(true)
          }
        }
        .onDrop(of: QuickAskDrop.types, delegate: QuickAskDropDelegate(model: model, state: $state))
        // The safety net of the chat's drop target: a drag that ended without saying so ends the hint.
        .task(id: state.hint != nil) {
          guard state.hint != nil else {
            return
          }

          while !Task.isCancelled {
            try? await Task.sleep(for: AttachmentDropSession.pollInterval)
            state.tick(dragIsLive: AttachmentDropSession.isLive)
          }
        }
        .onDisappear { state.lost() }
    }
  }

  extension View {
    /// The whole of this view takes dropped files, pictures and words into the quick ask.
    func quickAskDropTarget(model: QuickAskModel) -> some View {
      modifier(QuickAskDropTarget(model: model))
    }
  }
#endif
