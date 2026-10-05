#if os(macOS)
  import AppKit
  import HermieCore

  /**
   What the Services menu's "Send to Hermie" handed over, read from the pasteboard the system
   prepared: the files selected in the Finder, else the selected text.

   Files win: a Finder selection can offer its names as text as well, and the files are what was meant.
   */
  enum QuickAskServiceInput {
    @MainActor
    static func handoff(from pasteboard: NSPasteboard) -> QuickAskHandoff? {
      let files =
        (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []

      return QuickAskHandoff.service(text: files.isEmpty ? pasteboard.string(forType: .string) : nil, files: files)
    }
  }

  /**
   The app's Services provider (`NSServices` in Info.plist, message `sendToHermie`): "Send to Hermie"
   for the text or the files selected in any app. It opens the quick ask with them in it and the bot
   picker focused, so the person says who gets them.
   */
  @MainActor
  final class QuickAskServicesProvider: NSObject {
    private let present: @MainActor (QuickAskHandoff) -> Void

    init(present: @escaping @MainActor (QuickAskHandoff) -> Void) {
      self.present = present
    }

    /// The message the service names in Info.plist. A pasteboard with nothing to send is ignored: the
    /// system shows its own failure when `error` is set, and there is nothing the person can do about an empty selection.
    @objc(sendToHermie:userData:error:)
    func sendToHermie(
      _ pasteboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>
    ) {
      guard let handoff = QuickAskServiceInput.handoff(from: pasteboard) else {
        return
      }

      present(handoff)
    }
  }
#endif
