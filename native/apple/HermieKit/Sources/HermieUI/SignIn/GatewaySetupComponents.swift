import HermieCore
import SwiftUI

extension ShellComponents {
  /// The setup and sign-in seams, filled: the wizard and the sign-in sheet over `accounts`.
  @MainActor
  public static func gatewaySetup(accounts: GatewayAccounts) -> ShellComponents {
    ShellComponents(
      onboarding: { AnyView(OnboardingFlow(context: $0, accounts: accounts)) },
      signIn: { AnyView(SignInSheet(context: $0, accounts: accounts)) }
    )
  }
}

extension GatewayAccounts {
  /// The app's accounts, with the loopback listener's pages in the app's language.
  @MainActor
  public static func app(_ launch: AppLaunch) -> GatewayAccounts {
    live(launch: launch, pages: NativeStrings.Loopback.pages)
  }
}
