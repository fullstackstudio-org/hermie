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

  var body: some View {
    let directory = launch.gateways

    Form {
      Section {
        ForEach(directory.entries) { entry in
          Button {
            guard entry.id != directory.activeId else { return }
            Task { try? await directory.activate(id: entry.id) }
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              GatewayRowLabel(entry: entry, active: entry.id == directory.activeId)

              if let line = accountLine(for: entry) {
                Text(line)
                  .font(.footnote)
              }
            }
            .accessibilityElement(children: .combine)
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(entry.id == directory.activeId ? .isSelected : [])
          .accessibilityHint(entry.id == directory.activeId ? "" : Strings.App.Settings.Gateways.connectHint)
          .accessibilityIdentifier("hermie.settings.gateway")
          .contextMenu { actions(for: entry) }
          #if os(iOS)
            .swipeActions { actions(for: entry) }
          #endif
          .accessibilityActions { actions(for: entry) }
        }
      } header: {
        SettingsNote(Strings.App.Settings.Gateways.header)
      } footer: {
        SettingsNote(Strings.App.Settings.Gateways.hint)
      }
    }
    .formStyle(.grouped)
    .task { await directory.settingsOpened() }
    .toolbar {
      // In the toolbar rather than as a row: a button row in a form fails the Dynamic Type audit.
      ToolbarItem(placement: .primaryAction) {
        Button(Strings.App.Settings.Gateways.add, systemImage: "plus") {
          onAddGateway()
        }
        .accessibilityHint(Strings.App.Settings.Gateways.addHint)
        .accessibilityIdentifier("hermie.settings.gateways.add")
      }
    }
    .alert(
      Strings.App.Settings.Gateways.name,
      isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
      presenting: renaming
    ) { entry in
      TextField(Strings.App.Settings.Gateways.name, text: $draftName)
      Button(Strings.App.Common.cancel, role: .cancel) {}
      Button(Strings.App.Settings.Gateways.save) {
        let name = draftName

        Task { try? await directory.rename(id: entry.id, to: name) }
      }
    } message: { _ in
      Text(Strings.App.Settings.Gateways.nameHint)
    }
    .task { await accounts?.refresh() }
    .sheet(item: Binding(get: { signingIn.map(SheetID.init) }, set: { signingIn = $0?.id })) { sheet in
      components.signIn(SignInContext(gatewayId: sheet.id, finish: { signingIn = nil }))
    }
    .confirmationDialog(
      NativeStrings.Account.signOutConfirm,
      isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
      titleVisibility: .visible,
      presenting: signingOut
    ) { entry in
      Button(Strings.App.Settings.Gateways.signOut, role: .destructive) {
        Task { await accounts?.signOut(entry.id) }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    }
    .confirmationDialog(
      Strings.App.Settings.Gateways.removeConfirm,
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible,
      presenting: removing
    ) { entry in
      Button(Strings.App.Settings.Gateways.removeConfirmAction, role: .destructive) {
        // Through the accounts: the grant is handed back before the engine removes the gateway.
        Task {
          if let accounts {
            try? await accounts.remove(entry.id)
          } else {
            try? await directory.remove(id: entry.id)
          }
        }
      }
      Button(Strings.App.Settings.Gateways.keepIt, role: .cancel) {}
    } message: { _ in
      Text(Strings.App.Settings.Gateways.removeHint)
    }
  }

  @ViewBuilder
  private func actions(for entry: GatewayDirectory.Entry) -> some View {
    Button(NativeStrings.Gateways.rename, systemImage: "pencil") {
      draftName = entry.name
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
