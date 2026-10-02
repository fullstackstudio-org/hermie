import AppKit
import SwiftUI

/**
 The share extension's entry point on the Mac: the same sheet and the same steps as on iPhone and
 iPad (`HermieShareSession`), hosted by AppKit.

 `@objc(ShareViewController)` is load-bearing for the same reason as on iOS: `Info.plist` names the
 principal class as a plain string, and a Swift class without the attribute is registered under its
 module-qualified name, which the loader never finds.

 The Mac presents a share extension as a sheet sized by the controller, so the controller states a
 size; the sheet's own list scrolls inside it.
 */
@objc(ShareViewController)
final class ShareViewController: NSViewController {
  private var session: HermieShareSession?

  override func loadView() {
    let session = HermieShareSession(
      host: HermieShareSession.Host(
        openApp: { url in NSWorkspace.shared.open(url) },
        complete: { [weak self] in self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil) },
        cancel: { [weak self] code in
          self?.extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: code))
        }
      )
    )

    self.session = session

    let hosting = NSHostingView(rootView: HermieShareSheet(session: session))

    hosting.frame = NSRect(x: 0, y: 0, width: 380, height: 460)
    view = hosting
    preferredContentSize = hosting.frame.size
  }

  override func viewDidLoad() {
    super.viewDidLoad()

    // The context is attached by the time the view has loaded; the attachments start loading now
    // and "Send" waits for them.
    session?.load(extensionContext?.inputItems ?? [])
  }
}
