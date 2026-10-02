import SwiftUI
import UIKit

/**
 The share extension's entry point on iPhone and iPad: host the sheet, and finish the extension
 request. Everything else is `HermieShareSession`, which the Mac's controller hosts as well.

 It does not open the app. An extension on iPhone and iPad has no supported way to, and the old
 responder-chain idiom does nothing since iOS 18; a queued share says it goes when Hermie next
 opens, and the app delivers it then.

 `@objc(ShareViewController)` is load-bearing. `Info.plist` names the principal class as a plain
 string and the loader looks it up in the Objective-C runtime; without the attribute a Swift class
 is registered under its module-qualified name, the lookup finds nothing, and the share sheet
 presents an empty panel with no error in any log.
 */
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private var session: HermieShareSession?

  override func viewDidLoad() {
    super.viewDidLoad()

    let session = HermieShareSession(
      host: HermieShareSession.Host(
        openApp: nil,
        complete: { [weak self] in self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil) },
        cancel: { [weak self] code in
          self?.extensionContext?.cancelRequest(withError: NSError(domain: "dev.hermie.app.share", code: code))
        }
      )
    )

    self.session = session

    // Before the sheet is drawn, so the loads and the first frame overlap rather than queue: the
    // roster is one small file, and the attachments are what anyone waits for.
    session.load(extensionContext?.inputItems ?? [])

    let controller = UIHostingController(rootView: HermieShareSheet(session: session))

    addChild(controller)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(controller.view)
    controller.didMove(toParent: self)
  }
}
