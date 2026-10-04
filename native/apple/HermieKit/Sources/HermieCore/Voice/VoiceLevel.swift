import Foundation
import Synchronization

/**
 How loud the microphone and the speaker are, for the orb on voice mode's screen.

 Three parts, because they run in three places:

 - **`VoiceLevel`** turns a buffer of samples into a number between 0 and 1. It runs on the audio
   thread, so it allocates nothing and takes no lock: a root mean square, in decibels, mapped from
   the floor of a quiet room to a raised voice.
 - **`VoiceLevelMeter`** carries the latest number from the audio thread to the screen in one atomic
   word. The audio thread writes and never waits; the screen reads whatever is there at its frame.
 - **`VoiceLevelSmoother`** is the screen's: a level that rises fast and falls slowly, by the time
   between frames rather than by the frame, so 60 and 120 frames a second look the same.
 */
public enum VoiceLevel {
  /// Quieter than this is silence (a room, a fan).
  public static let floorDecibels: Float = -55
  /// Louder than this is as loud as the orb gets.
  public static let ceilingDecibels: Float = -12

  /// The root mean square of `samples`; 0 for none.
  public static func rms(_ samples: UnsafeBufferPointer<Float>) -> Float {
    guard !samples.isEmpty else {
      return 0
    }

    var sum: Float = 0

    for sample in samples {
      sum += sample * sample
    }

    return (sum / Float(samples.count)).squareRoot()
  }

  /// A root mean square as a level between 0 and 1: decibels between the floor and the ceiling, eased
  /// so a voice at speaking volume sits in the middle rather than at the top.
  public static func normalized(rms: Float) -> Double {
    guard rms.isFinite, rms > 0 else {
      return 0
    }

    let decibels = 20 * log10(rms)
    let linear = (decibels - floorDecibels) / (ceilingDecibels - floorDecibels)
    let clamped = min(1, max(0, linear))
    // Square root: the quiet half of the range is where a voice's detail is.
    return Double(clamped.squareRoot())
  }
}

/// The latest level, from the audio thread to the screen. Lock-free: one atomic word holds the bits
/// of a `Float`.
public final class VoiceLevelMeter: Sendable {
  private let bits = Atomic<UInt32>(0)

  public init() {}

  /// Called on the audio thread.
  public func record(_ level: Double) {
    let value = Float(min(1, max(0, level.isFinite ? level : 0)))
    bits.store(value.bitPattern, ordering: .relaxed)
  }

  /// Called on the audio thread, with the samples of one buffer.
  public func record(samples: UnsafeBufferPointer<Float>) {
    record(VoiceLevel.normalized(rms: VoiceLevel.rms(samples)))
  }

  /// The latest level, 0 to 1.
  public var level: Double {
    Double(Float(bitPattern: bits.load(ordering: .relaxed)))
  }

  public func reset() {
    bits.store(0, ordering: .relaxed)
  }
}

/// The microphone's level and the speaker's.
public struct VoiceMeters: Sendable {
  public let input: VoiceLevelMeter
  public let output: VoiceLevelMeter

  public init(input: VoiceLevelMeter = VoiceLevelMeter(), output: VoiceLevelMeter = VoiceLevelMeter()) {
    self.input = input
    self.output = output
  }
}

/// A level that follows its target quickly up and slowly down, the way a meter's needle does: a
/// syllable lifts the orb at once and it settles over a quarter of a second.
public struct VoiceLevelSmoother: Sendable, Equatable {
  /// Seconds to cover about two thirds of the way up.
  public var attack: Double
  /// And down.
  public var release: Double
  public private(set) var value: Double = 0

  public init(attack: Double = 0.04, release: Double = 0.25) {
    self.attack = attack
    self.release = release
  }

  /// Move toward `target` over `elapsed` seconds and answer where it is now. A gap of a second (the
  /// screen was not drawn) lands on the target.
  public mutating func step(toward target: Double, elapsed: Double) -> Double {
    let goal = min(1, max(0, target.isFinite ? target : 0))
    let time = max(0, min(1, elapsed.isFinite ? elapsed : 0))
    let constant = goal > value ? attack : release
    let share = constant <= 0 ? 1 : 1 - exp(-time / constant)
    value += (goal - value) * share
    return value
  }
}

/// How much the voice's pitch moves with the setup screen's Expressivity: a little higher or lower
/// overall, and a small rise and fall from one sentence to the next so a long reply does not drone.
/// Plain numbers on `AVSpeechUtterance.pitchMultiplier`, never markup in the text: a reply's words
/// are the bot's, and they are not parsed as instructions to the synthesiser.
public enum VoiceProsody {
  /// The rise and fall over four sentences, before it repeats.
  static let contour: [Double] = [0, 0.6, -0.4, 0.3]

  /// The pitch for the `sentence`th piece of a reply (0 for a reply read whole).
  public static func pitch(expressivity: Double, sentence: Int) -> Double {
    let amount = min(1, max(0, expressivity.isFinite ? expressivity : 0.5))
    let base = 1 + (amount - 0.5) * 0.16
    let swing = amount * 0.07 * contour[abs(sentence) % contour.count]
    return min(1.3, max(0.8, base + swing))
  }
}
