import HermieCore
import SwiftUI

/**
 What the live gateway says about itself, under the list in Settings → Gateways: its version and
 whether its Hermie plugin is there (`Gateways.tsx` in the Expo app).

 - **Version.** What the gateway's own status said when it was set up (`StoredGatewayConfig.version`);
   "Unknown" for one set up before it was kept.
 - **Plugin.** Whether the gateway-side plugin is there decides whether notifications can come from the
   gateway at all. "Checking…" until a roster has actually arrived, never "Not installed": the two look
   the same for a second and only one of them is a reason to send somebody to a shell
   (`PluginPresence`).

 Both are about the gateway the app is connected to: with none live the plugin row says it is checking,
 and the rows are not drawn at all with no gateway configured.
 */
struct LiveGatewayFactsSection: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(GatewayAccounts.self) private var accounts: GatewayAccounts?
  @Environment(LiveGateway.self) private var live: LiveGateway?

  @State private var version: String?

  var body: some View {
    if let active = launch.gateways.active {
      Section {
        LabeledContent(Strings.App.Settings.version, value: Self.versionText(version))
          .accessibilityIdentifier("hermie.settings.gateways.version")

        LabeledContent(Strings.App.Settings.plugin, value: Self.pluginText(presence(of: active.id)))
          .accessibilityIdentifier("hermie.settings.gateways.plugin")
      } header: {
        SettingsNote(active.displayLabel)
      }
      .task(id: active.id) {
        version = await accounts?.config(for: active.id)?.version
      }
    }
  }

  /// The plugin's state on the gateway with this id, when it is the live one.
  private func presence(of id: String) -> PluginPresence {
    guard let live, live.gatewayID == id, let session = live.session else {
      return .unknown
    }

    return session.pluginPresence
  }

  static func versionText(_ version: String?) -> String {
    guard let version, !version.trimmingCharacters(in: .whitespaces).isEmpty else {
      return Strings.App.Settings.unknown
    }

    return version
  }

  static func pluginText(_ presence: PluginPresence) -> String {
    switch presence {
    case .unknown: Strings.App.Settings.pluginUnknown
    case .installed(let version): Strings.App.Settings.pluginInstalled(version: version)
    case .absent: Strings.App.Settings.pluginAbsent
    }
  }
}
