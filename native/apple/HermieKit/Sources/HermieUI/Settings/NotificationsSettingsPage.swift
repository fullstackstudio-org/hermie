import HermieCore
import SwiftUI

/**
 Settings → Notifications: the switch, what the system allows, and where each gateway's relay
 registration stands. A debug build adds a developer row per gateway (handle prefix, last refresh)
 and the APNs environment.

 Turning the switch on is the one place the system's permission question is asked. Which kinds of
 notification a gateway sends, and previews, belong to the push row on the gateway (a later task).
 */
struct NotificationsSettingsPage: View {
  @Environment(AppLaunch.self) private var launch
  @State private var confirmingReset = false

  var body: some View {
    let push = launch.push

    Form {
      Section {
        Toggle(
          Strings.App.Settings.Notifications.enabled,
          isOn: Binding(get: { push.enabled }, set: { on in Task { await push.setEnabled(on) } })
        )
        // Before push has read its own state, a switch here would act on an unknown one.
        .disabled(!push.started)
        .accessibilityIdentifier("hermie.settings.notifications.enabled")

        if push.enabled, let status = statusLine(push) {
          Text(status)
            .accessibilityIdentifier("hermie.settings.notifications.status")
        }

        if push.switchWriteFailed {
          Text(NativeStrings.Push.switchWriteFailed)
            .accessibilityIdentifier("hermie.settings.notifications.switchWriteFailed")
        }

        if push.enabled, push.permission == .denied {
          Button(Strings.App.Settings.Notifications.openSystemSettings) {
            push.system.openSettings()
          }
          .accessibilityIdentifier("hermie.settings.notifications.openSystemSettings")
        }
      } footer: {
        SettingsNote(Strings.App.Settings.Notifications.enabledHint)
      }

      if let trouble = push.trouble {
        Section {
          Text(trouble == .settingsUnreadable ? NativeStrings.Push.troubleSettings : NativeStrings.Push.troubleRegistrations)
          Button(NativeStrings.Push.reset, role: .destructive) {
            confirmingReset = true
          }
          .accessibilityIdentifier("hermie.settings.notifications.reset")
        } footer: {
          SettingsNote(NativeStrings.Push.resetHint)
        }
      }

      if !push.resetLeftovers.isEmpty {
        Text(NativeStrings.Push.resetLeftovers)
      }

      if push.enabled, !launch.gateways.entries.isEmpty {
        Section {
          ForEach(launch.gateways.entries) { entry in
            VStack(alignment: .leading, spacing: 4) {
              LabeledContent(entry.name) {
                Text(stateLabel(push.state(for: entry.id)))
              }

              if case .cannotDeliver(let problem) = push.deliveries[entry.id] {
                Text(problem == .pluginTooOld ? NativeStrings.Push.cannotDeliverPlugin : NativeStrings.Push.cannotDeliverRelay)
                  .font(.footnote)
                  .accessibilityIdentifier("hermie.settings.notifications.cannotDeliver")
              }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("hermie.settings.notifications.gateway")
          }
        } header: {
          SettingsNote(Strings.App.Settings.Notifications.status)
        }
      }

      #if DEBUG
        DeveloperSection(push: push, entries: launch.gateways.entries)
      #endif
    }
    .formStyle(.grouped)
    .confirmationDialog(NativeStrings.Push.reset, isPresented: $confirmingReset, titleVisibility: .visible) {
      Button(NativeStrings.Push.reset, role: .destructive) {
        Task { await push.resetDevice() }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: {
      Text(NativeStrings.Push.resetHint)
    }
  }

  /// One sentence about the device as a whole, or nil when the gateway rows say enough.
  private func statusLine(_ push: PushController) -> String? {
    switch push.permission {
    case .denied:
      return Strings.App.Settings.Notifications.statusDenied
    case .undetermined:
      return Strings.App.Settings.Notifications.statusOff
    case .granted:
      if let failure = push.tokenFailure {
        return Strings.App.Settings.Notifications.statusFailed(message: failure)
      }

      return push.hasToken ? nil : Strings.App.Settings.Notifications.statusPending
    }
  }

  private func stateLabel(_ state: PushGatewayState) -> String {
    switch state {
    case .off: NativeStrings.Push.notRegistered
    case .signedOut: NativeStrings.Push.signedOut
    case .waiting: NativeStrings.Push.waiting
    case .registered: NativeStrings.Push.registered
    case .limited: NativeStrings.Push.limited
    case .failed: NativeStrings.Push.failed
    }
  }
}

#if DEBUG
  /// Debug builds: what a developer needs to match a device against the relay's log.
  private struct DeveloperSection: View {
    let push: PushController
    let entries: [GatewayDirectory.Entry]

    var body: some View {
      Section {
        LabeledContent(NativeStrings.Push.environment) {
          Text(verbatim: "\(push.environment.rawValue) (\(push.environmentSource.rawValue))")
        }

        LabeledContent(NativeStrings.Push.relay) {
          Text(verbatim: push.relay)
        }

        ForEach(entries) { entry in
          if let registration = push.registrations[entry.id] {
            LabeledContent(entry.name) {
              VStack(alignment: .trailing) {
                Text(verbatim: PushRelay.handlePrefix(registration.handle) + "…")
                  .monospaced()
                Text(Date(timeIntervalSince1970: registration.refreshedAt), format: .dateTime)
              }
            }
            .accessibilityElement(children: .combine)
          }

          if push.undecodable.contains(entry.id) {
            LabeledContent(entry.name) {
              Text(verbatim: "stored registration unreadable")
            }
          }

          if case .failed(let failure) = push.state(for: entry.id) {
            LabeledContent(entry.name) {
              Text(verbatim: Self.describe(failure))
            }
          }
        }
      } header: {
        SettingsNote(NativeStrings.Push.developer)
      }
    }

    private static func describe(_ failure: PushPassFailure) -> String {
      switch failure {
      case .relay(let error): error.description
      case .storage: "storage"
      }
    }
  }
#endif
