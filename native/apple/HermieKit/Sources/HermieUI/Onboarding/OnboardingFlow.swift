import HermieCore
import SwiftUI

/**
 Setup of a gateway, as the sheet the shell presents (`ShellComponents.onboarding`): a
 `NavigationStack` of address → sign-in → name → done, over one `OnboardingModel`.

 The model lives in `SetupSessions`, not in this view: the lock gate takes the sheet down whenever
 the app is locked, and that must hide the flow, not end it. The flow ends on Cancel or when it
 finishes, which stops a sign-in in progress and forgets every secret typed or received. The sheet
 cannot be swiped away, so nothing else ends it by accident.
 */
public struct OnboardingFlow: View {
  let context: OnboardingContext
  let key: String
  let session: SetupSessions.Session
  let accounts: GatewayAccounts

  @Environment(AppLaunch.self) private var launch
  /// A gateway taken from iCloud Keychain that needs a sign-in here: the flow continues with it.
  @State private var signingInFromICloud: String?

  public init(context: OnboardingContext, accounts: GatewayAccounts) {
    let key = SetupSessions.onboardingKey(accounts)

    self.context = context
    self.key = key
    self.accounts = accounts
    self.session = SetupSessions.shared.session(key) { OnboardingModel(mode: .newGateway, accounts: accounts) }
  }

  public var body: some View {
    @Bindable var model = session.model

    if let id = signingInFromICloud {
      SignInSheet(context: SignInContext(gatewayId: id, finish: { finish(id) }), accounts: accounts)
    } else {
      steps(model)
    }
  }

  private func steps(_ model: OnboardingModel) -> some View {
    @Bindable var model = model

    return NavigationStack(path: $model.path) {
      AddressStep(model: model, cancel: cancel, fromICloud: tookFromICloud)
        .navigationDestination(for: OnboardingModel.Step.self) { step in
          switch step {
          case .signIn:
            SignInStep(model: model, presenter: session.presenter, cancel: cancel, finish: { _ in })
          case .name:
            NameStep(model: model, cancel: cancel)
          case .done:
            DoneStep(model: model, cancel: cancel, finish: finish)
          }
        }
    }
    .interactiveDismissDisabled()
    .task {
      // A gateway the person already agreed to (a scanned code, a link): filled in once, and sign-in follows.
      if let offer = context.pairing {
        session.model.applyPairing(offer)
      }

      // Before the first step shows: what iCloud Keychain holds that is not here (I11).
      launch.iCloudSync.lookInICloud()
      await session.model.opened()
    }
    #if os(macOS)
      .frame(minWidth: 520, idealWidth: 560, minHeight: 560, idealHeight: 640)
    #endif
    .accessibilityIdentifier("hermie.onboarding")
  }

  private func cancel() {
    SetupSessions.shared.end(key)
    context.finish(nil)
  }

  /// Gateways came from iCloud Keychain: sign in to the first that needs it, else done with it.
  private func tookFromICloud(_ results: [ICloudSyncModel.AddResult]) {
    if let needing = results.first(where: \.needsSignIn)?.gatewayId {
      signingInFromICloud = needing
    } else if let first = results.first?.gatewayId {
      finish(first)
    }
  }

  private func finish(_ id: String) {
    SetupSessions.shared.end(key)
    context.finish(id)
  }
}

/// The sign-in sheet for a gateway that is already configured: the same sign-in step, with the
/// address and the way in read from what is stored (`needs_signin`, or "sign in to continue"). Kept
/// in `SetupSessions` like setup, so locking the app only hides it.
public struct SignInSheet: View {
  let context: SignInContext
  let key: String
  let session: SetupSessions.Session

  public init(context: SignInContext, accounts: GatewayAccounts) {
    let key = SetupSessions.signInKey(accounts, gatewayId: context.gatewayId)

    self.context = context
    self.key = key
    self.session = SetupSessions.shared.session(key) {
      OnboardingModel(mode: .signIn(gatewayId: context.gatewayId), accounts: accounts)
    }
  }

  public var body: some View {
    NavigationStack {
      SignInStep(
        model: session.model,
        presenter: session.presenter,
        cancel: {
          SetupSessions.shared.end(key)
          context.finish()
        },
        finish: { _ in
          SetupSessions.shared.end(key)
          context.finish()
        }
      )
    }
    .task { await session.model.load() }
    .interactiveDismissDisabled()
    #if os(macOS)
      .frame(minWidth: 520, idealWidth: 560, minHeight: 480, idealHeight: 560)
    #endif
    .accessibilityIdentifier("hermie.signIn")
  }
}

/// Cancel, the same on every step: the system's close button, as the Settings sheet has.
struct StepToolbar: ToolbarContent {
  let cancel: () -> Void

  var body: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button(role: .close, action: cancel)
        .keyboardShortcut(.cancelAction)
        .accessibilityIdentifier("hermie.onboarding.cancel")
    }
  }
}

/**
 The step's primary action (Continue, Done, Start chatting): a full-width button as the form's last
 section, so it scrolls with the step and nothing is drawn under it.

 Always there, so VoiceOver finds the next step: disabled until it can be pressed, with a hint that
 says so, and drawn in a style whose disabled face keeps its contrast (the system's dims the label
 below what the audit accepts). A progress view stands in while it works. Return presses it from a
 keyboard (`defaultAction`).
 */
struct StepPrimarySection: View {
  let title: String
  let enabled: Bool
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Section {
      Group {
        if busy {
          ProgressView()
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        } else {
          Button(title, action: action)
            .buttonStyle(StepButtonStyle())
            .disabled(!enabled)
            .keyboardShortcut(.defaultAction)
            .accessibilityHint(enabled ? "" : NativeStrings.Onboarding.continueHint)
            .accessibilityIdentifier("hermie.onboarding.continue")
        }
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets())
    }
  }
}

/// White on the accent colour, bold so it is held to the large-text ratio; disabled, the primary
/// colour on a grey that stays legible.
struct StepButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.title3.bold())
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .padding(.horizontal, 16)
      .foregroundStyle(isEnabled ? Color.white : Color.primary)
      .background(isEnabled ? Color.accentColor : Color.gray.opacity(0.22), in: .capsule)
      .opacity(configuration.isPressed ? 0.75 : 1)
      .contentShape(.capsule)
  }
}

/// A one-line field that wraps at large text sizes instead of clipping, and treats Return as submit.
struct WrappingField: View {
  let title: String
  @Binding var text: String
  let prompt: String
  let submit: () -> Void

  var body: some View {
    TextField(
      title,
      text: Binding(
        get: { text },
        set: { value in
          if value.contains("\n") {
            text = value.replacingOccurrences(of: "\n", with: "")
            submit()
          } else {
            text = value
          }
        }
      ),
      prompt: Text(prompt),
      axis: .vertical
    )
    .lineLimit(1...4)
    .onSubmit(submit)
  }
}
