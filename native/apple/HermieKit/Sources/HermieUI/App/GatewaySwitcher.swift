import HermieCore
import SwiftUI

/// Carry out what a router transition asked for.
@MainActor
func perform(_ effects: [RouterEffect], on launch: AppLaunch) {
  for effect in effects {
    switch effect {
    case let .activateGateway(id):
      Task {
        try? await launch.gateways.activate(id: id)
      }
    }
  }
}

extension GatewayDirectory {
  /// What the router needs to know, or nil before the registry has been read.
  var routerIndex: GatewayIndex? {
    guard loaded else {
      return nil
    }

    return GatewayIndex(entries: entries.map { GatewayIndex.Entry(id: $0.id, key: $0.key) }, activeId: activeId)
  }
}

/// The toolbar's gateway menu: the configured gateways, the live one checked, and setup for another.
struct GatewaySwitcherMenu: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  var body: some View {
    let directory = launch.gateways

    Menu {
      Section(Strings.App.Settings.Gateways.title) {
        ForEach(directory.entries) { entry in
          Toggle(
            isOn: Binding(
              get: { entry.id == router.selectedGatewayId },
              set: { on in
                if on { perform(router.switchGateway(to: entry.id), on: launch) }
              }
            )
          ) {
            Text(entry.name)
          }
        }
      }

      Divider()

      Button(Strings.App.Settings.Gateways.add, systemImage: "plus") {
        router.present(.onboarding(.additionalGateway))
      }
    } label: {
      Label(Strings.App.Settings.Gateways.title, systemImage: "server.rack")
    }
    .accessibilityValue(directory.entry(id: router.selectedGatewayId)?.name ?? "")
    .accessibilityIdentifier("hermie.toolbar.gateways")
  }
}

/// The gateway picker the Switch Gateway command opens.
struct GatewayPickerSheet: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  var body: some View {
    NavigationStack {
      List(launch.gateways.entries) { entry in
        Button {
          perform(router.switchGateway(to: entry.id), on: launch)
        } label: {
          GatewayRowLabel(entry: entry, active: entry.id == router.selectedGatewayId)
        }
        .accessibilityAddTraits(entry.id == router.selectedGatewayId ? .isSelected : [])
      }
      .navigationTitle(Strings.App.Settings.Gateways.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) { router.dismissSheet() }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 360, minHeight: 280)
    #endif
  }
}

/// One gateway as a row: its name, its address, and whether it is the live one. `note` is an
/// optional third line (Settings puts the gateway's iCloud Sync state there).
struct GatewayRowLabel: View {
  let entry: GatewayDirectory.Entry
  let active: Bool
  var note: Text?

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(entry.name)
          .font(.body.weight(.semibold))
        Text(entry.address)
          .font(.footnote)
        if let note {
          note
            .font(.footnote)
        }
      }

      Spacer()

      if active {
        Text(Strings.App.Settings.Gateways.active)
          .font(.footnote)
        Image(systemName: "checkmark")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
  }
}
