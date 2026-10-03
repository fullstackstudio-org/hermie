import Foundation

/// The strings of iCloud Sync: Settings, the gateway list and the disclosure (`native.icloud.*` in
/// `Resources/Native.xcstrings`).
extension NativeStrings {
  enum ICloud {
    /// That did not work.
    static var actionFailed: String {
      String(localized: "native.icloud.actionFailed", table: "Native", bundle: .module)
    }
    /// Your gateway list, session tokens, Cloudflare Access service tokens and custom headers are kept in your iCloud Keychain, end-to-end encrypted, for your other Apple devices. Sign-ins through an identity provider or a password stay on each device. This needs iCloud Keychain to be on in the system settings; Hermie cannot see whether it is.
    static var footer: String { String(localized: "native.icloud.footer", table: "Native", bundle: .module) }
    /// Last synced
    static var lastSynced: String { String(localized: "native.icloud.lastSynced", table: "Native", bundle: .module) }
    /// Status
    static var status: String { String(localized: "native.icloud.status", table: "Native", bundle: .module) }
    /// Sync with iCloud
    static var switchLabel: String { String(localized: "native.icloud.switch", table: "Native", bundle: .module) }
    /// Sync Again
    static var syncAgain: String { String(localized: "native.icloud.syncAgain", table: "Native", bundle: .module) }
    /// Sync Now
    static var syncNow: String { String(localized: "native.icloud.syncNow", table: "Native", bundle: .module) }
    /// iCloud Sync
    static var title: String { String(localized: "native.icloud.title", table: "Native", bundle: .module) }

    enum Available {
      /// Add
      static var add: String { String(localized: "native.icloud.available.add", table: "Native", bundle: .module) }
      /// These gateways are in your iCloud Keychain but not on this device.
      static var footer: String {
        String(localized: "native.icloud.available.footer", table: "Native", bundle: .module)
      }
      /// Available from iCloud
      static var header: String {
        String(localized: "native.icloud.available.header", table: "Native", bundle: .module)
      }
      /// Removed from this device earlier
      static var removedHere: String {
        String(localized: "native.icloud.available.removedHere", table: "Native", bundle: .module)
      }
      /// Asks you to sign in once added
      static var signInAfter: String {
        String(localized: "native.icloud.available.signInAfter", table: "Native", bundle: .module)
      }
      /// Use These Gateways
      static var useAll: String {
        String(localized: "native.icloud.available.useAll", table: "Native", bundle: .module)
      }
    }

    enum Badge {
      /// Synced with iCloud
      static var synced: String { String(localized: "native.icloud.badge.synced", table: "Native", bundle: .module) }
    }

    enum DeleteEverything {
      /// Delete Everything from iCloud Keychain…
      static var action: String {
        String(localized: "native.icloud.deleteEverything.action", table: "Native", bundle: .module)
      }
      /// Delete Everything
      static var confirm: String {
        String(localized: "native.icloud.deleteEverything.confirm", table: "Native", bundle: .module)
      }
      /// Deletes every Hermie gateway and credential from your iCloud Keychain. No device loses a gateway.
      static var footer: String {
        String(localized: "native.icloud.deleteEverything.footer", table: "Native", bundle: .module)
      }
      /// Every Hermie gateway and credential in your iCloud Keychain is deleted. Nothing is removed from any device. This device keeps its gateways and stops syncing them; gateways you add later are synced as usual. Your other devices keep theirs too, and stop syncing them until you choose Sync Again there. A device that changes a gateway before the deletion reaches it, or that had not yet received anything from iCloud, can put that gateway back.
      static var message: String {
        String(localized: "native.icloud.deleteEverything.message", table: "Native", bundle: .module)
      }
      /// Delete Everything from iCloud Keychain?
      static var title: String {
        String(localized: "native.icloud.deleteEverything.title", table: "Native", bundle: .module)
      }
    }

    enum Disclosure {
      /// Sync with iCloud
      static var accept: String {
        String(localized: "native.icloud.disclosure.accept", table: "Native", bundle: .module)
      }
      /// Already in iCloud Keychain
      static var availableHeader: String {
        String(localized: "native.icloud.disclosure.availableHeader", table: "Native", bundle: .module)
      }
      /// Keep on This Device
      static var decline: String {
        String(localized: "native.icloud.disclosure.decline", table: "Native", bundle: .module)
      }
      /// On this device
      static var gatewaysHeader: String {
        String(localized: "native.icloud.disclosure.gatewaysHeader", table: "Native", bundle: .module)
      }
      /// Hermie can keep your gateways in your iCloud Keychain, so your other Apple devices get them without typing.
      static var intro: String { String(localized: "native.icloud.disclosure.intro", table: "Native", bundle: .module) }
      /// You can change this at any time under Settings → Gateways → iCloud Sync.
      static var later: String { String(localized: "native.icloud.disclosure.later", table: "Native", bundle: .module) }
      /// What is never stored
      static var neverHeader: String {
        String(localized: "native.icloud.disclosure.neverHeader", table: "Native", bundle: .module)
      }
      /// The app lock, your messages and drafts, and notification registrations.
      static var neverOther: String {
        String(localized: "native.icloud.disclosure.neverOther", table: "Native", bundle: .module)
      }
      /// Sign-ins through an identity provider or a password. Each device signs in on its own.
      static var neverSignIns: String {
        String(localized: "native.icloud.disclosure.neverSignIns", table: "Native", bundle: .module)
      }
      /// What is stored
      static var storedHeader: String {
        String(localized: "native.icloud.disclosure.storedHeader", table: "Native", bundle: .module)
      }
      /// Your list of gateways: name, address, how you sign in, and your user ID on each.
      static var storedList: String {
        String(localized: "native.icloud.disclosure.storedList", table: "Native", bundle: .module)
      }
      /// Session tokens, Cloudflare Access service tokens and custom headers.
      static var storedSecrets: String {
        String(localized: "native.icloud.disclosure.storedSecrets", table: "Native", bundle: .module)
      }
      /// Sync Gateways with iCloud?
      static var title: String { String(localized: "native.icloud.disclosure.title", table: "Native", bundle: .module) }
      /// In your iCloud Keychain, which is end-to-end encrypted: Apple cannot read it and neither can we. It reaches only devices signed in to your Apple Account that you have approved. Nothing is sent to us.
      static var whereBody: String {
        String(localized: "native.icloud.disclosure.whereBody", table: "Native", bundle: .module)
      }
      /// Where it is stored
      static var whereHeader: String {
        String(localized: "native.icloud.disclosure.whereHeader", table: "Native", bundle: .module)
      }
      /// Hermie cannot see whether iCloud Keychain is on. If it is off, everything stays on this device.
      static var whereOff: String {
        String(localized: "native.icloud.disclosure.whereOff", table: "Native", bundle: .module)
      }
    }

    enum Failure {
      /// The keychain refused the change. Choose Sync Now to try again.
      static var keychain: String {
        String(localized: "native.icloud.failure.keychain", table: "Native", bundle: .module)
      }
      /// The keychain cannot be read while this device is locked. Unlock it and choose Sync Now.
      static var locked: String { String(localized: "native.icloud.failure.locked", table: "Native", bundle: .module) }
      /// Something on this device was written by a newer version of Hermie. Update Hermie to sync.
      static var newerVersion: String {
        String(localized: "native.icloud.failure.newerVersion", table: "Native", bundle: .module)
      }
      /// Choose Sync Now to try again.
      static var other: String { String(localized: "native.icloud.failure.other", table: "Native", bundle: .module) }
      /// Hermie could not read its own storage. Quit and reopen Hermie, then choose Sync Now.
      static var storage: String {
        String(localized: "native.icloud.failure.storage", table: "Native", bundle: .module)
      }
    }

    enum Gateways {
      /// A gateway that is not synced stays on this device only. Turning one off removes it from iCloud Keychain; your other devices keep their copies.
      static var footer: String { String(localized: "native.icloud.gateways.footer", table: "Native", bundle: .module) }
      /// Sync this gateway
      static var syncThisGateway: String {
        String(localized: "native.icloud.gateways.syncThisGateway", table: "Native", bundle: .module)
      }
    }

    enum Notice {
      /// Added from iCloud Keychain:
      static var adopted: String { String(localized: "native.icloud.notice.adopted", table: "Native", bundle: .module) }
      /// Needs your attention
      static var header: String { String(localized: "native.icloud.notice.header", table: "Native", bundle: .module) }
      /// These gateways were removed from all devices on another device. They are kept here because they were added here first. Syncing again does not bring them back on other devices; to have one on every device again, remove it here and add it again.
      static var keptHere: String {
        String(localized: "native.icloud.notice.keptHere", table: "Native", bundle: .module)
      }
      /// Added from iCloud Keychain. Sign in to use these gateways on this device:
      static var needsSignIn: String {
        String(localized: "native.icloud.notice.needsSignIn", table: "Native", bundle: .module)
      }
      /// This gateway was removed from all devices on another device, so it is gone from this one too:
      static var removedElsewhere: String {
        String(localized: "native.icloud.notice.removedElsewhere", table: "Native", bundle: .module)
      }
      /// iCloud Keychain no longer holds these gateways, so they are kept on this device only. This happens after “Delete Everything from iCloud Keychain” on another device, or when this device’s copy of iCloud Keychain was reset.
      static var storeEmptied: String {
        String(localized: "native.icloud.notice.storeEmptied", table: "Native", bundle: .module)
      }
    }

    enum Phase {
      /// Not turned on yet
      static var awaiting: String {
        String(localized: "native.icloud.phase.awaiting", table: "Native", bundle: .module)
      }
      /// Hermie asks before it stores anything in iCloud Keychain.
      static var awaitingDetail: String {
        String(localized: "native.icloud.phase.awaitingDetail", table: "Native", bundle: .module)
      }
      /// Checking…
      static var checking: String {
        String(localized: "native.icloud.phase.checking", table: "Native", bundle: .module)
      }
      /// Did not finish
      static var failed: String { String(localized: "native.icloud.phase.failed", table: "Native", bundle: .module) }
      /// Paused
      static var newerVersion: String {
        String(localized: "native.icloud.phase.newerVersion", table: "Native", bundle: .module)
      }
      /// A newer version of Hermie set up sync on this device. Update Hermie to sync again.
      static var newerVersionDetail: String {
        String(localized: "native.icloud.phase.newerVersionDetail", table: "Native", bundle: .module)
      }
      /// Off
      static var off: String { String(localized: "native.icloud.phase.off", table: "Native", bundle: .module) }
      /// Your gateways stay on this device.
      static var offDetail: String {
        String(localized: "native.icloud.phase.offDetail", table: "Native", bundle: .module)
      }
      /// Syncing…
      static var syncing: String { String(localized: "native.icloud.phase.syncing", table: "Native", bundle: .module) }
      /// Not available
      static var unavailable: String {
        String(localized: "native.icloud.phase.unavailable", table: "Native", bundle: .module)
      }
      /// This copy of Hermie cannot use iCloud Keychain, so your gateways stay on this device. Copies from the App Store and TestFlight can.
      static var unavailableDetail: String {
        String(localized: "native.icloud.phase.unavailableDetail", table: "Native", bundle: .module)
      }
      /// Up to date
      static var upToDate: String {
        String(localized: "native.icloud.phase.upToDate", table: "Native", bundle: .module)
      }
      /// Waiting to sync
      static var waiting: String { String(localized: "native.icloud.phase.waiting", table: "Native", bundle: .module) }
    }

    enum Remove {
      /// Remove from All Devices
      static var allDevices: String {
        String(localized: "native.icloud.remove.allDevices", table: "Native", bundle: .module)
      }
      /// From this device: it stays in iCloud Keychain and on your other devices, and does not come back here. From all devices: it is removed from iCloud Keychain, and from each of your devices the next time it syncs. Either way, this device forgets everything stored for it.
      static var message: String { String(localized: "native.icloud.remove.message", table: "Native", bundle: .module) }
      /// Remove from This Device
      static var thisDevice: String {
        String(localized: "native.icloud.remove.thisDevice", table: "Native", bundle: .module)
      }
      /// Remove This Gateway?
      static var title: String { String(localized: "native.icloud.remove.title", table: "Native", bundle: .module) }
    }

    enum State {
      /// This device only: update Hermie to sync it
      static var newerVersion: String {
        String(localized: "native.icloud.state.newerVersion", table: "Native", bundle: .module)
      }
      /// This device only: no longer in iCloud Keychain
      static var notInICloud: String {
        String(localized: "native.icloud.state.notInICloud", table: "Native", bundle: .module)
      }
      /// Not synced
      static var off: String { String(localized: "native.icloud.state.off", table: "Native", bundle: .module) }
      /// This device only: removed on another device
      static var removedElsewhere: String {
        String(localized: "native.icloud.state.removedElsewhere", table: "Native", bundle: .module)
      }
      /// This device only: another gateway here has the same address
      static var sameAddress: String {
        String(localized: "native.icloud.state.sameAddress", table: "Native", bundle: .module)
      }
      /// Sign in needed
      static var signInNeeded: String {
        String(localized: "native.icloud.state.signInNeeded", table: "Native", bundle: .module)
      }
      /// Synced
      static var synced: String { String(localized: "native.icloud.state.synced", table: "Native", bundle: .module) }
      /// This device only
      static var thisDeviceOnly: String {
        String(localized: "native.icloud.state.thisDeviceOnly", table: "Native", bundle: .module)
      }
    }

    enum TurnOff {
      /// Turn Off, Keep in iCloud
      static var keep: String { String(localized: "native.icloud.turnOff.keep", table: "Native", bundle: .module) }
      /// Your gateways stay on this device. You can also remove the gateways this device synced from iCloud Keychain; your other devices keep their copies, each on that device only.
      static var message: String {
        String(localized: "native.icloud.turnOff.message", table: "Native", bundle: .module)
      }
      /// Turn Off and Remove from iCloud
      static var remove: String { String(localized: "native.icloud.turnOff.remove", table: "Native", bundle: .module) }
      /// Turn Off iCloud Sync?
      static var title: String { String(localized: "native.icloud.turnOff.title", table: "Native", bundle: .module) }
    }
  }
}
