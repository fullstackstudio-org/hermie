import Foundation
import HermieCore
import HermieShared

extension LiveWiring {
  /**
   The app's wiring, built in the shell's `App` initialiser beside `LiveGateway`: push attached to
   the system's delegates and to its delivered notifications, the system surfaces over the App
   Group (none without the entitlement, or in a UI test's launch), and everything started.
   */
  @MainActor
  public static func app(launch: AppLaunch, accounts: GatewayAccounts, live: LiveGateway) -> LiveWiring {
    launch.push.deliveredNotifications = SystemDeliveredNotifications()
    PushInbox.shared.attach(launch.push)

    let surfaces = launch.environment.appGroupContainer == nil ? nil : SystemSurfaces.live(copy: .localized)
    let wiring = LiveWiring(launch: launch, accounts: accounts, live: live, surfaces: surfaces)

    wiring.start()
    return wiring
  }
}

extension SurfaceCopy {
  /// The surfaces' sentences in the reader's language.
  public static var localized: SurfaceCopy {
    SurfaceCopy(
      shareTargets: ShareTargets.Copy(
        sent: Strings.App.Share.sentTo(bot: ShareTargets.botPlaceholder),
        queued: Strings.App.Share.willSendLater,
        sending: Strings.App.Share.sending
      ),
      intentFailures: .localized,
      stillWorking: { bot in
        String(
          localized: "native.intents.stillWorking",
          defaultValue: "\(bot) is still working. The message was sent: open Hermie to read the reply, or use “Send to” for prompts that take a while.",
          table: "Native",
          bundle: .module
        )
      },
      botNotHere: { bot in
        String(
          localized: "native.intents.botNotHere",
          defaultValue: "\(bot) is not on the gateway Hermie is connected to, so nothing was sent.",
          table: "Native",
          bundle: .module
        )
      },
      notSent: { reason in
        String(
          localized: "native.composer.failed",
          defaultValue: "The message did not go out: \(reason)",
          table: "Native",
          bundle: .module
        )
      }
    )
  }
}
