import HermieCore
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
  import AppKit
#endif

/// Which road a dragged item takes to become a staged file, decided from the type identifiers its
/// provider offers and nothing else (so a test needs no pasteboard, only the identifiers).
enum AttachmentDropRoute: Equatable, Sendable {
  /// A file in place (the Finder, a file in another app's window): its URL is read and the file is
  /// copied in, inside its security scope.
  case fileURL
  /// Content with no file behind it, or a file the sender promises (Photos, a browser, Mail): asked
  /// for as a file by this type, and copied inside the callback that is given it.
  case representation(UTType)
  /// Words, a link, anything else that is not a file or a picture.
  case unsupported
}

/// What the chat shows while something is dragged over it.
enum AttachmentDropHint: Equatable {
  /// A file or a picture: "Drop to attach".
  case attach
  /// A file or a picture, but a request has the composer (HERM-251): nothing can be attached now.
  case blocked
}

/// What a drag over the chat is answered with.
enum AttachmentDropGate {
  enum Verdict: Equatable {
    /// Words or a link: the chat does not react at all.
    case notAnAttachment
    /// Files or pictures: they will be staged.
    case accept
    /// Files or pictures, while a request has the composer: shown, and refused with the reason.
    case blocked
  }

  /// `attachable` is how many of the dragged items could become an attachment; `blocked` is
  /// whether a request covers the composer.
  static func verdict(attachable: Int, blocked: Bool) -> Verdict {
    guard attachable > 0 else {
      return .notAnAttachment
    }

    return blocked ? .blocked : .accept
  }
}

/// Whether a drag is over the chat, and what it is told: the single source of truth for the overlay.
///
/// SwiftUI's `DropDelegate` has no "the drag is over" callback: a drop, a refused drop, a drag that
/// is cancelled with Esc or that another view takes over each end it in a different way, and none of
/// them is promised an exit. So the overlay is never left to the next callback: every way a drag
/// can end clears it here, and a drag that has ended is not brought back by an update that arrives
/// late (`updated` does nothing until the next `entered`).
struct AttachmentDropState: Equatable {
  /// What the overlay shows; nil when it is hidden.
  private(set) var hint: AttachmentDropHint?
  /// A drag that was entered and has not ended.
  private var dragging = false

  /// A drag came over the chat.
  mutating func entered(blocked: Bool) {
    dragging = true
    hint = blocked ? .blocked : .attach
  }

  /// The drag moved on over the chat (or a request took the composer meanwhile).
  mutating func updated(blocked: Bool) {
    guard dragging else {
      return
    }

    hint = blocked ? .blocked : .attach
  }

  /// The drag left (or another view took it over, or it was cancelled).
  mutating func exited() {
    end()
  }

  /// The drag was dropped here, taken or refused.
  mutating func dropped() {
    end()
  }

  /// The drag is not going on any more, whatever was last heard of it (the safety net's reset).
  mutating func lost() {
    end()
  }

  /// One tick of the safety net: `live` is whether the system still has a drag going.
  mutating func tick(dragIsLive live: Bool) {
    if !live {
      end()
    }
  }

  private mutating func end() {
    dragging = false
    hint = nil
  }
}

/// Whether the system still has a drag going, for the safety net that hides the overlay when no
/// callback said the drag ended.
enum AttachmentDropSession {
  /// A drag lasts as long as the pointer's button is held, on the Mac whichever app it is dragged
  /// from. Elsewhere there is nothing to ask, and the callbacks are all there is.
  @MainActor static var isLive: Bool {
    #if os(macOS)
      NSEvent.pressedMouseButtons & 1 != 0
    #else
      true
    #endif
  }

  /// How often the safety net looks.
  static let pollInterval: Duration = .milliseconds(250)
}

/// What came of handing a drop to the tray.
struct AttachmentDropReceipt {
  /// Items that were set on their way to a chip that can become a file.
  var accepted: Int
  /// Items that were refused at once (words, a link): each is a failed chip that says so.
  var refused: Int
  /// Done when every accepted item has been copied in (or has failed to be).
  var finished: Task<Void, Never>
}

extension AttachmentIntake {
  /// The types a drag over the chat is asked for: a file, a picture, or any other content.
  static let dropTypes: [UTType] = [.fileURL, .image, .item]

  /// What the system names a file a sender promises to write when it is asked for.
  nonisolated static let filePromiseType = "com.apple.NSFilePromiseItemProvider"

  // MARK: Routes

  nonisolated static func route(forTypeIdentifiers identifiers: [String]) -> AttachmentDropRoute {
    if identifiers.contains(UTType.fileURL.identifier) {
      return .fileURL
    }

    let types = identifiers.compactMap { UTType($0) }

    // A file of its own format first: a PDF, an archive, a document. The picture a sender adds next
    // to it (a preview of the first page, its icon) is a rendering of the file, not the file.
    if let content = types.first(where: { isFileContent($0) && !$0.conforms(to: .image) && !DroppedFileType.isCatchAll($0) }) {
      return .representation(content)
    }

    if let image = types.first(where: { $0.conforms(to: .image) }) {
      return .representation(image)
    }

    if let content = types.first(where: isFileContent) {
      return .representation(content)
    }

    // A promised file whose own type is not declared: asked for as an item, which the sender writes.
    if identifiers.contains(filePromiseType) {
      return .representation(.item)
    }

    return .unsupported
  }

  nonisolated static func route(for provider: NSItemProvider) -> AttachmentDropRoute {
    route(forTypeIdentifiers: provider.registeredTypeIdentifiers)
  }

  /// Whether a dragged item is a file or a picture, as opposed to words or a link, which the chat
  /// does not take as an attachment.
  nonisolated static func isAttachable(_ provider: NSItemProvider) -> Bool {
    route(for: provider) != .unsupported
  }

  private nonisolated static func isFileContent(_ type: UTType) -> Bool {
    type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .url)
  }

  // MARK: Reading what was dropped

  /// Dropped on the chat. A file URL (the Mac's Finder, files in place) is copied as a picked file
  /// is; anything else (a file from the Files app on an iPad, a picture dragged out of a page or
  /// Photos) is asked for as a file by its own type, and copied inside the callback that is given it.
  ///
  /// At once, in the order given: one chip each. What cannot be attached is a failed chip that says
  /// why, so nothing the reader dropped vanishes without a word.
  @discardableResult
  static func addDropped(_ providers: [NSItemProvider], to tray: AttachmentTray) -> AttachmentDropReceipt {
    let routed = providers.map { ($0, route(for: $0)) }
    let ids = tray.prepare(
      routed.map { provider, route in
        let name = provider.suggestedName ?? NativeStrings.Composer.Attach.item

        return (name, route == .fileURL ? .file : kind(ofFileNamed: name))
      })
    var tasks: [Task<Void, Never>] = []
    var refused = 0

    for (id, (provider, route)) in zip(ids, routed) {
      if route == .unsupported {
        refused += 1
        tray.provide(id, .failure(.unsupported(.notAttachable)))
        continue
      }

      tasks.append(
        Task {
          let result = await stage(dropped: provider, route: route)

          tray.provide(id, result)
        })
    }

    let started = tasks

    return AttachmentDropReceipt(
      accepted: started.count, refused: refused,
      finished: Task {
        for task in started {
          await task.value
        }
      })
  }

  private static func stage(dropped provider: NSItemProvider, route: AttachmentDropRoute) async -> Staged {
    switch route {
    case .fileURL:
      // Not asked for as a file by its type as a second road: for a file URL the system answers
      // that with a file holding the URL's own text, which would be attached as if it were the file.
      guard let url = await fileURL(of: provider) else {
        return .failure(.unreadable(message: "The dropped file's location could not be read."))
      }

      return await Task.detached(priority: .userInitiated) {
        staged { () throws(StagingFailure) in
          try AttachmentStaging.stage(copying: url, mimeType: mimeType(forFileNamed: url.lastPathComponent))
        }
      }.value
    case .representation(let type):
      return await file(of: provider, as: type)
    case .unsupported:
      return .failure(.unsupported(.notAttachable))
    }
  }

  /// The file URL a provider holds. Asked for as a URL first, which is what hands a sandboxed app
  /// the right to read the file; as the raw item second.
  private static func fileURL(of provider: NSItemProvider) async -> URL? {
    let object: URL? = await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: URL.self) { url, _ in
        continuation.resume(returning: url.flatMap(resolved))
      }
    }

    if let object {
      return object
    }

    return await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
        continuation.resume(returning: fileURL(fromItem: item))
      }
    }
  }

  /// The file URL in what `loadItem` gave: a URL, the data of one, or its text.
  nonisolated static func fileURL(fromItem item: Any?) -> URL? {
    switch item {
    case let url as URL:
      return resolved(url)
    case let data as Data:
      return URL(dataRepresentation: data, relativeTo: nil, isAbsolute: true).flatMap(resolved)
    case let text as String:
      return URL(string: text).flatMap(resolved)
    default:
      return nil
    }
  }

  /// A file URL as a path: `file:///.file/id=…` (a file reference, which the Finder can hand over)
  /// is turned into the path it stands for. Anything that is not a file URL is nothing.
  nonisolated static func resolved(_ url: URL) -> URL? {
    guard url.isFileURL else {
      return nil
    }

    return (url as NSURL).filePathURL ?? url
  }

  /// The provider's own copy of its item, which is only there inside the callback: copied in it.
  ///
  /// What the item is comes from the file (`DroppedFileType`), not from the type it was asked for:
  /// a sender that answers with a catch-all type and no name still gives its PDF a name and a
  /// type that say PDF.
  private static func file(of provider: NSItemProvider, as type: UTType) async -> Staged {
    let suggested = provider.suggestedName

    return await withCheckedContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
        guard let url else {
          let message = (error.map { ($0 as NSError).localizedDescription }) ?? "The item could not be read."
          continuation.resume(returning: .failure(.unreadable(message: message)))
          return
        }

        let head = (try? FileHandle(forReadingFrom: url)).flatMap { handle -> Data? in
          defer { try? handle.close() }
          return try? handle.read(upToCount: DroppedFileType.headLength)
        }
        let copyName = url.lastPathComponent
        let resolved = DroppedFileType.resolve(declared: type, names: [suggested, copyName], head: head ?? Data())
        let name = DroppedFileType.name(suggested: suggested, fileName: copyName, resolved: resolved)

        continuation.resume(
          returning: staged { () throws(StagingFailure) in
            try AttachmentStaging.stage(
              copying: url, name: name, mimeType: resolved?.preferredMIMEType ?? mimeType(forFileNamed: name))
          })
      }
    }
  }
}

/// Dragging a file or a picture over the chat: the hint shows for those, and not for words.
///
/// A drag that carries attachments is accepted into `validateDrop` even while a request has the
/// composer, so the chat can say why nothing is taken (`AttachmentDropHint.blocked`); the drop itself
/// is then refused in `dropUpdated` and, as a second lock, in `performDrop`.
struct AttachmentDropDelegate: DropDelegate {
  let tray: AttachmentTray
  let isBlocked: @MainActor () -> Bool
  @Binding var state: AttachmentDropState

  private func verdict(_ info: DropInfo) -> AttachmentDropGate.Verdict {
    let providers = info.itemProviders(for: AttachmentIntake.dropTypes)

    return AttachmentDropGate.verdict(
      attachable: providers.filter(AttachmentIntake.isAttachable).count, blocked: isBlocked())
  }

  func validateDrop(info: DropInfo) -> Bool {
    verdict(info) != .notAnAttachment
  }

  func dropEntered(info: DropInfo) {
    state.entered(blocked: isBlocked())
  }

  func dropUpdated(info: DropInfo) -> DropProposal? {
    let blocked = isBlocked()

    state.updated(blocked: blocked)

    return DropProposal(operation: blocked ? .forbidden : .copy)
  }

  func dropExited(info: DropInfo) {
    state.exited()
  }

  func performDrop(info: DropInfo) -> Bool {
    // SwiftUI does not call `dropExited` after a drop: the overlay goes here, taken or refused.
    state.dropped()

    guard verdict(info) == .accept else {
      return false
    }

    AttachmentIntake.addDropped(info.itemProviders(for: AttachmentIntake.dropTypes), to: tray)
    return true
  }
}

/// "Drop to attach" over a chat while a file hovers on it, or why nothing will be taken.
struct AttachmentDropOverlay: View {
  let hint: AttachmentDropHint?

  var body: some View {
    if let hint {
      let blocked = hint == .blocked

      RoundedRectangle(cornerRadius: 24)
        .strokeBorder(
          blocked ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint),
          style: StrokeStyle(lineWidth: 2, dash: [8, 5])
        )
        .background(.regularMaterial.opacity(0.9), in: .rect(cornerRadius: 24))
        .overlay {
          Label(
            Self.text(for: hint), systemImage: blocked ? "lock" : "paperclip"
          )
          .font(.callout.weight(.semibold))
          .foregroundStyle(.primary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 20)
          .padding(.vertical, 12)
          .background(.thinMaterial, in: .capsule)
          .padding(24)
        }
        .padding(6)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
  }

  static func text(for hint: AttachmentDropHint) -> String {
    switch hint {
    case .attach: NativeStrings.Composer.Attach.drop
    case .blocked: NativeStrings.Composer.Attach.dropBlocked
    }
  }
}

/// Makes the whole view a place to drop files and pictures: they are staged in `tray`, as the plus
/// button's are. Not while `isBlocked` says a request has the composer (HERM-251): the drag is shown,
/// and refused with the reason.
struct AttachmentDropTarget: ViewModifier {
  let tray: AttachmentTray
  let isBlocked: @MainActor () -> Bool

  @State private var state = AttachmentDropState()

  func body(content: Content) -> some View {
    // No animation on the overlay: a drag ends inside the system's drag loop, and a fade that has to
    // run there is one more way for it to stay.
    content
      .overlay { AttachmentDropOverlay(hint: state.hint) }
      .onDrop(of: AttachmentIntake.dropTypes, delegate: AttachmentDropDelegate(tray: tray, isBlocked: isBlocked, state: $state))
      .onChange(of: state.hint) { _, hint in
        if let hint {
          AccessibilityNotification.Announcement(AttachmentDropOverlay.text(for: hint)).post()
        }
      }
      // The safety net: while the overlay is up, look whether the drag is still going, and hide the
      // overlay when it is not, whatever the callbacks did or did not say.
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
  /// The whole of this view takes dropped files and pictures into `tray`.
  func attachmentDropTarget(tray: AttachmentTray, isBlocked: @escaping @MainActor () -> Bool) -> some View {
    modifier(AttachmentDropTarget(tray: tray, isBlocked: isBlocked))
  }
}
