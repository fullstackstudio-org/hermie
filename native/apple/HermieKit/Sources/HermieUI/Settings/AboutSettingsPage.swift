import HermieCore
import SwiftUI

/// Settings → About: exactly which build this is, and the licences (a later build).
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
          Form {
            Section {
              Text(NativeStrings.later)
            } footer: {
              SettingsNote(Strings.App.Settings.licencesHint)
            }
          }
          .formStyle(.grouped)
          .navigationTitle(Strings.App.Settings.licences)
        }
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.settings.about")
  }
}
