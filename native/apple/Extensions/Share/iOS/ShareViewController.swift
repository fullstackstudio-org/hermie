import SwiftUI
import UIKit

/**
 The share extension's entry point on iPhone and iPad: host the sheet, and do the two things only a
 view controller can — open the app, and finish the extension request. Everything else is
 `HermieShareSession`, which the Mac's controller hosts as well.

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
        openApp: { [weak self] url in self?.openApp(url) },
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

  /**
   Open the app from inside an extension.

   `UIApplication.shared` is unavailable to an extension, so the application object is reached by
   walking the responder chain and asked through a selector. This is the long-standing idiom rather
   than a supported API, and the honest position is written here rather than assumed: if it stops
   working, the entry is STILL in the outbox and the app still delivers it at its next launch. The
   only thing lost is the immediacy, which is why nothing branches on the result.

   The selector is built by name because the method it names is not one this target can reference:
   `UIApplication.open(_:options:completionHandler:)` is marked unavailable in an extension.
   */
  private func openApp(_ url: URL) {
    let selector = NSSelectorFromString("openURL:")
    var responder: UIResponder? = self

    while let current = responder {
      if current.responds(to: selector) {
        current.perform(selector, with: url)

        return
      }

      responder = current.next
    }
  }
}
