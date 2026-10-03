import HermieCore
import SwiftUI

extension EnvironmentValues {
  /**
   Open sign-in for a gateway that needs one on this device: one added from iCloud Keychain whose
   sign-in cannot travel (an identity provider or a password, I6), or whose session token was not
   there. Settings → Gateways sets it to its own "Sign in" sheet, and the iCloud Sync page to a sheet
   of its own; where nobody set it, the gateway shows "Sign in needed" with no button. A finished
   sign-in reaches `ICloudSyncModel.signedIn(_:)` through `GatewayAccounts.signedIn(_:)`.
   */
  @Entry public var onNeedsSignIn: NeedsSignInAction? = nil
}

/// The sign-in seam for a gateway id (see `EnvironmentValues.onNeedsSignIn`).
public struct NeedsSignInAction {
  private let handler: @MainActor (String) -> Void

  public init(_ handler: @escaping @MainActor (String) -> Void) {
    self.handler = handler
  }

  @MainActor
  public func callAsFunction(_ gatewayId: String) {
    handler(gatewayId)
  }
}

/// The row to Settings → Gateways → iCloud Sync, with the sync state and the number of notices.
struct ICloudSyncGatewaySections: View {
  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let model = launch.iCloudSync

    Section {
      NavigationLink {
        ICloudSyncSettingsPage()
      } label: {
        LabeledContent(NativeStrings.ICloud.title) {
          Text(ICloudSyncText.phaseTitle(model.phase))
        }
      }
      .badge(model.attentionCount)
      .accessibilityIdentifier("hermie.settings.icloud")
    }
  }
}

/// The gateways iCloud Keychain holds that are not on this device, under the list.
struct ICloudSyncAvailableSection: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(\.onNeedsSignIn) private var onNeedsSignIn

  var body: some View {
    let model = launch.iCloudSync

    // While sync runs here: the offers are what this device does not have. Off or unanswered, the
    // page and the disclosure speak for them.
    if model.isActive, !model.available.isEmpty {
      Section {
        ForEach(model.available) { offer in
          AvailableGatewayRow(offer: offer) {
            Task {
              if let result = await model.add(offer), result.needsSignIn, let id = result.gatewayId {
                onNeedsSignIn?(id)
              }
            }
          }
          .disabled(model.busy)
        }
      } header: {
        SettingsNote(NativeStrings.ICloud.Available.header)
      } footer: {
        SettingsNote(NativeStrings.ICloud.Available.footer)
      }
    }
  }
}

private struct AvailableGatewayRow: View {
  let offer: ICloudSyncModel.AvailableGateway
  let add: () -> Void

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(offer.name)
          .font(.body.weight(.semibold))
        Text(offer.address)
          .font(.footnote)
        if offer.removedHere {
          Text(NativeStrings.ICloud.Available.removedHere)
            .font(.footnote)
        }
        if offer.needsSignIn {
          Text(NativeStrings.ICloud.Available.signInAfter)
            .font(.footnote)
        }
      }
      .accessibilityElement(children: .combine)

      Spacer()

      Button(NativeStrings.ICloud.Available.add, action: add)
        .buttonStyle(.borderless)
        .accessibilityHint(offer.name)
        .accessibilityIdentifier("hermie.settings.icloud.available.add")
    }
  }
}

/// The marks for a gateway's row on the Gateways page.
enum ICloudGatewayBadge {
  static func label(_ badge: ICloudSyncModel.Badge) -> String {
    switch badge {
    case .synced: NativeStrings.ICloud.Badge.synced
    case .waiting: NativeStrings.ICloud.Phase.waiting
    case .thisDeviceOnly: NativeStrings.ICloud.State.thisDeviceOnly
    }
  }
}

/// The words for the model's states, shared by the page, the row and the badges.
enum ICloudSyncText {
  /// The line under a gateway's address on the Gateways page: synced, waiting, this device only, or
  /// "Sign in needed". Nil while sync is off here. Words only: a symbol inside the text is read out
  /// by name, and the audit takes text with an inline image for text that may clip.
  @MainActor
  static func badge(_ model: ICloudSyncModel, gatewayId: String) -> Text? {
    if model.signInNeeded.contains(gatewayId) {
      return Text(NativeStrings.ICloud.State.signInNeeded)
    }

    return model.badge(for: gatewayId).map { Text(ICloudGatewayBadge.label($0)) }
  }

  static func phaseTitle(_ phase: ICloudSyncModel.Phase) -> String {
    switch phase {
    case .checking: NativeStrings.ICloud.Phase.checking
    case .unavailable: NativeStrings.ICloud.Phase.unavailable
    case .newerVersion: NativeStrings.ICloud.Phase.newerVersion
    case .off: NativeStrings.ICloud.Phase.off
    case .awaitingAnswer: NativeStrings.ICloud.Phase.awaiting
    case .syncing: NativeStrings.ICloud.Phase.syncing
    case .failed: NativeStrings.ICloud.Phase.failed
    case .upToDate: NativeStrings.ICloud.Phase.upToDate
    case .waiting: NativeStrings.ICloud.Phase.waiting
    }
  }

  /// Why, or what to do; nil when the title says enough.
  static func phaseDetail(_ phase: ICloudSyncModel.Phase) -> String? {
    switch phase {
    case .unavailable: NativeStrings.ICloud.Phase.unavailableDetail
    case .newerVersion: NativeStrings.ICloud.Phase.newerVersionDetail
    case .off: NativeStrings.ICloud.Phase.offDetail
    case .awaitingAnswer: NativeStrings.ICloud.Phase.awaitingDetail
    case let .failed(failure): failureDetail(failure)
    case .checking, .syncing, .upToDate, .waiting: nil
    }
  }

  static func failureDetail(_ failure: ICloudSyncModel.Failure) -> String {
    switch failure {
    case .locked: NativeStrings.ICloud.Failure.locked
    case .keychain: NativeStrings.ICloud.Failure.keychain
    case .storage: NativeStrings.ICloud.Failure.storage
    case .newerVersion: NativeStrings.ICloud.Failure.newerVersion
    case .other: NativeStrings.ICloud.Failure.other
    }
  }

  static func gatewayState(_ state: ICloudSyncModel.GatewayState) -> String {
    switch state {
    case .off: NativeStrings.ICloud.State.off
    case .waiting: NativeStrings.ICloud.Phase.waiting
    case .synced: NativeStrings.ICloud.State.synced
    case .notInICloud: NativeStrings.ICloud.State.notInICloud
    case .removedElsewhereKeptHere: NativeStrings.ICloud.State.removedElsewhere
    case .thisDeviceOnly: NativeStrings.ICloud.State.thisDeviceOnly
    case .sameAddressAsAnother: NativeStrings.ICloud.State.sameAddress
    case .newerVersion: NativeStrings.ICloud.State.newerVersion
    }
  }
}
