import SwiftUI

/// The bot is working and has nothing on screen yet: Messages' typing bubble, three dots in the
/// bot's grey bubble, as the last row of the transcript, where the reply will appear.
///
/// It is the assistant's own bubble (`MessageBubble`, `BubbleColumn`: the same fill, corner radius,
/// tail and padding) with dots where the words would be, and the height of a one-line reply, so
/// when the reply's first words replace it the list does not move. One accessibility element,
/// "Typing…", that never changes: the dots animate, VoiceOver is told nothing about it.
struct TypingIndicatorRow: View {
  var body: some View {
    BubbleColumn(side: .incoming, width: .text) {
      MessageBubble(side: .incoming, tail: true, fill: BubblePalette.incoming) {
        TypingDots()
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Strings.App.Chat.Subtitle.typing)
  }
}

/// The three dots. Only they are redrawn while the bot works: a `TimelineView` re-evaluates its own
/// content on each frame, and nothing above it, so neither the row nor any other row is invalidated.
struct TypingDots: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// When the dots appeared: the first dot starts the wave, whenever the clock happens to be.
  @State private var start = Date()

  static let diameter: CGFloat = 9
  static let spacing: CGFloat = 5

  /// The dots' colour at the peak of the pulse, Messages' grey; they rest at a fraction of it.
  static let color = Color.dynamic(light: (0x8E, 0x8E, 0x93), dark: (0xA1, 0xA1, 0xA6))

  var body: some View {
    ZStack {
      // A line of the reply's text, invisible: the dots are as tall as one, so the bubble is as
      // tall as a one-line reply.
      Text(verbatim: "\u{00A0}")
        .font(.body)
        .hidden()
      TimelineView(.animation(minimumInterval: reduceMotion ? 1.0 / 15 : 1.0 / 60)) { context in
        let elapsed = context.date.timeIntervalSince(start)
        HStack(spacing: Self.spacing) {
          ForEach(0..<TypingDotsMotion.dotCount, id: \.self) { dot in
            let frame = TypingDotsMotion.frame(elapsed: elapsed, dot: dot, reduceMotion: reduceMotion)
            Circle()
              .fill(Self.color)
              .frame(width: Self.diameter, height: Self.diameter)
              .scaleEffect(frame.scale)
              .opacity(frame.opacity)
          }
        }
      }
    }
  }
}

/// How the dots move, as numbers: a pure function of the time since they appeared, so the tests can
/// hold it without a screen.
///
/// Messages' wave: each dot swells and brightens once per cycle, one after the other, then rests
/// while the next two do. Under Reduce Motion nothing changes size and the wave is slower and
/// shallower: a gentle fade along the three dots.
enum TypingDotsMotion {
  static let dotCount = 3
  /// One whole wave, seconds.
  static let cycle: TimeInterval = 1.2
  /// The wave under Reduce Motion, seconds.
  static let reducedCycle: TimeInterval = 2.4
  /// How much later each dot starts than the one before, as a share of the cycle.
  static let stagger = 0.15
  /// How long one dot's swell lasts, as a share of the cycle.
  static let span = 0.6

  struct Frame: Equatable {
    var opacity: Double
    var scale: Double
  }

  /// 0 at rest, up to 1 at the dot's peak and back: a sine hump over `span` of the cycle, offset by
  /// the dot's place in the line.
  static func pulse(elapsed: TimeInterval, dot: Int, reduceMotion: Bool = false) -> Double {
    let length = reduceMotion ? reducedCycle : cycle
    var phase = (elapsed / length - Double(dot) * stagger).truncatingRemainder(dividingBy: 1)
    if phase < 0 { phase += 1 }
    guard phase < span else { return 0 }
    return sin(.pi * phase / span)
  }

  static func frame(elapsed: TimeInterval, dot: Int, reduceMotion: Bool = false) -> Frame {
    let level = pulse(elapsed: elapsed, dot: dot, reduceMotion: reduceMotion)
    if reduceMotion {
      return Frame(opacity: 0.45 + 0.4 * level, scale: 1)
    }
    return Frame(opacity: 0.35 + 0.65 * level, scale: 0.75 + 0.25 * level)
  }
}
