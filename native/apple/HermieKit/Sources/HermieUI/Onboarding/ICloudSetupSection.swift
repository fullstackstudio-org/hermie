import HermieCore
import SwiftUI

/**
 Setup's first step, when iCloud Keychain holds gateways that are not on this device: what they are,
 and one action that takes them all. The footer says what is stored in iCloud Keychain and where,
 which is what taking them agrees to; a gateway whose sign-in cannot travel continues with the
 sign-in step (`OnboardingFlow`).
 */
struct ICloudSetupSection: View {
  let use: ([ICloudSyncModel.AddResult]) -> Void

  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let model = launch.iCloudSync

    if !model.available.isEmpty {
      Section {
        ForEach(model.available) { offer in
          VStack(alignment: .leading, spacing: 2) {
            Text(offer.name)
              .font(.body.weight(.semibold))
            Text(offer.address)
              .font(.footnote)
            if offer.needsSignIn {
              Text(NativeStrings.ICloud.Available.signInAfter)
                .font(.footnote)
            }
          }
          .accessibilityElement(children: .combine)
        }

        Button(NativeStrings.ICloud.Available.useAll) {
          Task { use(await model.useAvailable()) }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("hermie.onboarding.icloud.use")
      } header: {
        SettingsNote(NativeStrings.ICloud.Available.header)
      } footer: {
        SettingsNote(NativeStrings.ICloud.footer)
      }
    }
  }
}
