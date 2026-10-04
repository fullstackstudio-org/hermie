import HermieCore
import HermieProtocol
import SwiftUI

/**
 Settings → Appearance: the colour scheme, the accent colour, the text size of a conversation and
 the language.

 Every choice takes effect where the reader stands. The scheme and the accent are applied by the
 windows themselves (`appAppearance`), the text size by the transcript (`transcriptTextSize`), and
 all three are read from `AppSettings`, so a change shows at once, in every window, behind this
 page too. The scheme belongs to this device; the accent (the theme), and the text size follow the
 account through ui_meta. The language is the system's: Hermie follows the per-app language the
 reader sets in the system settings (D20), so this page shows it and says where to change it.
 */
struct AppearanceSettingsPage: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(\.openURL) private var openURL

  var body: some View {
    let settings = launch.settings
    let synced = settings.synced

    Form {
      Section {
        Picker(
          Strings.App.Settings.theme,
          selection: Binding(get: { settings.scheme }, set: { settings.setScheme($0) })
        ) {
          ForEach(AppearanceChoice.allCases, id: \.self) { choice in
            Text(choice.label).tag(choice)
          }
        }
        .accessibilityIdentifier("hermie.settings.appearance.scheme")
      } footer: {
        SettingsNote(Strings.App.Settings.themeHint)
      }

      Section {
        ForEach(ThemeRow.rows(userThemes: synced.userThemes)) { row in
          ThemeRowButton(row: row, chosen: row.isChosen(synced.themeChoice), userThemes: synced.userThemes) {
            settings.setThemeChoice(row.choice)
          }
        }
      } header: {
        Text(NativeStrings.Appearance.tintHeader)
      } footer: {
        SettingsNote(NativeStrings.Appearance.tintFooter)
      }

      Section {
        Picker(
          Strings.App.Settings.chatTextSize,
          selection: Binding(get: { synced.textSize }, set: { settings.setTextSize($0) })
        ) {
          ForEach(TranscriptTextSize.allCases, id: \.self) { size in
            Text(size.label).tag(size)
          }
        }
        .accessibilityIdentifier("hermie.settings.appearance.textSize")
      } footer: {
        SettingsNote(Strings.App.Settings.chatTextSizeHint)
      }

      Section {
        LabeledContent(Strings.App.Settings.language) {
          Text(AppLanguage.current())
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.settings.appearance.language")

        if let url = AppLanguage.settingsURL {
          Button(Self.changeLanguage) {
            openURL(url)
          }
          .accessibilityIdentifier("hermie.settings.appearance.languageChange")
        }
      } footer: {
        SettingsNote(NativeStrings.Appearance.languageFooter)
      }
    }
    .formStyle(.grouped)
  }

  private static var changeLanguage: String {
    #if os(macOS)
      NativeStrings.Appearance.languageChangeMac
    #else
      NativeStrings.Appearance.languageChange
    #endif
  }
}

/// One theme in the picker: its colour, its name and a tick on the one in force.
private struct ThemeRowButton: View {
  let row: ThemeRow
  let chosen: Bool
  let userThemes: [JSONObject]
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack {
        Circle()
          .fill(row.swatch(userThemes: userThemes))
          .frame(width: 20, height: 20)
          .accessibilityHidden(true)

        Text(row.name)
          .foregroundStyle(.primary)

        Spacer()

        if chosen {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(chosen ? .isSelected : [])
    .accessibilityIdentifier("hermie.settings.appearance.theme.\(row.id)")
  }
}
