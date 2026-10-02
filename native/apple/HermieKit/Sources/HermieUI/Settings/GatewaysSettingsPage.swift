import HermieCore
import SwiftUI

/**
 Settings → Gateways: every configured gateway, the live one marked. Choosing another switches to
 it; each row can be renamed (on this device only) or removed, after a confirmation, together with
 everything stored for it. "Add gateway" opens setup and leaves the live gateway connected.
 */
struct GatewaysSettingsPage: View {
  let onAddGateway: @MainActor () -> Void

  @Environment(AppLaunch.self) private var launch
  @State private var renaming: GatewayDirectory.Entry?
  @State private var draftName = ""
  @State private var removing: GatewayDirectory.Entry?

  var body: some View {
    let directory = launch.gateways

    Form {
      Section {
        ForEach(directory.entries) { entry in
          Button {
            guard entry.id != directory.activeId else { return }
            Task { try? await directory.activate(id: entry.id) }
          } label: {
            GatewayRowLabel(entry: entry, active: entry.id == directory.activeId)
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
    .confirmationDialog(
      Strings.App.Settings.Gateways.removeConfirm,
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible,
      presenting: removing
    ) { entry in
      Button(Strings.App.Settings.Gateways.removeConfirmAction, role: .destructive) {
        Task { try? await directory.remove(id: entry.id) }
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

    Button(Strings.App.Settings.Gateways.remove, systemImage: "trash", role: .destructive) {
      removing = entry
    }
  }
}
