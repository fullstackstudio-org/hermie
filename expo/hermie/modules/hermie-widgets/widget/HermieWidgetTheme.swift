import SwiftUI

/**
 The app's own colours, and no others.

 A widget is drawn by a different process out of a different binary, so nothing in
 `src/ui/tokens.ts` or `src/ui/themes.ts` reaches it — which makes this file the one place the two
 can drift apart. Three rules keep that manageable:

  - **Only the Blue preset.** A widget cannot know which preset the reader picked without the app
    writing it down, and a preset in the snapshot would be a fourth thing to keep in step for a
    surface that is four square centimetres. Blue is the default and the one every ink in
    `tokens.ts` was calibrated against.
  - **Flat, and no gradients.** That is the Liquid Glass direction as the owner settled it: one
    saturated field, one ink on it. It is also the only thing that works here — a widget gets no
    blur, no material and no wallpaper behind it.
  - **The per-bot colour is NOT in this file.** It arrives in the snapshot as a hex string off the
    app's accent table, so a chat the owner coloured Teal is Teal here without this file knowing
    the table exists.

 Every value below is quoted from the TypeScript it came from, by name, so a change on that side
 has somewhere obvious to land.
 */
enum HermieTheme {
  // `themes.ts`, BLUE_LIGHT / BLUE_DARK, rung `e1` — the rung a chat-list row sits on.
  static let surfaceLight = Color(hex: 0xF4F8FE)
  static let surfaceDark = Color(hex: 0x1C2A45)

  // `tokens.ts`, lightColors / darkColors.
  static let textLight = Color(hex: 0x12151C)
  static let textDark = Color(hex: 0xF3F6FB)
  static let mutedLight = Color(hex: 0x4B5462)
  static let mutedDark = Color(hex: 0xC8D2E0)
  static let accentLight = Color(hex: 0x1668E3)
  static let accentDark = Color(hex: 0x2C7BEA)

  // `tokens.ts`, lightPresence / darkPresence.
  static func presence(_ state: String, dark: Bool) -> Color {
    switch state {
    case "online":
      return dark ? Color(hex: 0x3ED374) : Color(hex: 0x20A24B)
    case "working":
      return dark ? Color(hex: 0x5AA4FF) : Color(hex: 0x1668E3)
    case "needsInput":
      return dark ? Color(hex: 0xFFB531) : Color(hex: 0xE09000)
    default:
      return dark ? Color(hex: 0x7E8798) : Color(hex: 0x8A93A3)
    }
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }

  /**
   The `#RRGGBB` the snapshot carries, or the Blue preset's accent.

   A fallback rather than an optional, because the caller is a view body and there is nothing
   sensible for it to do with a nil: a bot whose colour did not parse should be drawn in the
   default colour, not left out of the list.
   */
  init(hexString: String, fallback: UInt32 = 0x2A72DC) {
    var value: UInt64 = 0
    let digits = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString

    guard digits.count == 6, Scanner(string: digits).scanHexInt64(&value) else {
      self.init(hex: fallback)

      return
    }

    self.init(hex: UInt32(value))
  }
}

/**
 Light or dark, as this widget is being drawn.

 `@Environment(\.colorScheme)` is the only source — a widget has no theme of its own and follows
 the system, which is also what `userInterfaceStyle: 'automatic'` gives the app itself.
 */
struct HermieColors {
  let dark: Bool

  var surface: Color { dark ? HermieTheme.surfaceDark : HermieTheme.surfaceLight }
  var text: Color { dark ? HermieTheme.textDark : HermieTheme.textLight }
  var muted: Color { dark ? HermieTheme.mutedDark : HermieTheme.mutedLight }
  var accent: Color { dark ? HermieTheme.accentDark : HermieTheme.accentLight }

  func presence(_ state: String) -> Color {
    HermieTheme.presence(state, dark: dark)
  }
}
