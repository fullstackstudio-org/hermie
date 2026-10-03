import HermieCore
import SwiftUI

/**
 Settings → Gateways: every configured gateway, the live one marked, and whether this device is
 signed in to it. Choosing another switches to it; each row can be renamed (on this device only),
 signed out of (the address stays) or into again, or removed, after a confirmation, together with
 everything stored for it. "Add gateway" opens setup and leaves the live gateway connected.
 */
struct GatewaysSettingsPage: View {
  let onAddGateway: @MainActor () -> Void

  @Environment(AppLaunch.self) private var launch
  @Environment(GatewayAccounts.self) private var accounts: GatewayAccounts?
  @Environment(\.shellComponents) private var components
  @State private var renaming: GatewayDirectory.Entry?
  @State private var draftName = ""
  @State private var removing: GatewayDirectory.Entry?
  @State private var signingIn: String?
  @State private var signingOut: GatewayDirectory.Entry?
  /// Why the last removal did not happen, until the alert is put away.
  @State private var removalFailure: String?

  var body: some View {
    gatewayList
      .formStyle(.grouped)
      // A gateway taken from iCloud that needs a sign-in here opens the same sheet as "Sign in".
      .environment(\.onNeedsSignIn, NeedsSignInAction { signingIn = $0 })
      .task { await launch.gateways.settingsOpened() }
      .task { await accounts?.refresh() }
      .toolbar { addGatewayButton }
      .modifier(RenameAlert(entry: $renaming, draftName: $draftName, save: rename))
      .sheet(item: signInSheet) { sheet in
        components.signIn(SignInContext(gatewayId: sheet.id, finish: { signingIn = nil }))
      }
      .modifier(SignOutDialog(entry: $signingOut, signOut: signOut))
      .modifier(RemoveDialog(entry: $removing, model: launch.iCloudSync, remove: remove))
      .modifier(RemovalFailureAlert(message: $removalFailure))
  }

  private var gatewayList: some View {
    Form {
      ICloudSyncGatewaySections()

      Section {
        ForEach(launch.gateways.entries) { entry in
          gatewayRow(entry)
          GatewayNameField(entry: entry) { name in rename(entry, to: name) }
        }
      } header: {
        SettingsNote(Strings.App.Settings.Gateways.header)
      } footer: {
        SettingsNote(Strings.App.Settings.Gateways.hint)
      }

      PasskeysGatewaySection()

      ICloudSyncAvailableSection()
    }
  }

  private func gatewayRow(_ entry: GatewayDirectory.Entry) -> some View {
    let directory = launch.gateways
    let isActive = entry.id == directory.activeId

    return Button {
      guard !isActive else { return }
      Task { try? await directory.activate(id: entry.id) }
    } label: {
      gatewayRowLabel(entry, isActive: isActive)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isActive ? .isSelected : [])
    .accessibilityHint(isActive ? "" : Strings.App.Settings.Gateways.connectHint)
    .accessibilityIdentifier("hermie.settings.gateway")
    .contextMenu { actions(for: entry) }
    #if os(iOS)
      .swipeActions { actions(for: entry) }
    #endif
    .accessibilityActions { actions(for: entry) }
  }

  private func gatewayRowLabel(_ entry: GatewayDirectory.Entry, isActive: Bool) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      GatewayRowLabel(
        entry: entry, active: isActive,
        note: ICloudSyncText.badge(launch.iCloudSync, gatewayId: entry.id))

      if let line = accountLine(for: entry) {
        Text(line)
          .font(.footnote)
      }
    }
    .accessibilityElement(children: .combine)
  }

  // In the toolbar rather than as a row: a button row in a form fails the Dynamic Type audit.
  @ToolbarContentBuilder
  private var addGatewayButton: some ToolbarContent {
    ToolbarItem(placement: .primaryAction) {
      Button(Strings.App.Settings.Gateways.add, systemImage: "plus") {
        onAddGateway()
      }
      .accessibilityHint(Strings.App.Settings.Gateways.addHint)
      .accessibilityIdentifier("hermie.settings.gateways.add")
    }
  }

  private var signInSheet: Binding<SheetID?> {
    Binding(get: { signingIn.map(SheetID.init) }, set: { signingIn = $0?.id })
  }

  private func rename(_ entry: GatewayDirectory.Entry, to name: String) {
    let directory = launch.gateways

    Task { try? await directory.rename(id: entry.id, to: name) }
  }

  private func signOut(_ entry: GatewayDirectory.Entry) {
    Task { await accounts?.signOut(entry.id) }
  }

  /// Through the accounts: the engine checks the scope, then the grant is handed back, then the
  /// engine removes the gateway. A removal that did not happen says so.
  private func remove(_ entry: GatewayDirectory.Entry, scope: RemovalScope) {
    let directory = launch.gateways

    Task {
      do {
        if let accounts {
          try await accounts.remove(entry.id, scope: scope)
        } else {
          try await directory.remove(id: entry.id, scope: scope)
        }
      } catch SyncEngineError.unknownGateway {
        // Already gone (removed elsewhere meanwhile): what the person asked for.
      } catch SyncEngineError.notAttached {
        removalFailure = NativeStrings.Gateways.RemoveFailed.notSynced
      } catch {
        removalFailure = NativeStrings.Gateways.RemoveFailed.other
      }
    }
  }

  @ViewBuilder
  private func actions(for entry: GatewayDirectory.Entry) -> some View {
    Button(NativeStrings.Gateways.rename, systemImage: "pencil") {
      draftName = entry.displayLabel
      renaming = entry
    }

    switch accounts?.status(for: entry.id) {
    case .signedIn?:
      Button(Strings.App.Settings.Gateways.signOut, systemImage: "rectangle.portrait.and.arrow.right") {
        signingOut = entry
      }
    case .signedOut?:
      Button(Strings.App.Common.signIn, systemImage: "person.badge.key") {
        signingIn = entry.id
      }
    case .unknown?, nil:
      EmptyView()
    }

    Button(Strings.App.Settings.Gateways.remove, systemImage: "trash", role: .destructive) {
      removing = entry
    }
  }

  /// "Signed in as …" or "Signed out", once known.
  private func accountLine(for entry: GatewayDirectory.Entry) -> String? {
    switch accounts?.status(for: entry.id) {
    case .signedOut?:
      Strings.App.Settings.Gateways.signedOut
    case .signedIn?:
      entry.signedInUser.map { Strings.App.Settings.Gateways.signedInAs(user: $0) }
    case .unknown?, nil:
      nil
    }
  }
}

/**
 The optional name of one gateway, under its row: empty means it goes by its host, which is also the
 prompt. Saved when the field is submitted or left, and followed when it changes elsewhere (a
 rename from the row's menu, or from another device through iCloud Sync) while it is not being typed in.
 */
private struct GatewayNameField: View {
  let entry: GatewayDirectory.Entry
  let save: (String) -> Void

  @State private var draft: String
  @FocusState private var focused: Bool

  init(entry: GatewayDirectory.Entry, save: @escaping (String) -> Void) {
    self.entry = entry
    self.save = save
    _draft = State(initialValue: entry.customName ?? "")
  }

  var body: some View {
    LabeledContent(Strings.App.Settings.Gateways.name) {
      TextField("", text: $draft, prompt: Text(verbatim: entry.host))
        .multilineTextAlignment(.trailing)
        .focused($focused)
        .submitLabel(.done)
        .onSubmit(commit)
        .autocorrectionDisabled()
        #if os(iOS)
          .textInputAutocapitalization(.words)
        #endif
        .accessibilityLabel(Strings.App.Settings.Gateways.name)
        .accessibilityHint(Strings.App.Settings.Gateways.nameHint)
        .accessibilityIdentifier("hermie.settings.gateway.name")
    }
    .onChange(of: focused) { _, isFocused in
      if !isFocused { commit() }
    }
    .onChange(of: entry.customName) { _, next in
      if !focused { draft = next ?? "" }
    }
    .onDisappear(perform: commit)
  }

  private func commit() {
    let cleaned = draft.trimmingCharacters(in: .whitespacesAndNewlines)

    if cleaned != (entry.customName ?? "") {
      save(cleaned)
    }

    draft = cleaned
  }
}

extension Binding {
  /// Whether an optional value is set; putting it away clears the value.
  fileprivate func isPresent<Wrapped: Sendable>() -> Binding<Bool> where Value == Wrapped? {
    Binding<Bool>(get: { wrappedValue != nil }, set: { if !$0 { wrappedValue = nil } })
  }
}

/// Rename: a name field, on this device only.
private struct RenameAlert: ViewModifier {
  @Binding var entry: GatewayDirectory.Entry?
  @Binding var draftName: String
  let save: (GatewayDirectory.Entry, String) -> Void

  func body(content: Content) -> some View {
    content.alert(
      Strings.App.Settings.Gateways.name,
      isPresented: $entry.isPresent(),
      presenting: entry
    ) { entry in
      TextField(Strings.App.Settings.Gateways.name, text: $draftName)
      Button(Strings.App.Common.cancel, role: .cancel) {}
      Button(Strings.App.Settings.Gateways.save) {
        save(entry, draftName)
      }
    } message: { _ in
      Text(Strings.App.Settings.Gateways.nameHint)
    }
  }
}

/// Sign out: the address stays.
private struct SignOutDialog: ViewModifier {
  @Binding var entry: GatewayDirectory.Entry?
  let signOut: (GatewayDirectory.Entry) -> Void

  func body(content: Content) -> some View {
    content.confirmationDialog(
      NativeStrings.Account.signOutConfirm,
      isPresented: $entry.isPresent(),
      titleVisibility: .visible,
      presenting: entry
    ) { entry in
      Button(Strings.App.Settings.Gateways.signOut, role: .destructive) {
        signOut(entry)
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    }
  }
}

/// Remove: after a confirmation, together with everything stored for the gateway.
private struct RemoveDialog: ViewModifier {
  @Binding var entry: GatewayDirectory.Entry?
  let model: ICloudSyncModel
  let remove: (GatewayDirectory.Entry, RemovalScope) -> Void

  func body(content: Content) -> some View {
    content.confirmationDialog(
      title,
      isPresented: $entry.isPresent(),
      titleVisibility: .visible,
      presenting: entry
    ) { entry in
      actions(for: entry)
    } message: { entry in
      Text(message(for: entry))
    }
  }

  private var title: String {
    let synced = entry.map { model.canRemoveFromAllDevices($0.id) } ?? false

    return synced ? NativeStrings.ICloud.Remove.title : Strings.App.Settings.Gateways.removeConfirm
  }

  private func message(for entry: GatewayDirectory.Entry) -> String {
    model.canRemoveFromAllDevices(entry.id)
      ? NativeStrings.ICloud.Remove.message : Strings.App.Settings.Gateways.removeHint
  }

  @ViewBuilder
  private func actions(for entry: GatewayDirectory.Entry) -> some View {
    // A synced gateway: from this device, or from every device (iCloud Sync, ADR-0032).
    if model.canRemoveFromAllDevices(entry.id) {
      Button(NativeStrings.ICloud.Remove.thisDevice, role: .destructive) {
        remove(entry, .thisDevice)
      }
      .accessibilityIdentifier("hermie.settings.gateway.remove.thisDevice")
      Button(NativeStrings.ICloud.Remove.allDevices, role: .destructive) {
        remove(entry, .allDevices)
      }
      .accessibilityIdentifier("hermie.settings.gateway.remove.allDevices")
    } else {
      Button(Strings.App.Settings.Gateways.removeConfirmAction, role: .destructive) {
        remove(entry, .thisDevice)
      }
      .accessibilityIdentifier("hermie.settings.gateway.remove.confirm")
    }
    Button(Strings.App.Settings.Gateways.keepIt, role: .cancel) {}
  }
}

/// Why the last removal did not happen.
private struct RemovalFailureAlert: ViewModifier {
  @Binding var message: String?

  func body(content: Content) -> some View {
    content.alert(
      NativeStrings.Gateways.RemoveFailed.title,
      isPresented: $message.isPresent(),
      presenting: message
    ) { _ in
      Button(Strings.App.Common.dismiss, role: .cancel) {}
    } message: { message in
      Text(message)
    }
  }
}
