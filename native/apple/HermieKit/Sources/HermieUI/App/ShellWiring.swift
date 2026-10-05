import Foundation
import HermieCore
import HermieShared

extension LiveWiring {
  /**
   The app's wiring, built in the shell's `App` initialiser beside `LiveGateway`: push attached to
   the system's delegates and to its delivered notifications, the system surfaces over the App
   Group (none without the entitlement, or in a UI test's launch), passkeys through the system
   passkey sheet for every session the live gateway builds, and everything started.
   */
  @MainActor
  public static func app(launch: AppLaunch, accounts: GatewayAccounts, live: LiveGateway) -> LiveWiring {
    launch.passkey = launch.passkey ?? .app(launch: launch, services: accounts.services)
    launch.push.deliveredNotifications = SystemDeliveredNotifications()
    PushInbox.shared.attach(launch.push)

    let surfaces = launch.environment.appGroupContainer == nil ? nil : SystemSurfaces.live(copy: .localized)
    // What a bot asks while the app is not in front is also a local notification: the permission is
    // the onboarding's to ask for, and a confirmation bounces the Dock icon once on the Mac.
    // Everything that waits for the person, in one list: its count is also what the notifications' badge says.
    let inbox = NeedsYouInbox()
    let alerts = RequestAlerts(
      push: launch.push,
      center: SystemLocalNotifications(),
      copy: .localized,
      requestDockAttention: { DockAttention.bounce() },
      // The Focus filter the person set for the Focus that is on, written by the app's Focus filter
      // intent into the App Group; none when the container is not there or nothing is stored.
      focusFilter: { FocusFilterStore.system()?.load() ?? .unfiltered },
      badgeCount: { inbox.count }
    )

    // A day's use that reaches the limit the reader set is a local notification too, while the app runs.
    // It is posted only where notifications are allowed and switched on, and names the bot that used the
    // most only where the reader allowed previews.
    let push = launch.push
    let usageAlerts = UsageAlertMonitor(
      center: SystemLocalNotifications(),
      settings: launch.usageAlerts,
      keyValues: launch.keyValues,
      copy: .localized,
      allowed: { push.permission == .granted && push.enabled },
      namesBots: { push.preferences.preview }
    )

    let wiring = LiveWiring(
      launch: launch, accounts: accounts, live: live, surfaces: surfaces, alerts: alerts, inbox: inbox,
      usageAlerts: usageAlerts)

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
      },
      queued: { bot in
        String(
          localized: "native.intents.queued",
          defaultValue: "\(bot) is still answering an earlier message. Yours is queued in Hermie and goes out when that answer is done.",
          table: "Native",
          bundle: .module
        )
      },
      withdrawn: String(
        localized: "native.intents.withdrawn",
        defaultValue: "The message was taken back out of the queue in Hermie before it went out, so nothing was sent.",
        table: "Native",
        bundle: .module
      )
    )
  }
}
