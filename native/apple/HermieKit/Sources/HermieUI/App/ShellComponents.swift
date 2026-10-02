import HermieCore
import SwiftUI

/// What the onboarding flow is handed when the shell opens it.
public struct OnboardingContext {
  public let mode: OnboardingMode
  /// Close the flow. Pass the id of a gateway it added to select it; nil when it was abandoned.
  public let finish: @MainActor (_ addedGatewayId: String?) -> Void
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
 The seams the later tasks fill: the onboarding flow, the sign-in sheet, the chat list and the chat.
 The shell draws a placeholder for each until a task replaces it, by setting the environment value
 at the app's root:

 ```swift
 MainWindow()
   .environment(\.shellComponents, ShellComponents(onboarding: { OnboardingFlow(context: $0) }))
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
    self.chatList = chatList ?? { AnyView(ChatListPlaceholder(context: $0)) }
    self.chat = chat ?? { AnyView(ChatPlaceholder(chat: $0)) }
  }

  public static var placeholders: ShellComponents { ShellComponents() }
}

extension EnvironmentValues {
  @Entry public var shellComponents: ShellComponents = .placeholders
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

/// The chat list, until the chat list task lands: the selected chat, if any, so selection and the
/// iPhone push already behave as they will.
struct ChatListPlaceholder: View {
  let context: ChatListContext

  var body: some View {
    List(selection: context.selection) {
      if let chat = context.selection.wrappedValue {
        Label {
          Text(chat.bot)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "bubble.left")
        }
        .tag(chat)
          .accessibilityIdentifier("hermie.chatList.row")
      }

      Section {
        Text(NativeStrings.later)
      }
    }
    .accessibilityIdentifier("hermie.chatList.placeholder")
  }
}

/// The chat, until the chat task lands.
struct ChatPlaceholder: View {
  let chat: ChatRef

  var body: some View {
    EmptyState(chat.bot, systemImage: "bubble.left.and.bubble.right", message: Text(NativeStrings.later))
    .navigationTitle(chat.bot)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.chat.placeholder")
    .accessibilityValue(chat.bot)
  }
}
