import HermieCore
import HermieProtocol
import SwiftUI

extension AppearanceChoice {
  /// What `preferredColorScheme` takes: nil follows the device.
  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }

  var label: String {
    switch self {
    case .system: Strings.App.Settings.ThemeOptions.system
    case .light: Strings.App.Settings.ThemeOptions.light
    case .dark: Strings.App.Settings.ThemeOptions.dark
    }
  }
}

extension TranscriptTextSize {
  var label: String {
    switch self {
    case .small: Strings.Chat.Options.TextSizes.small
    case .standard: Strings.Chat.Options.TextSizes.default
    case .large: Strings.Chat.Options.TextSizes.large
    case .xlarge: Strings.Chat.Options.TextSizes.xlarge
    }
  }

  /// How many steps of Dynamic Type this size moves the transcript from where the device has it.
  var steps: Int {
    switch self {
    case .small: -1
    case .standard: 0
    case .large: 1
    case .xlarge: 2
    }
  }

  /// The transcript's type size: the device's own, moved by `steps` and kept inside the range
  /// Dynamic Type has. "On top of the device's own text size" (`chatTextSizeHint`): a reader on a
  /// large device size who picks Small still gets more than a reader on the default.
  func scaling(_ system: DynamicTypeSize) -> DynamicTypeSize {
    let sizes = DynamicTypeSize.allCases

    guard steps != 0, let index = sizes.firstIndex(of: system) else {
      return system
    }

    return sizes[min(max(index + steps, 0), sizes.count - 1)]
  }
}

/// A theme's accent as the app draws it: what `.tint` takes.
enum ThemeAccent: Equatable {
  /// The app's own accent colour (the asset catalogue's).
  case system
  /// One colour in both appearances.
  case fixed(UInt32)
  /// A colour for each appearance.
  case adaptive(light: UInt32, dark: UInt32)

  /**
   The accent of a theme choice. A preset maps to one tint (D19): Blue is the app's own accent,
   Graphite and Lime the colours the Expo app gives them, in the form white text is readable on. A
   theme of the reader's own (made in the Expo app) uses the accent it chose for each appearance
   (`accentBubble`, then `accentFill`), and the preset it is built on for what it did not.
   */
  static func of(_ choice: ThemeChoice, userThemes: [JSONObject]) -> ThemeAccent {
    switch choice {
    case .preset(let name):
      return preset(name)
    case .user(let id):
      guard let theme = userThemes.first(where: { $0["id"]?.stringValue == id }) else {
        return .system
      }

      let base = preset(theme["base"]?.stringValue ?? "")
      let light = face(theme["light"])
      let dark = face(theme["dark"])

      guard light != nil || dark != nil else {
        return base
      }

      let fallback = base.hex ?? BotAccent.default.bubbleHex

      return .adaptive(light: light ?? fallback, dark: dark ?? fallback)
    }
  }

  static func preset(_ name: String) -> ThemeAccent {
    switch name {
    case "graphite": .fixed(BotAccent.graphite.bubbleHex)
    case "lime": .fixed(BotAccent.lime.bubbleHex)
    default: .system
    }
  }

  /// `accentBubble`, else `accentFill`, of one face, as `#RRGGBB`.
  private static func face(_ value: JSONValue?) -> UInt32? {
    guard let object = value?.objectValue else {
      return nil
    }

    return hex(object["accentBubble"]?.stringValue) ?? hex(object["accentFill"]?.stringValue)
  }

  /// `#RRGGBB` as a number, or nil for anything else.
  static func hex(_ text: String?) -> UInt32? {
    guard let text, text.count == 7, text.hasPrefix("#") else {
      return nil
    }

    return UInt32(text.dropFirst(), radix: 16)
  }

  private var hex: UInt32? {
    if case .fixed(let value) = self {
      return value
    }

    return nil
  }

  /// `nil` is the app's own accent.
  var color: Color? {
    switch self {
    case .system:
      nil
    case .fixed(let value):
      Color(hex: value)
    case .adaptive(let light, let dark):
      Color.dynamic(light: Self.rgb(light), dark: Self.rgb(dark))
    }
  }

  private static func rgb(_ value: UInt32) -> (Int, Int, Int) {
    (Int((value >> 16) & 0xFF), Int((value >> 8) & 0xFF), Int(value & 0xFF))
  }
}

/// One row of the theme picker: a preset, or one of the reader's own themes.
struct ThemeRow: Identifiable, Equatable {
  let choice: ThemeChoice
  let name: String

  var id: String {
    switch choice {
    case .preset(let name): "preset:\(name)"
    case .user(let id): "user:\(id)"
    }
  }

  /// The presets this build knows, then the reader's own themes (a name, or the id when it has none).
  static func rows(userThemes: [JSONObject]) -> [ThemeRow] {
    let presets = ThemeChoice.presets.map { ThemeRow(choice: .preset($0), name: presetName($0)) }
    let own = userThemes.compactMap { theme -> ThemeRow? in
      guard let id = theme["id"]?.stringValue else {
        return nil
      }

      let name = theme["name"]?.stringValue ?? ""

      return ThemeRow(choice: .user(id: id), name: name.isEmpty ? id : name)
    }

    return presets + own
  }

  static func presetName(_ name: String) -> String {
    switch name {
    case "graphite": Strings.App.Settings.PresetOptions.graphite
    case "lime": Strings.App.Settings.PresetOptions.lime
    default: Strings.App.Settings.PresetOptions.blue
    }
  }

  /// Whether the theme in force is this row's. A choice whose theme is gone (deleted on another
  /// device) is on no row at all.
  func isChosen(_ current: ThemeChoice) -> Bool {
    choice == current
  }

  /// The swatch's colour. Blue is the app's own accent: its swatch is that colour, not a second blue.
  func swatch(userThemes: [JSONObject]) -> Color {
    ThemeAccent.of(choice, userThemes: userThemes).color ?? Color.accentColor
  }
}

/// The view that carries the reader's scheme and accent: every window's root, and so every sheet.
struct AppAppearance: ViewModifier {
  let settings: AppSettings

  func body(content: Content) -> some View {
    content
      .preferredColorScheme(settings.scheme.colorScheme)
      .tint(ThemeAccent.of(settings.synced.themeChoice, userThemes: settings.synced.userThemes).color)
  }
}

extension View {
  /// The reader's colour scheme and accent colour, live (`Settings › Appearance`).
  func appAppearance(_ settings: AppSettings) -> some View {
    modifier(AppAppearance(settings: settings))
  }

  /// The transcript at the reader's text size, on top of the device's own.
  func transcriptTextSize(_ size: TranscriptTextSize) -> some View {
    transformEnvironment(\.dynamicTypeSize) { $0 = size.scaling($0) }
  }
}

/// The language the app is speaking, and where the system lets the reader change it.
enum AppLanguage {
  /// The language of this launch, in its own words ("Nederlands"), from the app's own bundle: the
  /// system's per-app choice decides it (D20, no picker of our own).
  static func current(
    preferred: [String] = Bundle.main.preferredLocalizations,
    locale: Locale = .current
  ) -> String {
    guard let identifier = preferred.first else {
      return ""
    }

    let own = Locale(identifier: identifier)
    let name = own.localizedString(forIdentifier: identifier) ?? locale.localizedString(forIdentifier: identifier)

    return name ?? identifier
  }

  /// Where the person picks Hermie's language: the app's own page in Settings on iPhone and iPad,
  /// Language & Region in System Settings on the Mac (its Applications list holds the per-app choice).
  static var settingsURL: URL? {
    #if os(macOS)
      URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension")
    #else
      URL(string: UIApplication.openSettingsURLString)
    #endif
  }
}
