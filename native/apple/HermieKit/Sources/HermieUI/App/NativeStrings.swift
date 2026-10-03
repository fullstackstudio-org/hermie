import Foundation

/**
 The strings only the native shell has, read from `Resources/Native.xcstrings` (written by hand, in
 English, Dutch and German). A sentence the Expo app also shows belongs in the TypeScript catalogues
 and is read through `Strings` instead.
 */
enum NativeStrings {
  enum About {
    /// Build
    static var build: String { String(localized: "native.about.build", table: "Native", bundle: .module) }
    /// Commit
    static var commit: String { String(localized: "native.about.commit", table: "Native", bundle: .module) }
  }

  enum ConnectionRequest {
    /// Connect an account to continue
    static var title: String { String(localized: "native.connectionRequest.title", table: "Native", bundle: .module) }
    /// Open
    static var open: String { String(localized: "native.connectionRequest.open", table: "Native", bundle: .module) }
    /// Skip
    static var skip: String { String(localized: "native.connectionRequest.skip", table: "Native", bundle: .module) }
  }

  enum Identity {
    /// You are anonymous on this gateway: your messages carry no name.
    static var anonymous: String {
      String(localized: "native.identity.anonymous", table: "Native", bundle: .module)
    }
  }

  enum Chat {
    /// Copy diagnostics (the chat title's hidden long press, and its accessibility action)
    static var copyDiagnostics: String {
      String(localized: "native.chat.copyDiagnostics", table: "Native", bundle: .module)
    }
    /// Copied (in the title's subtitle place for a moment after the diagnostics were copied)
    static var diagnosticsCopied: String {
      String(localized: "native.chat.diagnosticsCopied", table: "Native", bundle: .module)
    }
  }

  enum ChatList {
    /// Sign in to this gateway to see its chats.
    static var signedOut: String {
      String(localized: "native.chatList.signedOut", table: "Native", bundle: .module)
    }
    /// Now (a row's time, under a minute old)
    static var now: String {
      String(localized: "native.chatList.now", table: "Native", bundle: .module)
    }
    /// Archived
    static var archivedTitle: String {
      String(localized: "native.chatList.archivedTitle", table: "Native", bundle: .module)
    }
    /// Mute {name}
    static func muteTitle(name: String) -> String {
      String(localized: "native.chatList.muteTitle", defaultValue: "Mute \(name)", table: "Native", bundle: .module)
    }
  }

  enum Commands {
    /// Chat
    static var chatMenu: String { String(localized: "native.commands.chatMenu", table: "Native", bundle: .module) }
    /// Find…
    static var find: String { String(localized: "native.commands.find", table: "Native", bundle: .module) }
    /// New Chat Window
    static var newChatWindow: String {
      String(localized: "native.commands.newChatWindow", table: "Native", bundle: .module)
    }
    /// Switch Gateway…
    static var switchGateway: String {
      String(localized: "native.commands.switchGateway", table: "Native", bundle: .module)
    }
  }

  enum Debug {
    /// Debug screens
    static var title: String { String(localized: "native.debug.title", table: "Native", bundle: .module) }
  }

  enum Detail {
    enum NoChat {
      /// Choose a bot from the list.
      static var body: String { String(localized: "native.detail.noChat.body", table: "Native", bundle: .module) }
      /// No chat selected
      static var title: String { String(localized: "native.detail.noChat.title", table: "Native", bundle: .module) }
    }
  }

  enum Gateways {
    /// Rename
    static var rename: String { String(localized: "native.gateways.rename", table: "Native", bundle: .module) }

    enum RemoveFailed {
      /// Not Removed
      static var title: String { String(localized: "native.gateways.removeFailed.title", table: "Native", bundle: .module) }
      /// This gateway is no longer synced with iCloud Keychain, so it can only be removed from this device. Nothing was removed.
      static var notSynced: String {
        String(localized: "native.gateways.removeFailed.notSynced", table: "Native", bundle: .module)
      }
      /// Nothing was removed. Try again.
      static var other: String { String(localized: "native.gateways.removeFailed.other", table: "Native", bundle: .module) }
    }
  }

  /// Coming in a later build.
  static var later: String { String(localized: "native.later", table: "Native", bundle: .module) }

  enum Lock {
    /// Hermie is hidden while it is not in front.
    static var coverLabel: String { String(localized: "native.lock.coverLabel", table: "Native", bundle: .module) }
    /// The lock setting could not be read, so Hermie locks every time you leave it. Choose a setting to keep.
    static var settingUnknown: String {
      String(localized: "native.lock.settingUnknown", table: "Native", bundle: .module)
    }
  }

  enum Notice {
    /// That link is for a gateway this device does not know. Add the gateway first.
    static var gatewayNotConfigured: String {
      String(localized: "native.notice.gatewayNotConfigured", table: "Native", bundle: .module)
    }
    /// The app lock setting could not be restored. Check it under Privacy & security.
    static var lockSettingNotRestored: String {
      String(localized: "native.notice.lockSettingNotRestored", table: "Native", bundle: .module)
    }
    /// Set up a gateway first, then open the link again.
    static var noGateway: String { String(localized: "native.notice.noGateway", table: "Native", bundle: .module) }
    /// Hermie’s local data was damaged and has been rebuilt. Everything that could still be read was kept.
    static var recovered: String { String(localized: "native.notice.recovered", table: "Native", bundle: .module) }
    /// Hermie could not open its storage. Nothing you change now is kept after Hermie quits.
    static var runningInMemory: String {
      String(localized: "native.notice.runningInMemory", table: "Native", bundle: .module)
    }
  }

  enum Push {
    /// This gateway cannot deliver to this device yet: its Hermie plugin is too old. Update the plugin on the gateway.
    static var cannotDeliverPlugin: String {
      String(localized: "native.push.cannotDeliverPlugin", table: "Native", bundle: .module)
    }
    /// This gateway cannot deliver to this device yet: its Hermie plugin does not allow this device’s push relay.
    static var cannotDeliverRelay: String {
      String(localized: "native.push.cannotDeliverRelay", table: "Native", bundle: .module)
    }
    /// Developer details
    static var developer: String { String(localized: "native.push.developer", table: "Native", bundle: .module) }
    /// APNs environment
    static var environment: String {
      String(localized: "native.push.environment", table: "Native", bundle: .module)
    }
    /// Could not register. Hermie tries again later.
    static var failed: String { String(localized: "native.push.failed", table: "Native", bundle: .module) }
    /// Not registered: one device can register with at most eight gateways.
    static var limited: String { String(localized: "native.push.limited", table: "Native", bundle: .module) }
    /// Not registered
    static var notRegistered: String {
      String(localized: "native.push.notRegistered", table: "Native", bundle: .module)
    }
    /// Registered
    static var registered: String { String(localized: "native.push.registered", table: "Native", bundle: .module) }
    /// Reset notifications on this device
    static var reset: String { String(localized: "native.push.reset", table: "Native", bundle: .module) }
    /// Takes this device's registrations back from every gateway it can still reach, forgets them and turns notifications off here. Turn them on again afterwards.
    static var resetHint: String { String(localized: "native.push.resetHint", table: "Native", bundle: .module) }
    /// Some registrations could not be taken back yet. Reset again when the device is online.
    static var resetLeftovers: String {
      String(localized: "native.push.resetLeftovers", table: "Native", bundle: .module)
    }
    /// Signed out
    static var signedOut: String { String(localized: "native.push.signedOut", table: "Native", bundle: .module) }
    /// The notification switch could not be saved. Try again.
    static var switchWriteFailed: String {
      String(localized: "native.push.switchWriteFailed", table: "Native", bundle: .module)
    }
    /// Hermie cannot read this device’s notification settings, so notifications are paused here.
    static var troubleSettings: String {
      String(localized: "native.push.troubleSettings", table: "Native", bundle: .module)
    }
    /// Hermie cannot read this device’s notification registrations, so notifications are paused here.
    static var troubleRegistrations: String {
      String(localized: "native.push.troubleRegistrations", table: "Native", bundle: .module)
    }
    /// Relay
    static var relay: String { String(localized: "native.push.relay", table: "Native", bundle: .module) }
    /// Waiting for this device’s push address…
    static var waiting: String { String(localized: "native.push.waiting", table: "Native", bundle: .module) }
  }
}
