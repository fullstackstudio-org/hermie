import Foundation
import HermieProtocol

/// Light or dark: the two faces a theme has.
public enum ThemeScheme: String, Sendable, Hashable, CaseIterable {
  case light
  case dark
}

/// The colours of a theme the reader may edit on a theme of their own, each a field of one face.
public enum ThemeColourField: String, Sendable, Hashable, CaseIterable {
  /// The floor. Carried as it came: the Apple apps draw no theme background of their own.
  case background
  /// The accent's solid fill: rings, swatches, the send button.
  case accentFill
  /// The outgoing bubble. White text has to stay readable on it.
  case accentBubble
}

/// Whether a colour may be stored (`judgeThemeColour` in `ui/contrast.ts`).
public enum ThemeColourVerdict: Sendable, Equatable {
  case ok
  /// Not six hex digits after a `#`.
  case malformed
  /// White text on it measures `ratio`, under the floor.
  case tooLight(ratio: Double, floor: Double)
}

/**
 The reader's own themes (`UserTheme` in `ui/themes.ts`): a preset and a small number of overrides per
 face, kept raw in the app section's `themes` (`SyncedSettings.userThemes`) so a field this build does
 not know goes back to the gateway as it came.

 A theme is a SMALL amount of data, and a preset is three things per scheme (a background, an elevation
 ladder and a default accent), so a theme stores only what the reader changed: the floor, the accent's
 fill and the outgoing bubble, per face. Everything not overridden keeps following the preset, so a
 preset that improves improves every theme built on it, and a theme has a light face and a dark one so
 that editing one of them in the evening cannot change a light face nobody chose.

 What the Apple apps draw of a theme is the accent: the tint (`ThemeAccent`). They do not draw the
 theme's floor, so the editor leaves it as it is: a colour the Expo app draws as the whole window is one
 whose legibility is judged against every ink it has, and this build does not carry that table.

 Every function here is a plain edit of the list, and every id and field written is the reference's,
 so the Expo app and the web client read what this writes.
 */
public enum UserThemes {
  /// `THEME_PRESETS`' floors: what a new theme copies, so the editor has something to show and an edit to
  /// one face cannot look like it moved the other.
  static let presetBackgrounds: [String: (light: String, dark: String)] = [
    "blue": ("#EAF3FF", "#070F1D"),
    "graphite": ("#F0F1F3", "#2E3138"),
    "lime": ("#F3FAE4", "#0B1206")
  ]

  /// The answer white text gets on a bubble (`AA_TEXT`): the floor of the outgoing bubble.
  public static let bubbleFloor = 4.5

  // MARK: Reading

  public static func id(of theme: JSONObject) -> String? {
    theme["id"]?.stringValue
  }

  public static func name(of theme: JSONObject) -> String {
    theme["name"]?.stringValue ?? ""
  }

  public static func base(of theme: JSONObject) -> String {
    let base = theme["base"]?.stringValue ?? ""

    return ThemeChoice.presets.contains(base) ? base : ThemeChoice.presets[0]
  }

  public static func theme(_ id: String, in themes: [JSONObject]) -> JSONObject? {
    themes.first { self.id(of: $0) == id }
  }

  /// What the theme stores for one field of one face, or nil when the field follows the preset (or holds
  /// something that is not a colour, which is no colour: `asFace`).
  public static func stored(_ field: ThemeColourField, _ scheme: ThemeScheme, in theme: JSONObject) -> String? {
    guard let text = theme[scheme.rawValue]?.objectValue?[field.rawValue]?.stringValue, parse(text) != nil else {
      return nil
    }

    return text
  }

  /// The accent a preset resolves "Default" to (`THEME_PRESETS[name][scheme].accent`): what a colour the
  /// theme does not override follows.
  public static func presetAccent(_ base: String) -> BotAccent {
    switch base {
    case "graphite": .graphite
    case "lime": .lime
    default: .default
    }
  }

  /// The colour a field shows while the theme stores none: the preset's, as `#RRGGBB`. The floor follows
  /// the preset's floor for that face.
  public static func followed(_ field: ThemeColourField, _ scheme: ThemeScheme, base: String) -> String {
    switch field {
    case .accentFill:
      return hexText(presetAccent(base).fillHex)
    case .accentBubble:
      return hexText(presetAccent(base).bubbleHex)
    case .background:
      let floors = presetBackgrounds[base] ?? presetBackgrounds["blue"]!

      return scheme == .light ? floors.light : floors.dark
    }
  }

  /// `0xRRGGBB` as `#RRGGBB`.
  public static func hexText(_ value: UInt32) -> String {
    String(format: "#%06X", value & 0xFFFFFF)
  }

  // MARK: Editing

  /// A theme id, unique enough for a set of themes one person made: it travels to another device through
  /// `hermie-app`, so it is a value rather than an index (two phones both appending a theme would
  /// otherwise both call it number three). `t<ms>` and `<n>` in base 36, as the reference writes it.
  public static func newID(now: Double, counter: Int) -> String {
    "t\(String(Int(now.rounded(.down)), radix: 36))\(String(counter, radix: 36))"
  }

  /// Start a theme from a preset: a copy of the preset's two floors, under `name`.
  public static func creating(base: String, name: String, id: String, in themes: [JSONObject]) -> [JSONObject] {
    let base = ThemeChoice.presets.contains(base) ? base : ThemeChoice.presets[0]
    let floors = presetBackgrounds[base] ?? presetBackgrounds["blue"]!
    let theme: JSONObject = [
      "id": .string(id),
      "name": .string(name),
      "base": .string(base),
      "light": ["background": .string(floors.light)],
      "dark": ["background": .string(floors.dark)]
    ]

    return themes + [theme]
  }

  /// Name a theme. Every other field is kept.
  public static func renaming(_ id: String, to name: String, in themes: [JSONObject]) -> [JSONObject] {
    themes.map { theme in
      guard self.id(of: theme) == id else {
        return theme
      }

      var next = theme
      next["name"] = .string(name)

      return next
    }
  }

  /// Set one colour of one face, or, with nil, let it follow the preset again. The rest of the face, and
  /// of the theme, is kept as it came. A face left with nothing in it is left out, as the reference's
  /// reader would drop it.
  public static func setting(
    _ field: ThemeColourField, _ scheme: ThemeScheme, to colour: String?, on id: String, in themes: [JSONObject]
  ) -> [JSONObject] {
    themes.map { theme in
      guard self.id(of: theme) == id else {
        return theme
      }

      var next = theme
      var face = next[scheme.rawValue]?.objectValue ?? [:]

      if let colour {
        face[field.rawValue] = .string(colour.trimmingCharacters(in: .whitespacesAndNewlines))
      } else {
        face.removeValue(forKey: field.rawValue)
      }

      if face.isEmpty {
        next.removeValue(forKey: scheme.rawValue)
      } else {
        next[scheme.rawValue] = .object(face)
      }

      return next
    }
  }

  public static func deleting(_ id: String, from themes: [JSONObject]) -> [JSONObject] {
    themes.filter { self.id(of: $0) != id }
  }

  /// What is on after a theme is deleted: the preset it was built on when it was the one in force, so the
  /// picker agrees with what is on screen; any other choice is left alone.
  public static func choice(afterDeleting id: String, current: ThemeChoice, themes: [JSONObject]) -> ThemeChoice {
    guard case .user(let chosen) = current, chosen == id else {
      return current
    }

    return .preset(theme(id, in: themes).map(base(of:)) ?? ThemeChoice.presets[0])
  }

  // MARK: Colours

  /// `#RRGGBB` as its three channels, or nil for anything else (the reference's `HEX`).
  public static func parse(_ text: String) -> (red: Int, green: Int, blue: Int)? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard trimmed.count == 7, trimmed.hasPrefix("#"), let value = Int(trimmed.dropFirst(), radix: 16),
      trimmed.dropFirst().allSatisfy(\.isHexDigit)
    else {
      return nil
    }

    return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
  }

  /// `#RRGGBB`, upper case.
  public static func hex(red: Int, green: Int, blue: Int) -> String {
    String(format: "#%02X%02X%02X", min(max(red, 0), 255), min(max(green, 0), 255), min(max(blue, 0), 255))
  }

  /// WCAG's relative luminance of an sRGB colour.
  static func luminance(_ colour: (red: Int, green: Int, blue: Int)) -> Double {
    func channel(_ value: Int) -> Double {
      let scaled = Double(value) / 255

      return scaled <= 0.03928 ? scaled / 12.92 : pow((scaled + 0.055) / 1.055, 2.4)
    }

    return 0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue)
  }

  /// The ratio, rounded to two places, of white text on `colour` (`onAccent` is white in both schemes).
  public static func contrastWithWhite(_ colour: (red: Int, green: Int, blue: Int)) -> Double {
    let white = luminance((255, 255, 255))
    let other = luminance(colour)
    let ratio = (max(white, other) + 0.05) / (min(white, other) + 0.05)

    return (ratio * 100).rounded() / 100
  }

  /// Would this colour be stored? The bubble has to carry white text (AA); the accent's fill never carries
  /// text, so no ratio applies to it, and saying so is better than inventing a floor that would refuse the
  /// studio's own lime. The floor is not judged here: the Apple apps draw none (see the type's note).
  public static func judge(_ field: ThemeColourField, _ text: String) -> ThemeColourVerdict {
    guard let colour = parse(text) else {
      return .malformed
    }

    guard field == .accentBubble else {
      return .ok
    }

    let ratio = contrastWithWhite(colour)

    return ratio >= bubbleFloor ? .ok : .tooLight(ratio: ratio, floor: bubbleFloor)
  }
}
