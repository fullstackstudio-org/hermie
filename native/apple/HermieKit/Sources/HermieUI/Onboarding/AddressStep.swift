import HermieCore
import HermieGateway
import SwiftUI

/**
 The address step: the address, what the probe found (or why it failed, with what can be done about
 it), the line about a cleartext address and, on a public host, the confirmation it needs; and under
 Advanced, the front door preset or custom headers.
 */
struct AddressStep: View {
  @Bindable var model: OnboardingModel
  let cancel: () -> Void
  /// Gateways taken from iCloud Keychain on this step (`ICloudSetupSection`); nil hides the section.
  var fromICloud: (([ICloudSyncModel.AddResult]) -> Void)?

  @FocusState private var addressFocused: Bool

  var body: some View {
    Form {
      if let fromICloud {
        ICloudSetupSection(use: fromICloud)
      }

      Section {
        WrappingField(
          title: Strings.App.Onboarding.Address.label,
          text: $model.address,
          prompt: Strings.App.Onboarding.Address.placeholder,
          submit: model.continueFromAddress
        )
        .labelsHidden()
        .autocorrectionDisabled()
        #if os(iOS)
          .textContentType(.URL)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
        #endif
        .submitLabel(.continue)
        .focused($addressFocused)
        .accessibilityLabel(Strings.App.Onboarding.Address.label)
          .accessibilityIdentifier("hermie.onboarding.address")

        StepNote(Strings.App.Onboarding.Address.hint)
      } header: {
        SettingsNote(Strings.App.Onboarding.Address.subtitle)
      }

      if model.listUnreadable {
        Section {
          StatusLine(text: NativeStrings.Onboarding.listUnreadable, tone: .error)
            .accessibilityIdentifier("hermie.onboarding.listUnreadable")
        }
      }

      if let line = OnboardingMessages.probeLine(model) {
        Section {
          StatusLine(text: line.text, tone: line.tone)
            .accessibilityIdentifier("hermie.onboarding.probe")

          ProbeActions(model: model)
        }
      }

      if let privacy = model.cleartextPrivacy {
        CleartextSection(model: model, privacy: privacy)
      }

      AdvancedSection(model: model)

      StepPrimarySection(
        title: Strings.App.Common.continue,
        enabled: model.canLeaveAddress,
        busy: false,
        action: model.continueFromAddress
      )
    }
    .formStyle(.grouped)
    .scrollDismissesKeyboard(.immediately)
    .navigationTitle(Strings.App.Onboarding.Address.title)
    .toolbar { StepToolbar(cancel: cancel) }
    #if os(macOS)
      // On the Mac the field is where typing goes; on a phone the keyboard waits for a tap.
      .onAppear { addressFocused = model.address.isEmpty }
    #endif
  }
}

/// The buttons a failed probe offers: the redirect target, the front door. Offered, never done.
private struct ProbeActions: View {
  let model: OnboardingModel

  var body: some View {
    if case .failed(let failure) = model.probe {
      ForEach(Array(failure.verdict.actions.enumerated()), id: \.offset) { _, action in
        switch action {
        case .useHost(let host, let origin):
          Button(Strings.App.Errors.useRedirectTarget(host: OnboardingMessages.redirectLabel(host: host, origin: origin))) {
            model.useRedirectTarget(origin ?? host)
          }
          .accessibilityIdentifier("hermie.onboarding.useRedirect")
        case .frontDoor:
          Button(Strings.App.Errors.openFrontDoor) {
            model.openFrontDoor()
          }
          .accessibilityIdentifier("hermie.onboarding.openFrontDoor")
        }
      }
    }
  }
}

/// One line about plain http, in the tone its host earns; a public host also needs a confirmation.
private struct CleartextSection: View {
  @Bindable var model: OnboardingModel
  let privacy: HostPrivacy

  var body: some View {
    Section {
      Label {
        Text(OnboardingMessages.cleartext(privacy))
      } icon: {
        Image(systemName: privacy == .public ? "exclamationmark.shield.fill" : "lock.open")
          .foregroundStyle(privacy == .public ? .orange : .secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.onboarding.cleartext")

      if model.needsCleartextConfirmation {
        Button(Strings.App.Transport.useHttps) {
          model.useHTTPS()
        }
        .accessibilityIdentifier("hermie.onboarding.useHTTPS")

        Toggle(NativeStrings.Onboarding.confirmCleartext, isOn: $model.cleartextConfirmed)
          .accessibilityHint(NativeStrings.Onboarding.confirmCleartextHint)
          .accessibilityIdentifier("hermie.onboarding.confirmCleartext")
      }
      if model.needsCleartextConfirmation {
        StepNote(NativeStrings.Onboarding.confirmCleartextHint)
      }
    }
  }
}

/// Advanced: how the proxy in front of the gateway lets Hermie through.
struct AdvancedSection: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    Section {
      DisclosureGroup(Strings.App.Onboarding.Address.advanced, isExpanded: $model.advancedShown) {
        Picker(Strings.App.Onboarding.Address.FrontDoor.label, selection: $model.frontDoorKind) {
          Text(Strings.App.Onboarding.Address.FrontDoor.custom).tag(OnboardingModel.FrontDoorKind.custom)
          Text(Strings.App.Onboarding.Address.FrontDoor.cloudflare).tag(OnboardingModel.FrontDoorKind.cloudflareAccess)
        }
        .accessibilityIdentifier("hermie.onboarding.frontDoor")

        switch model.frontDoorKind {
        case .cloudflareAccess:
          AccessFields(model: model)
        case .custom:
          HeaderRows(model: model)
        }
      }
      .accessibilityIdentifier("hermie.onboarding.advanced")
      if model.advancedShown {
        StepNote(footer)
      }
    }
  }

  private var footer: String {
    switch model.frontDoorKind {
    case .cloudflareAccess:
      model.frontDoorWithheld
        ? Strings.App.Onboarding.Address.FrontDoor.insecure : Strings.App.Onboarding.Address.FrontDoor.cloudflareHint
    case .custom:
      Strings.App.Onboarding.Address.advancedHint
    }
  }
}

/// The Cloudflare Access service token: an id (filed as the user name) and a secret.
private struct AccessFields: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    TextField(
      Strings.App.Onboarding.Address.FrontDoor.clientId,
      text: $model.accessClientID,
      prompt: Text(Strings.App.Onboarding.Address.FrontDoor.clientIdPlaceholder)
    )
    .textContentType(.username)
    .autocorrectionDisabled()
    #if os(iOS)
      .textInputAutocapitalization(.never)
    #endif
    .accessibilityIdentifier("hermie.onboarding.accessClientId")

    SecureField(Strings.App.Onboarding.Address.FrontDoor.clientSecret, text: $model.accessClientSecret)
      .textContentType(.password)
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
      .accessibilityIdentifier("hermie.onboarding.accessClientSecret")
  }
}

/// Custom headers: a name, a secret value, and the way to remove each.
private struct HeaderRows: View {
  @Bindable var model: OnboardingModel

  var body: some View {
    ForEach($model.headers) { $row in
      VStack(alignment: .leading, spacing: 8) {
        TextField(Strings.App.Onboarding.Address.headerName, text: $row.name, prompt: Text(verbatim: "CF-Access-Client-Id"))
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif

        if let problem = model.headerProblem(row) {
          Text(OnboardingMessages.headerProblem(problem))
            .font(.footnote)
            .foregroundStyle(.red)
        }

        SecureField(Strings.App.Onboarding.Address.headerValue, text: $row.value)
          .textContentType(.password)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif

        Button(Strings.App.Common.remove, role: .destructive) {
          model.removeHeader(row.id)
        }
        .accessibilityLabel(Strings.App.Onboarding.Address.removeHeader(name: row.name))
      }
    }

    Button(Strings.App.Onboarding.Address.addHeader, systemImage: "plus") {
      model.addHeader()
    }
    .accessibilityIdentifier("hermie.onboarding.addHeader")
  }
}
