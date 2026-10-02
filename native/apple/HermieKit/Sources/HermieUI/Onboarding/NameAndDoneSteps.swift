import HermieCore
import SwiftUI

/// What this gateway is called on this device.
struct NameStep: View {
  @Bindable var model: OnboardingModel
  let cancel: () -> Void

  @FocusState private var focused: Bool

  var body: some View {
    Form {
      Section {
        WrappingField(
          title: Strings.App.Settings.Gateways.name,
          text: $model.name,
          prompt: model.defaultName,
          submit: model.continueFromName
        )
        .labelsHidden()
        .autocorrectionDisabled()
        .submitLabel(.continue)
        .focused($focused)
        .accessibilityLabel(Strings.App.Settings.Gateways.name)
          .accessibilityIdentifier("hermie.onboarding.name")
        StepNote(Strings.App.Settings.Gateways.nameHint)
      }

      StepPrimarySection(title: Strings.App.Common.continue, enabled: true, busy: false, action: model.continueFromName)
    }
    .formStyle(.grouped)
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(Strings.App.Settings.Gateways.name)
    .toolbar { StepToolbar(cancel: cancel) }
    #if os(macOS)
      .onAppear { focused = true }
    #endif
  }
}

/// The summary, and the button that stores the gateway and opens it.
struct DoneStep: View {
  let model: OnboardingModel
  let cancel: () -> Void
  let finish: (String) -> Void

  var body: some View {
    Form {
      Section {
        LabeledContent(Strings.App.Onboarding.Done.gateway) {
          Text(model.name.isEmpty ? model.defaultName : model.name)
        }

        LabeledContent(Strings.App.Settings.address) {
          Text(model.baseURL ?? "")
            .textSelection(.enabled)
        }

        if let user = user {
          LabeledContent(Strings.App.Settings.user) {
            Text(user)
          }
        } else if model.authMode == .sessionToken {
          LabeledContent(Strings.App.Settings.Gateways.authModeToken) {
            Image(systemName: "checkmark")
              .accessibilityLabel(Strings.App.Onboarding.SignIn.signedIn)
          }
        }
        StepNote(Strings.App.Onboarding.Done.subtitle)
      }

      if case .failed(let problem) = model.saveState {
        Section {
          StatusLine(text: OnboardingMessages.saveProblem(problem), tone: .error)
            .accessibilityIdentifier("hermie.onboarding.saveError")
        }
      }

      StepPrimarySection(
        title: primaryTitle,
        enabled: model.saveState != .saving,
        busy: model.saveState == .saving,
        action: save
      )
    }
    .formStyle(.grouped)
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(Strings.App.Onboarding.Done.title)
    .toolbar { StepToolbar(cancel: cancel) }
    .accessibilityIdentifier("hermie.onboarding.done")
  }

  private var primaryTitle: String {
    if case .failed = model.saveState {
      return Strings.App.Onboarding.Done.retry
    }

    return Strings.App.Onboarding.Done.finish
  }

  private var user: String? {
    let identity = model.identity

    return [identity?.displayName, identity?.email, identity?.userID].compactMap { $0 }.first { !$0.isEmpty }
  }

  private func save() {
    Task {
      if let id = await model.finish() {
        finish(id)
      }
    }
  }
}
