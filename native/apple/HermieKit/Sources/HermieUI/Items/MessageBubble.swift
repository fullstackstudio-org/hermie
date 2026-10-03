import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// The colours of the message bubbles, as Messages draws them: the bot's grey,
/// the owner's flat blue with white text. No gradients.
enum BubblePalette {
  /// The owner's bubble: the app's accent blue (#1772D3), fixed, so a Mac with
  /// another system accent still draws it blue. White text on it is 4.66:1,
  /// over the 4.5:1 the accessibility audit asks for, in both appearances.
  static let outgoing = Color(.sRGB, red: 0x17 / 255, green: 0x72 / 255, blue: 0xD3 / 255)
  static let outgoingText = Color.white

  /// The bot's (and other people's) bubble: Messages' grey, light and dark.
  static let incoming = Color.dynamic(light: (0xE9, 0xE9, 0xEB), dark: (0x26, 0x26, 0x29))

  /// The sRGB components behind `incoming`, for the contrast tests.
  static let incomingLight = (red: 0xE9, green: 0xE9, blue: 0xEB)
  static let incomingDark = (red: 0x26, green: 0x26, blue: 0x29)
}

extension Color {
  /// A colour with a value for each appearance.
  static func dynamic(light: (Int, Int, Int), dark: (Int, Int, Int)) -> Color {
    #if os(iOS)
      Color(
        UIColor { traits in
          let rgb = traits.userInterfaceStyle == .dark ? dark : light
          return UIColor(red: CGFloat(rgb.0) / 255, green: CGFloat(rgb.1) / 255, blue: CGFloat(rgb.2) / 255, alpha: 1)
        })
    #elseif os(macOS)
      Color(
        NSColor(name: nil) { appearance in
          let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
          return NSColor(srgbRed: CGFloat(rgb.0) / 255, green: CGFloat(rgb.1) / 255, blue: CGFloat(rgb.2) / 255, alpha: 1)
        })
    #endif
  }
}

/// Which side a bubble sits on, and so where its tail points.
enum BubbleSide: Equatable {
  /// The bot, or another person in a shared chat: leading, grey.
  case incoming
  /// The owner: trailing, blue.
  case outgoing
}

/// A message bubble's outline: a continuous rounded rectangle, with Messages'
/// tail at the bottom corner on the bubble's side when it closes its group.
struct BubbleShape: Shape {
  var side: BubbleSide
  var tail: Bool

  static let radius: CGFloat = 18
  /// How far the tail reaches past the bubble's edge.
  static let tailReach: CGFloat = 5

  func path(in rect: CGRect) -> Path {
    let radius = min(Self.radius, rect.height / 2)
    var path = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
    guard tail else { return path }

    // Drawn for the trailing side and mirrored for the leading one.
    var curl = Path()
    let x = rect.maxX
    let y = rect.maxY
    curl.move(to: CGPoint(x: x - 11, y: y - 15))
    curl.addCurve(
      to: CGPoint(x: x + Self.tailReach, y: y),
      control1: CGPoint(x: x - 2, y: y - 9),
      control2: CGPoint(x: x - 1, y: y - 1))
    curl.addCurve(
      to: CGPoint(x: x - 15, y: y - 2),
      control1: CGPoint(x: x - 4, y: y + 0.5),
      control2: CGPoint(x: x - 10, y: y))
    curl.closeSubpath()

    if side == .incoming {
      curl = curl.applying(CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0).scaledBy(x: -1, y: 1))
    }
    // A union, not an added subpath: mirrored, the curl winds the other way, and an added subpath
    // would cut a hole where it overlaps the body.
    path = path.union(curl)
    return path
  }
}

/// Places one bubble on its side of the row, no wider than a share of the
/// row's width (and a cap on a wide Mac window), as wide as its words need
/// below that: a short message is a small bubble.
struct BubbleColumn: Layout {
  var side: BubbleSide
  var width: BubbleWidth

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let bubble = subviews.first else { return .zero }
    // A probe (no width, or an infinite one) gets the bubble's own size at the cap, never an
    // infinite width back: a lazy stack sizing its rows with probes is thrown off by one.
    // A width of 0 or less is a probe as well: answering it with the bubble's height at no width
    // (a word a line) made a one-line bubble hundreds of points tall.
    guard let available = proposal.width, available.isFinite, available > 0 else {
      return bubble.sizeThatFits(ProposedViewSize(width: width.maximum, height: nil))
    }
    let size = bubble.sizeThatFits(ProposedViewSize(width: width.cap(available), height: nil))
    return CGSize(width: available, height: size.height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let bubble = subviews.first else { return }
    let size = bubble.sizeThatFits(ProposedViewSize(width: width.cap(bounds.width), height: nil))
    let x = side == .outgoing ? bounds.maxX - size.width : bounds.minX
    bubble.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(size))
  }
}

/// How wide a bubble may grow.
struct BubbleWidth: Equatable {
  /// The share of the row's width.
  var fraction: CGFloat
  /// Never wider than this, in points.
  var maximum: CGFloat

  /// Words: about three quarters of the column, as Messages, and a line length a wide window
  /// does not stretch past reading.
  static let text = BubbleWidth(fraction: 0.75, maximum: 560)
  /// A reply with a table or code in it: nearly the whole column, so the table or listing is not
  /// squeezed into a balloon.
  static let wide = BubbleWidth(fraction: 0.94, maximum: 820)

  func cap(_ available: CGFloat) -> CGFloat {
    max(0, min(available * fraction, maximum))
  }
}

/// A message's words on its bubble.
struct MessageBubble<Content: View>: View {
  let side: BubbleSide
  let tail: Bool
  var fill: Color
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(.horizontal, ChatSpacing.bubbleInsetH)
      .padding(.vertical, ChatSpacing.bubbleInsetV)
      .background(fill, in: BubbleShape(side: side, tail: tail))
      .contentShape(BubbleShape(side: side, tail: false))
  }
}

/// The date and time above the first message and above one after a long
/// pause: "Today 20:06", centred, as Messages has it.
struct BubbleTimeHeader: View {
  let ts: Double

  var body: some View {
    Text(Self.text(ts))
      .font(.caption.weight(.medium))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity)
      .padding(.top, 6)
      .padding(.bottom, 4)
  }

  /// "Today at 20:06", "Yesterday at 09:12", "3 Oct 2026 at 14:00", in the reader's language.
  static func text(_ ts: Double) -> String {
    formatter.string(from: Date(timeIntervalSince1970: ts))
  }

  private static let formatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.doesRelativeDateFormatting = true
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter
  }()
}
