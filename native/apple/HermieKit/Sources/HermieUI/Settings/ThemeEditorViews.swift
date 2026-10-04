import HermieCore
import HermieProtocol
import SwiftUI

/**
 The reader's own themes, under the picker in Settings → Appearance (`ThemesScreen` in the Expo app): the
 themes they made, each opening its editor, and the rows that start another from a preset. A new theme is
 put on at once and its editor opens, so the colours can be tried as they are chosen.

 The themes follow the account (`AppSettings.synced`, the app section's `themes`), so one made here is on
 the reader's other devices and in the Expo app, and the other way round.
 */
struct ThemeManagementSections: View {
  let settings: AppSettings

  @State private var editing: ThemeID?

  var body: some View {
    let themes = settings.synced.userThemes

    Section {
      if themes.isEmpty {
        Text(Strings.App.Settings.Themes.empty)
          .foregroundStyle(.secondary)
      } else {
        ForEach(themes.compactMap(UserThemes.id(of:)), id: \.self) { id in
          if let theme = UserThemes.theme(id, in: themes) {
            NavigationLink(value: ThemeID(id: id)) {
              Text(ThemeText.name(of: theme))
            }
            .accessibilityIdentifier("hermie.settings.themes.edit.\(id)")
          }
        }
      }
    } header: {
      Text(Strings.App.Settings.Themes.header)
    }

    Section {
      ForEach(ThemeChoice.presets, id: \.self) { preset in
        Button(Strings.App.Settings.Themes.createFrom(preset: ThemeRow.presetName(preset))) {
          editing = ThemeID(id: settings.createUserTheme(base: preset, name: ThemeRow.presetName(preset)))
        }
        .accessibilityIdentifier("hermie.settings.themes.new.\(preset)")
      }
    } header: {
      Text(Strings.App.Settings.Themes.create)
    }
    .navigationDestination(item: $editing) { theme in
      ThemeEditPage(id: theme.id)
    }
    .navigationDestination(for: ThemeID.self) { theme in
      ThemeEditPage(id: theme.id)
    }
  }
}

/// A theme's id, as a navigation destination of its own (not a bare string, which other pages may use).
struct ThemeID: Hashable {
  let id: String
}

/// The words themes use.
enum ThemeText {
  /// A theme's name, or "Untitled theme".
  static func name(of theme: JSONObject) -> String {
    let name = UserThemes.name(of: theme).trimmingCharacters(in: .whitespacesAndNewlines)

    return name.isEmpty ? Strings.App.Settings.Themes.untitled : name
  }

  static func face(_ scheme: ThemeScheme) -> String {
    switch scheme {
    case .light: Strings.App.Settings.ThemeOptions.light
    case .dark: Strings.App.Settings.ThemeOptions.dark
    }
  }

  static func label(_ field: ThemeColourField) -> String {
    switch field {
    case .background: Strings.App.Settings.Themes.background
    case .accentFill: Strings.App.Settings.Themes.accentFill
    case .accentBubble: Strings.App.Settings.Themes.accentBubble
    }
  }

  /// Why a colour was not stored, in the Expo app's words ("That colour is not used: …").
  static func rejection(_ verdict: ThemeColourVerdict) -> String? {
    switch verdict {
    case .ok:
      nil
    case .malformed:
      Strings.App.Settings.Themes.rejected(reason: Strings.App.Settings.Themes.reasonMalformed)
    case .tooLight(let ratio, _):
      Strings.App.Settings.Themes.rejected(
        reason: Strings.App.Settings.Themes.reasonBubble(ratio: String(format: "%.2f", ratio)))
    }
  }
}

/**
 Settings → Appearance → a theme: its name, and the colours of one face (light or dark, whichever is
 picked; the one in force to begin with), then Delete.

 What the Apple apps draw of a theme is its accent, so the colours here are the accent's fill and the
 outgoing bubble. A colour is chosen with the system's picker or typed as six hex digits; the bubble has
 to carry white text (a ratio of at least 4.5), and one that cannot says what it measured instead of being
 stored. A colour the theme does not set follows the preset it was built on, and can be let go of again.
 The floor is carried as it is: it is not drawn here, and the Expo app judges it against every ink it has.
 */
struct ThemeEditPage: View {
  let id: String

  @Environment(AppLaunch.self) private var launch
  @Environment(\.colorScheme) private var systemScheme
  @Environment(\.dismiss) private var dismiss

  @State private var picked: ThemeScheme?
  @State private var confirmingDelete = false

  var body: some View {
    let settings = launch.settings
    let scheme = picked ?? (systemScheme == .dark ? .dark : .light)

    Group {
      if let theme = UserThemes.theme(id, in: settings.synced.userThemes) {
        Form {
          Section {
            TextField(
              Strings.App.Settings.Themes.name,
              text: Binding(
                get: { UserThemes.name(of: theme) },
                set: { settings.renameUserTheme(id, to: $0) }
              ),
              prompt: Text(Strings.App.Settings.Themes.namePlaceholder)
            )
            .accessibilityIdentifier("hermie.settings.themes.name")
          }

          Section {
            Picker(Strings.App.Settings.theme, selection: Binding(get: { scheme }, set: { picked = $0 })) {
              ForEach(ThemeScheme.allCases, id: \.self) { face in
                Text(ThemeText.face(face)).tag(face)
              }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("hermie.settings.themes.face")

            ThemeColourRow(field: .accentFill, scheme: scheme, theme: theme, settings: settings)
            ThemeColourRow(field: .accentBubble, scheme: scheme, theme: theme, settings: settings)
          } header: {
            Text(Strings.App.Settings.Themes.editing(scheme: ThemeText.face(scheme).lowercased()))
          }

          Section {
            Button(Strings.App.Settings.Themes.delete, role: .destructive) {
              confirmingDelete = true
            }
            .accessibilityIdentifier("hermie.settings.themes.delete")
          }
        }
        .formStyle(.grouped)
        .navigationTitle(ThemeText.name(of: theme))
        .confirmationDialog(
          Strings.App.Settings.Themes.deleteConfirm(name: ThemeText.name(of: theme)),
          isPresented: $confirmingDelete,
          titleVisibility: .visible
        ) {
          Button(Strings.App.Settings.Themes.delete, role: .destructive) {
            settings.deleteUserTheme(id)
            dismiss()
          }
          .accessibilityIdentifier("hermie.settings.themes.deleteConfirm")
          Button(Strings.App.Settings.Themes.keepIt, role: .cancel) {}
        } message: {
          Text(Strings.App.Settings.Themes.deleteHint)
        }
      } else {
        // Deleted somewhere else while this was open: nothing to edit, and a way out.
        Form {
          Text(Strings.App.Settings.Themes.untitled)
            .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .navigationTitle(Strings.App.Settings.Themes.editPageTitle)
      }
    }
    .accessibilityIdentifier("hermie.settings.themes.page")
  }
}

/// One colour of one face: its swatch and picker, its six hex digits, and what is wrong with them.
private struct ThemeColourRow: View {
  let field: ThemeColourField
  let scheme: ThemeScheme
  let theme: JSONObject
  let settings: AppSettings

  /// What has been typed and not stored (a colour that was refused stays in the field, with the reason).
  @State private var draft: String?
  @State private var problem: String?

  var body: some View {
    let id = UserThemes.id(of: theme) ?? ""
    let stored = UserThemes.stored(field, scheme, in: theme)
    let shown = stored ?? UserThemes.followed(field, scheme, base: UserThemes.base(of: theme))

    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 12) {
        ColorPicker(
          ThemeText.label(field),
          selection: Binding(
            get: { Color(themeHex: shown) },
            set: { color in
              if let hex = color.themeHex {
                apply(hex, on: id)
              }
            }
          ),
          supportsOpacity: false
        )
        .accessibilityIdentifier("hermie.settings.themes.colour.\(field.rawValue)")

        TextField(
          Strings.App.Settings.Themes.colourPlaceholder,
          text: Binding(get: { draft ?? shown }, set: { apply($0, on: id) })
        )
        .textFieldStyle(.roundedBorder)
        .autocorrectionDisabled()
        #if os(iOS)
          .textInputAutocapitalization(.characters)
        #endif
        .monospaced()
        .frame(maxWidth: 110)
        .accessibilityLabel(ThemeText.label(field))
        .accessibilityIdentifier("hermie.settings.themes.hex.\(field.rawValue)")
      }

      if let problem {
        Label(problem, systemImage: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(Color.primary)
          .symbolRenderingMode(.multicolor)
          .accessibilityIdentifier("hermie.settings.themes.problem.\(field.rawValue)")
      }

      // A colour that is following the preset says so, and one that is not can be let go of.
      if stored != nil {
        Button(Strings.App.Settings.Themes.followPreset) {
          draft = nil
          problem = nil
          settings.setThemeColour(field, scheme, to: nil, on: id)
        }
        .font(.footnote)
        .buttonStyle(.borderless)
        .accessibilityIdentifier("hermie.settings.themes.follow.\(field.rawValue)")
      } else {
        Text(
          Strings.App.Settings.Themes.createFrom(preset: ThemeRow.presetName(UserThemes.base(of: theme)))
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
      }
    }
    .onChange(of: scheme) {
      draft = nil
      problem = nil
    }
  }

  /// A colour typed or picked: stored when it passes the guard, refused with the ratio it measured when
  /// it does not.
  private func apply(_ text: String, on id: String) {
    draft = text

    let verdict = UserThemes.judge(field, text)

    problem = ThemeText.rejection(verdict)

    if verdict == .ok {
      settings.setThemeColour(field, scheme, to: text, on: id)
      draft = nil
    }
  }
}

extension Color {
  /// A theme colour as the picker takes it: `#RRGGBB`, mid grey for anything else.
  init(themeHex text: String) {
    guard let rgb = UserThemes.parse(text) else {
      self = .gray
      return
    }

    self.init(.sRGB, red: Double(rgb.red) / 255, green: Double(rgb.green) / 255, blue: Double(rgb.blue) / 255)
  }

  /// This colour in sRGB as `#RRGGBB`.
  var themeHex: String? {
    #if os(macOS)
      guard let converted = NSColor(self).usingColorSpace(.sRGB) else {
        return nil
      }

      return UserThemes.hex(
        red: Int((converted.redComponent * 255).rounded()), green: Int((converted.greenComponent * 255).rounded()),
        blue: Int((converted.blueComponent * 255).rounded()))
    #else
      var red: CGFloat = 0
      var green: CGFloat = 0
      var blue: CGFloat = 0
      var alpha: CGFloat = 0

      guard UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
        return nil
      }

      return UserThemes.hex(red: Int((red * 255).rounded()), green: Int((green * 255).rounded()), blue: Int((blue * 255).rounded()))
    #endif
  }
}
