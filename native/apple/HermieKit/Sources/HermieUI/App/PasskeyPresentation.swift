import AuthenticationServices
import HermieCore

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

/// Where the system passkey sheet is shown: the key window of the scene in front.
@MainActor
enum PasskeyPresentation {
  static func anchor() -> ASPresentationAnchor? {
    #if os(iOS)
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      let front = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first

      return front?.keyWindow ?? front?.windows.first
    #else
      return NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow
        ?? NSApplication.shared.windows.first { $0.isVisible }
    #endif
  }
}

extension PasskeySetup {
  /// The app's: the RP from this build's Info.plist and the system passkey sheet, behind the app lock.
  @MainActor
  static func app(launch: AppLaunch) -> PasskeySetup {
    .live(
      configuration: .live(),
      authenticator: SystemPasskeyAuthenticator(anchor: PasskeyPresentation.anchor),
      lock: launch.lock,
      keyValues: launch.keyValues
    )
  }
}
