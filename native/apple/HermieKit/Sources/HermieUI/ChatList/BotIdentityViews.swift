import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// A bot's picture: the avatar the gateway ships, or its initial on a colour picked from its name,
/// so the same bot always gets the same colour without anyone storing one.
struct BotAvatar: View {
  let name: String
  /// The base64 image, when the bot has one and it has been fetched.
  let avatar: String?
  var size: CGFloat = 44

  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  /// System colours, so they follow light, dark and increased contrast.
  static let tints: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .brown]

  static func tint(for name: String) -> Color {
    tints[ItemFormat.tintIndex(name, buckets: tints.count)]
  }

  var body: some View {
    let side = size * min(scale, 1.6)

    Group {
      if let image = AvatarImages.image(avatar) {
        image
          .resizable()
          .scaledToFill()
      } else {
        Text(ItemFormat.initial(name))
          .font(.system(size: side * 0.42, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          // A quarter darker than the system colour, so white text on it stays above 4.5:1.
          .background(Self.tint(for: name).mix(with: .black, by: 0.25))
      }
    }
    .frame(width: side, height: side)
    .clipShape(.circle)
    .accessibilityHidden(true)
  }
}

/// Decoded avatars, keyed by their base64 text: a row redrawn for a new preview does not decode its
/// picture again. Main-actor only, bounded by the roster.
@MainActor
enum AvatarImages {
  private static var cache: [String: Image] = [:]

  static func image(_ base64: String?) -> Image? {
    guard let base64, !base64.isEmpty else {
      return nil
    }

    if let cached = cache[base64] {
      return cached
    }

    guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
      return nil
    }

    #if os(iOS)
      guard let platform = UIImage(data: data) else { return nil }
      let image = Image(uiImage: platform)
    #elseif os(macOS)
      guard let platform = NSImage(data: data) else { return nil }
      let image = Image(nsImage: platform)
    #endif

    if cache.count > 256 {
      cache.removeAll()
    }

    cache[base64] = image
    return image
  }
}

/// The bead on a bot's avatar: one of four states (`presence.ts`). Colour is never the only
/// signal: needs-input and working carry a glyph, and the row's label says the state in words.
struct PresenceDot: View {
  let state: PresenceState
  var diameter: CGFloat = 14

  @ScaledMetric(relativeTo: .caption) private var scale: CGFloat = 1

  var body: some View {
    let side = diameter * min(scale, 1.6)

    ZStack {
      Circle().fill(Self.colour(state))

      if let symbol = Self.symbol(state) {
        Image(systemName: symbol)
          .font(.system(size: side * 0.55, weight: .bold))
          .foregroundStyle(Self.glyphColour(state))
      }
    }
    .frame(width: side, height: side)
    .overlay(Circle().strokeBorder(.background, lineWidth: max(2, side * 0.14)))
    .accessibilityHidden(true)
  }

  /// The working blue is darkened so its white glyph stays above 4.5:1; the orange keeps its
  /// brightness and takes a black glyph instead.
  static func colour(_ state: PresenceState) -> Color {
    switch state {
    case .online: .green
    case .working: Color.blue.mix(with: .black, by: 0.3)
    case .needsInput: .orange
    case .offline: .gray
    }
  }

  static func glyphColour(_ state: PresenceState) -> Color {
    state == .needsInput ? .black : .white
  }

  static func symbol(_ state: PresenceState) -> String? {
    switch state {
    case .needsInput: "exclamationmark"
    case .working: "ellipsis"
    case .online, .offline: nil
    }
  }
}
