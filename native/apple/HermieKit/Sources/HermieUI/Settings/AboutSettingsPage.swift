import HermieCore
import SwiftUI

/// Settings → About: exactly which build this is, and the licences.
struct AboutSettingsPage: View {
  var info: BuildInfo = .main

  var body: some View {
    Form {
      Section {
        LabeledContent(Strings.App.Settings.version, value: info.version)
        LabeledContent(NativeStrings.About.build, value: info.build)
        LabeledContent(NativeStrings.About.commit) {
          Text(info.commit)
            .monospaced()
            .textSelection(.enabled)
        }
      } footer: {
        SettingsNote(SettingsCategory.about.blurb)
      }

      Section {
        NavigationLink(Strings.App.Settings.licences) {
          LicencesPage()
        }
        .accessibilityIdentifier("hermie.settings.about.licences")
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.settings.about")
  }
}
