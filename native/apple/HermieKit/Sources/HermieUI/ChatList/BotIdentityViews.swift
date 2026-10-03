import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// A bot's picture: the avatar the gateway ships, or its initial on a colour picked from its name,
/// so the same bot always gets the same colour without anyone storing one.
///
/// With a `presence` the picture carries its state bead as Messages draws a status: the avatar has
/// a round bite taken out of its bottom-right edge (the picture is masked, nothing is stroked over
/// it) and the bead sits in that bite. Because the bite is empty, whatever is behind the avatar
/// shows through it, a plain row, a selected row, light or dark, with no background colour to match.
struct BotAvatar: View {
  let name: String
  /// The base64 image, when the bot has one and it has been fetched.
  let avatar: String?
  var size: CGFloat = 44
  /// The state bead, or nothing for a picture on its own.
  var presence: PresenceState?

  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  /// System colours, so they follow light, dark and increased contrast.
  static let tints: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .brown]

  static func tint(for name: String) -> Color {
    tints[ItemFormat.tintIndex(name, buckets: tints.count)]
  }

  var body: some View {
    let side = size * min(scale, 1.6)
    let geometry = PresenceGeometry(avatarSide: side)

    picture(side: side)
      .frame(width: side, height: side)
      // One clip, a path: the circle with the bite taken out of it when there is a bead, the
      // plain circle when there is not. Nothing is composited in an offscreen layer.
      .clipShape(AvatarShape(bite: presence == nil ? nil : geometry))
      .overlay(alignment: .topLeading) {
        if let presence {
          PresenceDot(state: presence, diameter: geometry.dot)
            .position(geometry.center)
        }
      }
      .frame(width: side, height: side)
      .accessibilityHidden(true)
  }

  @ViewBuilder private func picture(side: CGFloat) -> some View {
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
}

/// Where a state bead sits on an avatar, and how big, all from the avatar's side so it scales with
/// it (Dynamic Type grows the avatar, and the bead and its bite with it).
///
/// The bead's centre is on the avatar's circle, at the bottom-right (45 degrees); the bite is the
/// bead plus a ring of the same thickness all round.
struct PresenceGeometry: Equatable {
  let avatarSide: CGFloat

  /// The bead's diameter: 28 percent of the avatar, never under 9 points.
  var dot: CGFloat { max(9, avatarSide * 0.28) }
  /// The empty ring between the bead and the picture.
  var ring: CGFloat { max(2, avatarSide * 0.055) }
  /// The bite's diameter.
  var cutout: CGFloat { dot + ring * 2 }
  /// The bead's (and the bite's) centre, from the avatar's top-leading corner: on the circle at 45 degrees.
  var center: CGPoint {
    let radius = avatarSide / 2
    let reach = radius * (1 + 2.0.squareRoot() / 2)
    return CGPoint(x: reach, y: reach)
  }
}

/// The avatar's outline: a circle, with a round bite out of it where the state bead sits.
struct AvatarShape: Shape {
  var bite: PresenceGeometry?

  func path(in rect: CGRect) -> Path {
    let circle = Path(ellipseIn: rect)

    guard let bite else {
      return circle
    }

    let diameter = bite.cutout
    let hole = CGRect(
      x: rect.minX + bite.center.x - diameter / 2, y: rect.minY + bite.center.y - diameter / 2,
      width: diameter, height: diameter)

    return circle.subtracting(Path(ellipseIn: hole))
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

    guard let data = AvatarData.bytes(base64) else {
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
/// signal: needs-input and working carry a glyph, offline is hollow, and the row's label says the
/// state in words.
///
/// Static by design: online green, working blue, offline a hollow grey ring. Nothing here moves; a
/// bead that pulsed for "working" would animate a whole list of busy bots at once. It is a crisp
/// filled disc with no stroke of its own: the ring around it is the avatar's bite
/// (`BotAvatar`), so the bead needs no background colour.
struct PresenceDot: View {
  let state: PresenceState
  var diameter: CGFloat = 14

  var body: some View {
    ZStack {
      if state == .offline {
        // Hollow: only the ring is drawn, the bite behind it shows the row.
        Circle()
          .strokeBorder(Self.colour(state), lineWidth: max(1.5, diameter * 0.17))
      } else {
        Circle().fill(Self.colour(state))
      }

      if let symbol = Self.symbol(state) {
        Image(systemName: symbol)
          .font(.system(size: diameter * 0.55, weight: .bold))
          .foregroundStyle(Self.glyphColour(state))
      }
    }
    .frame(width: diameter, height: diameter)
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
