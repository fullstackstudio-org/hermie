import Foundation
import HermieCore

/// The native-only strings of setup, sign-in and the account page (`Resources/Native.xcstrings`).
extension NativeStrings {
  enum Account {
    /// Hermie could not ask the gateway who you are. …
    static var failed: String { text("native.account.failed") }
    /// Asking the gateway…
    static var loading: String { text("native.account.loading") }
    /// No gateway is set up on this device yet.
    static var noGateway: String { text("native.account.noGateway") }
    /// Sign out of this gateway? …
    static var signOutConfirm: String { text("native.account.signOutConfirm") }
    /// User ID
    static var userId: String { text("native.account.userId") }
  }

  enum Loopback {
    /// The pages the loopback listener answers the browser with, in the app's language.
    static var pages: LoopbackPages {
      let language = Bundle.module.preferredLocalizations.first ?? "en"

      return LoopbackPages(
        success: LoopbackPage(
          title: text("native.loopback.success.title"),
          message: text("native.loopback.success.message"),
          language: language
        ),
        rejected: LoopbackPage(
          title: text("native.loopback.rejected.title"),
          message: text("native.loopback.rejected.message"),
          language: language
        )
      )
    }
  }

  enum Onboarding {
    /// Continue over plain http:// anyway
    static var confirmCleartext: String { text("native.onboarding.confirmCleartext") }
    /// Hermie will send your messages and your sign-in to this address unencrypted.
    static var confirmCleartextHint: String { text("native.onboarding.confirmCleartextHint") }
    /// This is not a valid header name.
    static var headerInvalidName: String { text("native.onboarding.header.invalidName") }
    /// Hermie sets this header itself.
    static var headerReserved: String { text("native.onboarding.header.reserved") }
    /// the keychain refused to store them.
    static var keychainReason: String { text("native.onboarding.save.keychainReason") }
    /// the local database refused the change.
    static var storeReason: String { text("native.onboarding.save.storeReason") }
    /// This gateway was removed while you were signing in, …
    static var gatewayRemoved: String { text("native.onboarding.save.gatewayRemoved") }
    /// This gateway now answers at another address, …
    static var addressChanged: String { text("native.onboarding.save.addressChanged") }
    /// The gateway list on this device cannot be read, …
    static var listUnreadable: String { text("native.onboarding.listUnreadable") }
    /// Available once this step is complete.
    static var continueHint: String { text("native.onboarding.continueHint") }
    /// The gateway list on this device was written by a newer version of Hermie, …
    static var unsupportedRegistry: String { text("native.onboarding.save.unsupportedRegistry") }
  }

  enum SignIn {
    /// The sign-in page opens in your browser, …
    static var browserHint: String { text("native.signIn.browserHint") }
    /// The browser sign-in could not be opened. …
    static var browserUnavailable: String { text("native.signIn.browserUnavailable") }
    /// Only works when the Access policy also lets you sign in as a person in the browser.
    static var browserMayBeRefused: String { text("native.signIn.browserMayBeRefused") }
    /// This gateway needs extra headers, which your browser cannot send, …
    static var headersNeedInApp: String { text("native.signIn.headersNeedInApp") }
    /// The gateway or its identity provider refused the sign-in. …
    static var providerRefused: String { text("native.signIn.providerRefused") }
    /// Use the browser instead
    static var useBrowserInstead: String { text("native.signIn.useBrowserInstead") }
    /// Checking with the gateway…
    static var checking: String { text("native.signIn.checking") }
    /// Having trouble? Sign in inside Hermie
    static var inApp: String { text("native.signIn.inApp") }
    /// Opens the gateway’s sign-in page inside Hermie instead of your browser. …
    static var inAppHint: String { text("native.signIn.inAppHint") }
    /// Hermie could not wait for the sign-in result on this device. …
    static var listenerUnavailable: String { text("native.signIn.listenerUnavailable") }
    /// The settings of this gateway could not be read on this device.
    static var loadFailed: String { text("native.signIn.loadFailed") }
    /// The sign-in page could not be loaded. …
    static var pageLoadFailed: String { text("native.signIn.pageLoadFailed") }
    /// Another app on this device is already waiting for a sign-in at 127.0.0.1:38007 …
    static var portInUse: String { text("native.signIn.portInUse") }
    /// The gateway did not accept this session token. …
    static var tokenRejected: String { text("native.signIn.tokenRejected") }
    /// Waiting for the sign-in in your browser…
    static var waitingForBrowser: String { text("native.signIn.waitingForBrowser") }
  }

  fileprivate static func text(_ key: String.LocalizationValue) -> String {
    String(localized: key, table: "Native", bundle: .module)
  }
}
