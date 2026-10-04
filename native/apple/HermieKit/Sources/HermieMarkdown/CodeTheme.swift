import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// The colours of highlighted code, per kind of token, light and dark.
///
/// The values are the web client's (`packages/markdown/src/code-theme.ts`), tuned against the
/// grey a code block sits on, so a listing reads the same on every client and keeps its contrast
/// in both appearances. A colour here is dynamic: it resolves against the appearance the text is
/// drawn in, so a scheme change recolours the text without the tokens being made again.
enum CodeTheme {
  /// `nil` for plain text, which keeps the text's own colour.
  static func color(for kind: CodeTokenKind) -> Color? {
    guard kind != .plain else { return nil }
    return Palette.colors[kind]
  }

  /// The hex pair (light, dark) of each colour, for tests that hold the two clients together.
  static let hex: [CodeTokenKind: (light: UInt32, dark: UInt32)] = [
    .keyword: (0x9B2393, 0xFF7AB2),
    .tag: (0x9B2393, 0xFF7AB2),
    .string: (0xC41A16, 0xFF8170),
    .comment: (0x5A6673, 0x8A93A0),
    .number: (0x1C00CF, 0xD9C97C),
    .literal: (0x1C00CF, 0xD9C97C),
    .type: (0x005A5B, 0xACF2E4),
    .function: (0x0F68A0, 0x67B7FF),
    .property: (0x76601F, 0xD0BF69),
    .attribute: (0x643820, 0xC5A88F),
    .meta: (0x643820, 0xC5A88F),
    .variable: (0x4A4A55, 0xC7C7D1),
    .addition: (0x1E6E3E, 0x76D995),
    .deletion: (0xB42332, 0xFF9AA4)
  ]

  private enum Palette {
    static let colors: [CodeTokenKind: Color] = hex.mapValues { Color.dynamic(light: $0.light, dark: $0.dark) }
  }
}

extension Color {
  /// A colour that is `light` in the light appearance and `dark` in the dark one (24-bit RGB).
  static func dynamic(light: UInt32, dark: UInt32) -> Color {
    #if os(iOS)
      Color(
        uiColor: UIColor { traits in
          Self.platform(traits.userInterfaceStyle == .dark ? dark : light)
        })
    #else
      Color(
        nsColor: NSColor(name: nil) { appearance in
          let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
          return Self.platform(isDark ? dark : light)
        })
    #endif
  }

  #if os(iOS)
    private static func platform(_ rgb: UInt32) -> UIColor {
      UIColor(
        red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
        blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
  #else
    private static func platform(_ rgb: UInt32) -> NSColor {
      NSColor(
        srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
        blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
  #endif
}

extension [CodeToken] {
  /// The tokens as one `AttributedString` for `Text`: only colours are set, the font stays the
  /// environment's.
  func attributedString() -> AttributedString {
    var out = AttributedString()
    for token in self {
      var piece = AttributedString(token.text)
      if let color = CodeTheme.color(for: token.kind) {
        piece.foregroundColor = color
      }
      out += piece
    }
    return out
  }
}
