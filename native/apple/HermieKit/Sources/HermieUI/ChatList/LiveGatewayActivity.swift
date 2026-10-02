import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/**
 Feeds the app's trips to the background to the live gateway: on iPhone and iPad the session writes
 its chats and closes its socket when the app leaves the screen, inside a background-task assertion
 so the writes finish, and dials again when it comes back. The Mac keeps its connection while a
 window is hidden, as a desktop chat client does.

 App-wide, not per window; installed once, by the first window.
 */
@MainActor
enum LiveGatewayActivity {
  private static var observers: [NSObjectProtocol] = []

  static func follow(_ live: LiveGateway) {
    #if os(iOS)
      guard observers.isEmpty else {
        return
      }

      let center = NotificationCenter.default

      observers = [
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
          MainActor.assumeIsolated {
            let assertion = BackgroundAssertion()

            assertion.id = UIApplication.shared.beginBackgroundTask(withName: "hermie.gateway.background") {
              assertion.end()
            }

            Task { @MainActor in
              await live.enterBackground()
              assertion.end()
            }
          }
        },
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
          MainActor.assumeIsolated {
            let coming = Task { @MainActor in await live.enterForeground() }
            _ = coming
          }
        }
      ]
    #endif
  }
}

#if os(iOS)
  /// One background-task assertion, ended once, by whichever comes first: the work or the expiry.
  @MainActor
  private final class BackgroundAssertion {
    var id = UIBackgroundTaskIdentifier.invalid

    func end() {
      guard id != .invalid else { return }
      UIApplication.shared.endBackgroundTask(id)
      id = .invalid
    }
  }
#endif
