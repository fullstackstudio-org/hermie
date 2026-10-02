import HermieCore
import HermieGateway
import SwiftUI

/**
 The sign-in step, in the wizard and in the sign-in sheet.

 An ungated gateway asks for its session token. A gated one signs in through the system browser (the
 primary way, where the browser's own sign-in, AutoFill, password managers and passkeys work) and the
 loopback listener; "Sign in inside Hermie" is the fallback, the gateway's page in a web view. A
 gateway that needs extra headers turns that round: the browser cannot send them.

 The browser sheet (`presenter`) belongs to the flow in `SetupSessions`, not to this view, which the
 lock gate takes down whenever the app locks.
 */
struct SignInStep: View {
  @Bindable var model: OnboardingModel
  let presenter: WebAuthenticationPresenter
  let cancel: () -> Void
  /// Resume mode: the gateway was saved; close the sheet.
  let finish: (String) -> Void

  @State private var continuing = false
  @Environment(\.scenePhase) private var scenePhase

  private var isResume: Bool {
    if case .signIn = model.mode { true } else { false }
  }

  var body: some View {
    Form {
      if isResume {
        ResumeHeader(model: model)
        // A sign-out deleted the way in with the credential: it can be entered again here.
        AdvancedSection(model: model)
      }

      if model.resolved != nil {
        switch model.authMode {
        case .sessionToken:
          SessionTokenSection(model: model, submit: primary)
        case .nativePKCE, .cookie:
          NativeSignInSection(model: model, presenter: presenter)
        }
      }

      StepPrimarySection(
        title: isResume ? Strings.App.Common.done : Strings.App.Common.continue,
        enabled: model.canLeaveSignIn && !continuing,
        busy: continuing || model.signIn == .checking || model.saveState == .saving,
        action: primary
      )
    }
    .formStyle(.grouped)
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(Strings.App.Onboarding.SignIn.title)
    .toolbar { StepToolbar(cancel: cancel) }
    .background(PresentationAnchorReader(box: presenter.anchor))
    .sheet(item: inAppBinding) { attempt in
      InAppSignInPage(attempt: attempt)
        .interactiveDismissDisabled()
    }
    .onChange(of: scenePhase) { _, phase in
      sceneChanged(phase)
    }
  }

  /// The in-app page ends through its own Cancel, never by the sheet going away: the lock takes
  /// sheets down, and that must not end the attempt.
  private var inAppBinding: Binding<InAppSignInAttempt?> {
    Binding(get: { model.inAppAttempt }, set: { _ in })
  }

  private func primary() {
    guard !continuing else {
      return
    }

    continuing = true

    Task {
      if let id = await model.continueFromSignIn() {
        finish(id)
      }

      continuing = false
    }
  }

  /**
   The browser sheet stays up while the person goes elsewhere (to fetch a one-time code, say). On
   iOS a backgrounded app is suspended within seconds, and its listening socket can be taken away;
   the presenter asks for the few seconds iOS grants, and the listener listens again on return.
   */
  private func sceneChanged(_ phase: ScenePhase) {
    switch phase {
    case .background where model.isWaitingForBrowser:
      presenter.appWentToBackground()
    case .active:
      presenter.appBecameActive()
      Task { await model.appBecameActive() }
    default:
      break
    }
  }
}

/// The sign-in sheet's head: which gateway, and the probe while it runs or when it failed.
private struct ResumeHeader: View {
  let model: OnboardingModel

  var body: some View {
    Section {
      LabeledContent(Strings.App.Settings.gateway) {
        Text(model.name.isEmpty ? model.defaultName : model.name)
      }

      if model.loadFailed {
        StatusLine(text: NativeStrings.SignIn.loadFailed, tone: .error)
      } else if model.resolved == nil, let line = OnboardingMessages.probeLine(model) {
        StatusLine(text: line.text, tone: line.tone)
          .accessibilityIdentifier("hermie.onboarding.probe")

        if case .failed = model.probe {
          Button(Strings.App.Common.retry) { model.probeAgain() }
        }
      } else if model.resolved == nil {
        StatusLine(text: Strings.App.Onboarding.Address.probing, tone: .checking)
      }
    }
  }
}

/// An ungated gateway: its session token.
private struct SessionTokenSection: View {
  @Bindable var model: OnboardingModel
  let submit: () -> Void

  var body: some View {
    Section {
      SecureField(
        Strings.App.Onboarding.SignIn.tokenLabel,
        text: $model.sessionToken,
        prompt: Text(Strings.App.Onboarding.SignIn.tokenPlaceholder)
      )
      .labelsHidden()
      .textContentType(.password)
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
      .submitLabel(.continue)
      .onSubmit(submit)
      .accessibilityLabel(Strings.App.Onboarding.SignIn.tokenPlaceholder)
      .accessibilityIdentifier("hermie.onboarding.token")

      switch model.signIn {
      case .checking:
        StatusLine(text: NativeStrings.SignIn.checking, tone: .checking)
      case .failed(let problem):
        StatusLine(text: OnboardingMessages.signInProblem(problem, host: host, sessionToken: true), tone: .error)
          .accessibilityIdentifier("hermie.onboarding.signInStatus")
      default:
        EmptyView()
      }

      OnboardingMessages.markdown(Strings.App.Onboarding.SignIn.tokenHelp)
        .font(.footnote)
        .foregroundStyle(Color.primary)
    } header: {
      SettingsNote(Strings.App.Onboarding.SignIn.subtitleToken)
    }
  }

  private var host: String {
    HostClassification.host(ofAddress: model.baseURL ?? "")
  }
}

/// A gated gateway: the provider, the browser sign-in and its fallback.
private struct NativeSignInSection: View {
  @Bindable var model: OnboardingModel
  let presenter: WebAuthenticationPresenter

  var body: some View {
    if let result = model.resolved?.result, result.authMode == .nativePKCE, !result.supportsNativePKCE {
      Section {
        StatusLine(text: Strings.App.Onboarding.SignIn.blockedTitle, tone: .error)
        Text(Strings.App.Onboarding.SignIn.blockedBody)
      }
    } else if model.providers.isEmpty {
      Section {
        StatusLine(text: Strings.App.Errors.providersUnavailable, tone: .error)
      }
    } else {
      if model.providers.count > 1 {
        Section {
          Picker(Strings.App.Onboarding.SignIn.chooseProvider, selection: $model.selectedProvider) {
            ForEach(model.providers, id: \.name) { provider in
              Text(provider.displayName).tag(Optional(provider.name))
            }
          }
          .pickerStyle(.inline)
          .labelsHidden()
          .accessibilityIdentifier("hermie.onboarding.provider")
        } header: {
          SettingsNote(Strings.App.Onboarding.SignIn.chooseProvider)
        }
      }

      if model.needsInAppSignIn {
        // The browser cannot send the headers this gateway needs: the in-app page leads.
        Section {
          status

          if model.signIn != .signedIn {
            Button {
              model.startInAppSignIn()
            } label: {
              Text(Strings.App.Onboarding.SignIn.signInWith(provider: model.provider?.displayName ?? ""))
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.provider == nil || model.isWaitingForBrowser)
            .accessibilityIdentifier("hermie.onboarding.signInInApp")
          }

          StepNote(NativeStrings.SignIn.headersNeedInApp)
        } header: {
          SettingsNote(Strings.App.Onboarding.SignIn.subtitleNative)
        }

        if model.browserMightWork, model.signIn != .signedIn {
          Section {
            Button(NativeStrings.SignIn.useBrowserInstead) {
              model.startBrowserSignIn(presenter: presenter)
            }
            .disabled(model.provider == nil || model.signIn == .inApp || model.isWaitingForBrowser)
            .accessibilityIdentifier("hermie.onboarding.signInBrowser")

            StepNote(NativeStrings.SignIn.browserMayBeRefused)
          }
        }
      } else {
        Section {
          status

          if model.signIn != .signedIn {
            Button {
              model.startBrowserSignIn(presenter: presenter)
            } label: {
              Text(Strings.App.Onboarding.SignIn.signInWith(provider: model.provider?.displayName ?? ""))
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.provider == nil || model.isWaitingForBrowser || model.signIn == .inApp)
            .accessibilityIdentifier("hermie.onboarding.signInBrowser")
          } else {
            Button(Strings.App.Onboarding.SignIn.signOutAndRetry) {
              model.startBrowserSignIn(presenter: presenter)
            }
            .accessibilityIdentifier("hermie.onboarding.signInAgain")
          }

          StepNote(NativeStrings.SignIn.browserHint)
        } header: {
          SettingsNote(Strings.App.Onboarding.SignIn.subtitleNative)
        }

        if model.signIn != .signedIn {
          Section {
            // Not while the browser is waiting: one attempt at a time, and this one would end it.
            Button(NativeStrings.SignIn.inApp) {
              model.startInAppSignIn()
            }
            .disabled(model.provider == nil || model.isWaitingForBrowser)
            .accessibilityIdentifier("hermie.onboarding.signInInApp")
            StepNote(NativeStrings.SignIn.inAppHint)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var status: some View {
    switch model.signIn {
    case .inBrowser:
      StatusLine(text: NativeStrings.SignIn.waitingForBrowser, tone: .checking)
    case .inApp:
      StatusLine(text: Strings.App.Onboarding.SignIn.Webview.loading, tone: .checking)
    case .checking:
      StatusLine(text: NativeStrings.SignIn.checking, tone: .checking)
    case .signedIn:
      StatusLine(text: signedInText, tone: .ok)
        .accessibilityIdentifier("hermie.onboarding.signInStatus")
    case .failed(let problem):
      StatusLine(
        text: OnboardingMessages.signInProblem(problem, host: HostClassification.host(ofAddress: model.baseURL ?? ""), sessionToken: false),
        tone: .error
      )
      .accessibilityIdentifier("hermie.onboarding.signInStatus")

      if case .check = problem {
        Button(Strings.App.Common.retry) {
          Task { await model.retryCheck() }
        }
      }
    case .idle:
      EmptyView()
    }
  }

  private var signedInText: String {
    let identity = model.identity
    let user = [identity?.displayName, identity?.email, identity?.userID].compactMap { $0 }.first { !$0.isEmpty }

    return user.map { Strings.App.Onboarding.SignIn.signedInAs(user: $0) } ?? Strings.App.Onboarding.SignIn.signedIn
  }
}
