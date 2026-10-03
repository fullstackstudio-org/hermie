import HermieCore
import HermieGateway
import SwiftUI

/**
 Settings → Account: who this device is signed in as on the live gateway (`/api/auth/me`), and the
 way to sign out of it. A gateway that is signed out offers to sign in again.
 */
struct AccountSettingsPage: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(GatewayAccounts.self) private var accounts: GatewayAccounts?
  @Environment(\.shellComponents) private var components

  @State private var identity: Phase = .loading
  @State private var confirmingSignOut = false
  @State private var signingIn: String?

  enum Phase: Equatable {
    case loading
    case loaded(AuthIdentity)
    case failed
  }

  var body: some View {
    let active = launch.gateways.active

    Form {
      if let active, let accounts {
        Section {
          LabeledContent(Strings.App.Settings.gateway, value: active.displayLabel)
          LabeledContent(Strings.App.Settings.address) {
            Text(active.address)
              .textSelection(.enabled)
          }

          switch accounts.status(for: active.id) {
          case .signedOut:
            Text(Strings.App.Settings.Gateways.signedOut)
              .accessibilityIdentifier("hermie.settings.account.signedOut")
          case .signedIn, .unknown:
            identityRows
          }
        } header: {
          SettingsNote(Strings.App.Settings.account)
        }

        Section {
          if accounts.status(for: active.id) == .signedOut {
            // Drawn in the primary colour: the tint and the destructive red both fall short of the
            // contrast audit at body size on a grouped row.
            Button {
              signingIn = active.id
            } label: {
              Label(Strings.App.Common.signIn, systemImage: "person.badge.key")
                .foregroundStyle(Color.primary)
            }
            .accessibilityIdentifier("hermie.settings.account.signIn")
          } else {
            Button(role: .destructive) {
              confirmingSignOut = true
            } label: {
              Label(Strings.App.Settings.signOut, systemImage: "rectangle.portrait.and.arrow.right")
                .foregroundStyle(Color.primary)
            }
            .accessibilityIdentifier("hermie.settings.account.signOut")
          }
        } footer: {
          SettingsNote(Strings.App.Settings.signOutHint)
        }
      } else {
        Section {
          Text(NativeStrings.Account.noGateway)
        }
      }
    }
    .formStyle(.grouped)
    .task(id: TaskKey(id: active?.id, revision: active.flatMap { accounts?.credentialsRevision[$0.id] } ?? 0)) {
      await load(active?.id)
    }
    .confirmationDialog(
      NativeStrings.Account.signOutConfirm,
      isPresented: $confirmingSignOut,
      titleVisibility: .visible
    ) {
      Button(Strings.App.Settings.signOut, role: .destructive) {
        guard let id = active?.id else { return }

        Task { await accounts?.signOut(id) }
      }
      Button(Strings.App.Common.cancel, role: .cancel) {}
    }
    .sheet(item: Binding(get: { signingIn.map(SheetID.init) }, set: { signingIn = $0?.id })) { sheet in
      components.signIn(SignInContext(gatewayId: sheet.id, finish: { signingIn = nil }))
    }
  }

  @ViewBuilder
  private var identityRows: some View {
    switch identity {
    case .loading:
      StatusLine(text: NativeStrings.Account.loading, tone: .checking)
    case .failed:
      StatusLine(text: NativeStrings.Account.failed, tone: .error)
    case .loaded(let me):
      let name = [me.displayName, me.email, me.userID].first { !$0.isEmpty }

      if let name {
        LabeledContent(Strings.App.Settings.user, value: name)
          .accessibilityIdentifier("hermie.settings.account.user")
      }

      if !me.email.isEmpty, me.email != name {
        LabeledContent(Strings.App.Settings.email, value: me.email)
      }

      if !me.userID.isEmpty, me.userID != name {
        LabeledContent(NativeStrings.Account.userId, value: me.userID)
      }

      if !me.provider.isEmpty, me.provider != "none" {
        LabeledContent(Strings.App.Settings.provider, value: me.provider)
      }
    }
  }

  private func load(_ id: String?) async {
    guard let id, let accounts else {
      return
    }

    await accounts.refresh()

    guard accounts.status(for: id) == .signedIn else {
      return
    }

    identity = .loading

    do {
      identity = .loaded(try await accounts.identity(for: id))
    } catch {
      if !Task.isCancelled {
        identity = .failed
      }
    }
  }

  private struct TaskKey: Equatable {
    var id: String?
    var revision: Int
  }
}

/// A gateway id, as a sheet's item.
struct SheetID: Identifiable, Hashable {
  let id: String
}
