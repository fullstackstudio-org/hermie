import HermieCore
import SwiftUI

/**
 Setup's first step, when iCloud Keychain holds gateways that are not on this device: what they are,
 and one action that takes them all. The footer says what is stored in iCloud Keychain and where,
 which is what taking them agrees to; a gateway whose sign-in cannot travel continues with the
 sign-in step (`OnboardingFlow`).

 Only where taking them may answer the disclosure (`ICloudSyncModel.setupCanUseAvailable`): on a
 device that already has gateways and has not answered, the section is left out, and the
 disclosure, which lists these too, asks first once setup closes.
 */
struct ICloudSetupSection: View {
  let use: ([ICloudSyncModel.AddResult]) -> Void

  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let model = launch.iCloudSync

    if !model.available.isEmpty, model.setupCanUseAvailable {
      Section {
        ForEach(model.available) { offer in
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
        }

        if let failure = model.actionFailure {
          Text(verbatim: "\(NativeStrings.ICloud.actionFailed) \(ICloudSyncText.failureDetail(failure))")
            .accessibilityIdentifier("hermie.onboarding.icloud.failed")
        }

        Button(NativeStrings.ICloud.Available.useAll) {
          Task {
            let results = await model.useAvailable()
            // Nothing added (a failure, said above): setup stays where it is.
            if !results.isEmpty { use(results) }
          }
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
