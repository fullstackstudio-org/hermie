import HermieCore
import SwiftUI

/**
 Settings → Gateways → iCloud Sync (ADR-0032): the switch for this device, where sync stands and
 when it last finished, what sync has told the person, one row per gateway with "Sync this
 gateway", and "Delete Everything from iCloud Keychain". Everything it shows and does is
 `ICloudSyncModel`'s; the confirmations say exactly what each destructive action does here and on
 the other devices, including the known limits.
 */
struct ICloudSyncSettingsPage: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(\.shellComponents) private var components

  @State private var confirmingTurnOff = false
  @State private var confirmingDeleteEverything = false
  /// The gateway whose sign-in sheet is up: the same sheet as Settings → Gateways → "Sign in".
  @State private var signingIn: String?
  /// "Turn On App Lock" on the "gateways added" notice (I12) opened the lock picker.
  @State private var openingLock = false

  private var onNeedsSignIn: NeedsSignInAction {
    NeedsSignInAction { signingIn = $0 }
  }

  var body: some View {
    let model = launch.iCloudSync

    return form(model)
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.ICloud.title)
      .accessibilityIdentifier("hermie.settings.icloud.page")
      .navigationDestination(isPresented: $openingLock) {
        LockThresholdPage()
      }
      .modifier(TurnOffDialog(isPresented: $confirmingTurnOff, model: model))
      .modifier(DeleteEverythingDialog(isPresented: $confirmingDeleteEverything, model: model))
      .sheet(item: signInSheet) { sheet in
        components.signIn(SignInContext(gatewayId: sheet.id, finish: { signingIn = nil }))
      }
      .sheet(isPresented: disclosurePresented(model)) {
        ICloudSyncDisclosure()
      }
  }

  private func form(_ model: ICloudSyncModel) -> some View {
    Form {
      noticesSection(model)
      switchSection(model)
      gatewaysSection(model)
      deleteEverythingSection(model)
    }
  }

  @ViewBuilder
  private func noticesSection(_ model: ICloudSyncModel) -> some View {
    if !model.notices.isEmpty {
      Section {
        ForEach(model.notices) { notice in
          ICloudSyncNoticeRow(
            notice: notice, model: model, onNeedsSignIn: onNeedsSignIn, lock: launch.lock,
            openLock: { openingLock = true })
        }
      } header: {
        SettingsNote(NativeStrings.ICloud.Notice.header)
      }
    }
  }

  private func switchSection(_ model: ICloudSyncModel) -> some View {
    Section {
      Toggle(NativeStrings.ICloud.switchLabel, isOn: switchBinding(model))
        .disabled(!model.canChangeSwitch)
        .accessibilityIdentifier("hermie.settings.icloud.switch")

      LabeledContent(NativeStrings.ICloud.status) {
        Text(ICloudSyncText.phaseTitle(model.phase))
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.settings.icloud.status")

      statusDetails(model)

      if model.isActive {
        Button(NativeStrings.ICloud.syncNow) {
          Task { await model.syncNow() }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("hermie.settings.icloud.syncNow")
      }
    } footer: {
      SettingsNote(NativeStrings.ICloud.footer)
    }
  }

  @ViewBuilder
  private func statusDetails(_ model: ICloudSyncModel) -> some View {
    if let detail = ICloudSyncText.phaseDetail(model.phase) {
      Text(detail)
        .accessibilityIdentifier("hermie.settings.icloud.detail")
    }

    if let failure = model.actionFailure {
      Text(verbatim: "\(NativeStrings.ICloud.actionFailed) \(ICloudSyncText.failureDetail(failure))")
        .accessibilityIdentifier("hermie.settings.icloud.actionFailed")
    }

    if model.isActive, let last = model.lastSynced {
      LabeledContent(NativeStrings.ICloud.lastSynced) {
        Text(last, format: .relative(presentation: .named))
      }
      .accessibilityElement(children: .combine)
    }
  }

  @ViewBuilder
  private func gatewaysSection(_ model: ICloudSyncModel) -> some View {
    if model.isActive, !model.rows.isEmpty {
      Section {
        ForEach(model.rows) { row in
          ICloudSyncGatewayRow(row: row, model: model, onNeedsSignIn: onNeedsSignIn)
        }
      } header: {
        SettingsNote(Strings.App.Settings.Gateways.header)
      } footer: {
        SettingsNote(NativeStrings.ICloud.Gateways.footer)
      }
    }
  }

  @ViewBuilder
  private func deleteEverythingSection(_ model: ICloudSyncModel) -> some View {
    if model.status.availability == .available, !model.status.unsupportedState {
      Section {
        // The label colour with a red symbol: red text misses the contrast audit, and the
        // confirmation that follows is the destructive step.
        Button {
          confirmingDeleteEverything = true
        } label: {
          Label {
            Text(NativeStrings.ICloud.DeleteEverything.action)
              .foregroundStyle(Color.primary)
          } icon: {
            Image(systemName: "trash")
              .foregroundStyle(.red)
              .accessibilityHidden(true)
          }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("hermie.settings.icloud.deleteEverything")
      } footer: {
        SettingsNote(NativeStrings.ICloud.DeleteEverything.footer)
      }
    }
  }

  private var signInSheet: Binding<SheetID?> {
    Binding(get: { signingIn.map(SheetID.init) }, set: { signingIn = $0?.id })
  }

  private func disclosurePresented(_ model: ICloudSyncModel) -> Binding<Bool> {
    Binding(get: { model.disclosureRequested && model.showsDisclosure }, set: { _ in })
  }

  /// On asks first when the disclosure is unanswered; off asks whether to remove from iCloud.
  private func switchBinding(_ model: ICloudSyncModel) -> Binding<Bool> {
    Binding(
      get: { model.isOn },
      set: { on in
        if on {
          Task { await model.turnOn() }
        } else if model.isOn {
          confirmingTurnOff = true
        }
      }
    )
  }
}

/// Turning sync off: keep what is in iCloud, or remove it.
private struct TurnOffDialog: ViewModifier {
  @Binding var isPresented: Bool
  let model: ICloudSyncModel

  func body(content: Content) -> some View {
    content.confirmationDialog(
      NativeStrings.ICloud.TurnOff.title, isPresented: $isPresented, titleVisibility: .visible
    ) {
      Button(NativeStrings.ICloud.TurnOff.keep) {
        Task { await model.turnOff(removingFromICloud: false) }
      }
      .accessibilityIdentifier("hermie.settings.icloud.turnOff.keep")
      Button(NativeStrings.ICloud.TurnOff.remove, role: .destructive) {
        Task { await model.turnOff(removingFromICloud: true) }
      }
      .accessibilityIdentifier("hermie.settings.icloud.turnOff.remove")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.ICloud.TurnOff.message)
    }
  }
}

/// "Delete Everything from iCloud Keychain": the destructive confirmation.
private struct DeleteEverythingDialog: ViewModifier {
  @Binding var isPresented: Bool
  let model: ICloudSyncModel

  func body(content: Content) -> some View {
    content.confirmationDialog(
      NativeStrings.ICloud.DeleteEverything.title, isPresented: $isPresented,
      titleVisibility: .visible
    ) {
      Button(NativeStrings.ICloud.DeleteEverything.confirm, role: .destructive) {
        Task { await model.deleteEverything() }
      }
      .accessibilityIdentifier("hermie.settings.icloud.deleteEverything.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.ICloud.DeleteEverything.message)
    }
  }
}

/// One gateway: "Sync this gateway", where it stands, and the action that fixes it.
private struct ICloudSyncGatewayRow: View {
  let row: ICloudSyncModel.GatewayRow
  let model: ICloudSyncModel
  let onNeedsSignIn: NeedsSignInAction?

  var body: some View {
    Toggle(isOn: Binding(get: { row.syncThisGateway }, set: { on in
      Task { await model.setSynced(on, gatewayId: row.id) }
    })) {
      VStack(alignment: .leading, spacing: 2) {
        Text(row.name)
          .font(.body.weight(.semibold))
        Text(ICloudSyncText.gatewayState(row.state))
          .font(.footnote)
        if row.needsSignIn {
          Text(NativeStrings.ICloud.State.signInNeeded)
            .font(.footnote)
        }
      }
    }
    .disabled(!row.canToggle)
    .accessibilityHint(NativeStrings.ICloud.Gateways.syncThisGateway)
    .accessibilityIdentifier("hermie.settings.icloud.gateway")

    if row.canSyncAgain {
      Button(NativeStrings.ICloud.syncAgain) {
        Task { await model.syncAgain(row.id) }
      }
      .accessibilityHint(row.name)
      .accessibilityIdentifier("hermie.settings.icloud.gateway.syncAgain")
    }

    if row.needsSignIn, let onNeedsSignIn {
      Button(Strings.App.Common.signIn) {
        onNeedsSignIn(row.id)
      }
      .accessibilityHint(row.name)
    }
  }
}

/// A notice from sync, with the action that resolves it and a way to put it away.
private struct ICloudSyncNoticeRow: View {
  let notice: ICloudSyncModel.Notice
  let model: ICloudSyncModel
  let onNeedsSignIn: NeedsSignInAction?
  let lock: AppLock
  /// Privacy & security → Require unlock, where every pick authenticates first.
  let openLock: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label {
        VStack(alignment: .leading, spacing: 4) {
          Text(text)
            .fixedSize(horizontal: false, vertical: true)
          if !names.isEmpty {
            Text(names.formatted(.list(type: .and)))
              .font(.body.weight(.semibold))
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      } icon: {
        Image(systemName: symbol)
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)

      HStack {
        if notice.kind == .storeEmptied {
          Button(NativeStrings.ICloud.syncAgain) {
            Task { await model.syncAgain(notice) }
          }
          .buttonStyle(.borderless)
          .disabled(!model.isActive || model.busy)
          .accessibilityIdentifier("hermie.settings.icloud.notice.syncAgain")
        }

        if notice.kind == .needsSignIn, let onNeedsSignIn, let id = notice.gatewayIds.first {
          Button(Strings.App.Common.signIn) {
            onNeedsSignIn(id)
          }
          .buttonStyle(.borderless)
        }

        // I12: a session token came over and nothing locks the app here. The lock never syncs.
        if model.offersAppLock(notice, lock: lock) {
          Button(NativeStrings.ICloud.Notice.turnOnAppLock) {
            openLock()
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("hermie.settings.icloud.notice.appLock")
        }

        Spacer()

        Button(Strings.App.Common.dismiss) {
          model.dismiss(notice)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("hermie.settings.icloud.notice.dismiss")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.settings.icloud.notice")
  }

  private var names: [String] {
    if case let .removedElsewhere(name) = notice.kind { return [name] }
    return model.names(in: notice)
  }

  private var text: String {
    switch notice.kind {
    case .storeEmptied: NativeStrings.ICloud.Notice.storeEmptied
    case .removedElsewhereKeptHere: NativeStrings.ICloud.Notice.keptHere
    case .removedElsewhere: NativeStrings.ICloud.Notice.removedElsewhere
    case .needsSignIn: NativeStrings.ICloud.Notice.needsSignIn
    case .adopted: NativeStrings.ICloud.Notice.adopted
    }
  }

  private var symbol: String {
    switch notice.kind {
    case .storeEmptied: "icloud.slash"
    case .removedElsewhereKeptHere: "exclamationmark.icloud"
    case .removedElsewhere: "trash"
    case .needsSignIn: "person.badge.key"
    case .adopted: "icloud.and.arrow.down"
    }
  }
}
