import HermieCore
import SwiftUI

/// What the onboarding flow is handed when the shell opens it.
public struct OnboardingContext {
  public let mode: OnboardingMode
  /// Close the flow. Pass the id of a gateway it added to select it; nil when it was abandoned.
  public let finish: @MainActor (_ addedGatewayId: String?) -> Void
  /// A gateway the person agreed to add (a scanned QR code, a link): the flow fills it in and goes
  /// straight to sign-in.
  public var pairing: GatewayPairingOffer?
}

/// What the sign-in sheet is handed.
public struct SignInContext {
  public let gatewayId: String
  public let finish: @MainActor () -> Void
}

/// What the sidebar's chat list is handed.
public struct ChatListContext {
  /// The live gateway, or nil while there is none.
  public let gateway: GatewayDirectory.Entry?
  public let section: SidebarSection
  /// The selected chat. Writing it opens or closes a chat (and pushes the detail on iPhone).
  public let selection: Binding<ChatRef?>
  /// A folder a link asked to reveal; the list sets it back to nil once shown.
  public let focusedFolderId: Binding<String?>
}

/**
 The shell's seams: the onboarding flow, the sign-in sheet, the chat list and the chat. The chat
 list and the chat default to `ChatListScreen` and `ChatScreen` (with the standard composer); setup
 and sign-in default to placeholders, which the app replaces with the real flows
 (`ShellComponents.gatewaySetup(accounts:)`). A replacement is set at the app's root:

 ```swift
 MainWindow()
   .environment(\.shellComponents, .gatewaySetup(accounts: accounts))
 ```

 The closures build views; they hold no state of their own. `AnyView` here is the price of a seam
 that does not know the type behind it, and it is paid once per screen, not per row.
 */
public struct ShellComponents {
  public var onboarding: @MainActor (OnboardingContext) -> AnyView
  public var signIn: @MainActor (SignInContext) -> AnyView
  public var chatList: @MainActor (ChatListContext) -> AnyView
  public var chat: @MainActor (ChatRef) -> AnyView

  public init(
    onboarding: (@MainActor (OnboardingContext) -> AnyView)? = nil,
    signIn: (@MainActor (SignInContext) -> AnyView)? = nil,
    chatList: (@MainActor (ChatListContext) -> AnyView)? = nil,
    chat: (@MainActor (ChatRef) -> AnyView)? = nil
  ) {
    self.onboarding = onboarding ?? { AnyView(OnboardingPlaceholder(context: $0)) }
    self.signIn = signIn ?? { AnyView(SignInPlaceholder(context: $0)) }
    self.chatList = chatList ?? { AnyView(ChatListScreen(context: $0)) }
    self.chat = chat ?? { AnyView(ChatScreen(chat: $0)) }
  }

  /// What the shell draws when nobody replaced anything.
  public static var standard: ShellComponents { ShellComponents() }
}

extension EnvironmentValues {
  @Entry public var shellComponents: ShellComponents = .standard
}

// MARK: - Placeholders

/// Setup, until the onboarding task lands.
struct OnboardingPlaceholder: View {
  let context: OnboardingContext

  var body: some View {
    NavigationStack {
      EmptyState(Strings.App.Onboarding.Welcome.title, systemImage: "server.rack", message: Text(NativeStrings.later))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { context.finish(nil) }
        }
      }
    }
    .accessibilityIdentifier("hermie.onboarding.placeholder")
  }
}

/// Sign-in, until the sign-in task lands.
struct SignInPlaceholder: View {
  let context: SignInContext

  var body: some View {
    NavigationStack {
      EmptyState(Strings.App.Common.signIn, systemImage: "person.badge.key", message: Text(NativeStrings.later))
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(Strings.App.Common.cancel) { context.finish() }
          }
        }
    }
  }
}
