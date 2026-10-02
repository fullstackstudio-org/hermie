import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

/**
 A view you can drop files onto.

 React Native has no drop event on any platform it ships, and a "Designed for iPad" app on a Mac is
 the one place where that absence is loud: the window has a Finder behind it, and dragging a file
 onto a chat is how every desktop messenger takes an attachment. `UIDropInteraction` is the UIKit
 answer, and it is the same interaction on an iPad — Split View, Stage Manager, a drag out of Files —
 so this is not a Mac shim. On an iPhone there is no drag session to receive, and the interaction
 simply never fires.

 ## What it accepts, and what it does with it

 `UTType.item` is the root of the type tree, so "an item whose type conforms to item" is every file
 there is — which is what the composer takes. `.image` and `.fileURL` are named alongside it because a
 drag out of a photo app or a browser advertises one of those and not always a file, and a provider
 that offers only an in-memory image would otherwise be refused.

 Every item is copied into the app's own tmp directory before JavaScript hears about it, and that
 copy is load-bearing rather than tidy: `loadFileRepresentation` hands back a URL that is deleted the
 moment its completion handler returns, and the upload this feeds starts several turns later.

 ## Three events, not one

 `onDropEnter` and `onDropExit` exist so the composer can show the reader that the window will take
 what they are holding. A drop target with no feedback is one a person tries twice.

 `onDrop` carries `{files: [{uri, name, size, mimeType}]}` — the same four fields the document picker
 produces, so the JavaScript side feeds the pipeline it already had rather than growing a second one.
 A drop whose items ALL fail to load emits nothing: an empty list would look like a successful drop
 of nothing at all.
 */
public final class HermieDropView: ExpoView, UIDropInteractionDelegate {
  private let onDrop = EventDispatcher()
  private let onDropEnter = EventDispatcher()
  private let onDropExit = EventDispatcher()

  private var enabled = true

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    addInteraction(UIDropInteraction(delegate: self))
  }

  func setEnabled(_ value: Bool) {
    enabled = value
  }

  public func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
    guard enabled else {
      return false
    }

    return session.items.contains { item in
      let provider = item.itemProvider

      return provider.hasItemConformingToTypeIdentifier(UTType.item.identifier)
        || provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        || provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    }
  }

  public func dropInteraction(
    _ interaction: UIDropInteraction,
    sessionDidUpdate session: UIDropSession
  ) -> UIDropProposal {
    // Copy, never move: the file belongs to whatever the reader dragged it out of, and a drop that
    // emptied a Finder folder would be the worst possible surprise.
    UIDropProposal(operation: enabled ? .copy : .cancel)
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnter session: UIDropSession) {
    onDropEnter()
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidExit session: UIDropSession) {
    onDropExit()
  }

  public func dropInteraction(_ interaction: UIDropInteraction, sessionDidEnd session: UIDropSession) {
    // Both the cancelled drag and the completed one land here, and the highlight has to come off for
    // either. `performDrop` has already run for the completed one, so this cannot swallow a drop.
    onDropExit()
  }

  public func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
    let group = DispatchGroup()
    let lock = NSLock()
    // Indexed rather than appended, so the order the reader dropped them in survives loads that
    // finish out of order.
    var collected: [Int: [String: Any]] = [:]

    for (index, item) in session.items.enumerated() {
      let provider = item.itemProvider

      group.enter()

      provider.loadFileRepresentation(forTypeIdentifier: UTType.item.identifier) { url, _ in
        defer { group.leave() }

        guard let url, let copied = Self.copyToTemporaryDirectory(url, suggested: provider.suggestedName) else {
          return
        }

        lock.lock()
        collected[index] = copied
        lock.unlock()
      }
    }

    group.notify(queue: .main) { [weak self] in
      let files = collected.keys.sorted().compactMap { collected[$0] }

      guard let self, !files.isEmpty else {
        return
      }

      self.onDrop(["files": files])
    }
  }

  /**
   Copy one dropped file somewhere it will still exist when the upload gets to it.

   The name is kept where the provider gave one, because it is what the composer's chip shows and
   what the prompt ends up referring to. The directory is per drop so two files called `notes.txt`
   from two folders cannot overwrite each other, which a flat tmp directory would let them do.
   */
  private static func copyToTemporaryDirectory(_ source: URL, suggested: String?) -> [String: Any]? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-drop", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)

    let name = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? source.lastPathComponent
    let destination = directory.appendingPathComponent(name)

    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: source, to: destination)
    } catch {
      // A file this process cannot read is not an error worth throwing into a drag gesture: the
      // other items in the same drop still arrive, and a refused one simply does not.
      return nil
    }

    let size = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? Int) ?? nil
    let mimeType = UTType(filenameExtension: destination.pathExtension)?.preferredMIMEType

    return [
      "uri": destination.absoluteString,
      "name": name,
      "size": size ?? 0,
      "mimeType": mimeType ?? "application/octet-stream"
    ]
  }
}
