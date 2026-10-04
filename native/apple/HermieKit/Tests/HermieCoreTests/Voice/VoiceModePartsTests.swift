import Foundation
import Testing

@testable import HermieCore

/// The pure parts of voice mode: where a streaming reply may be cut, the "still working" lines, the
/// call's context, the level meter and the pitch.
@Suite struct VoiceModePartsTests {
  private let codeBlock: (Int) -> String = { "A code block of \($0) lines." }

  // MARK: Cutting a streaming reply

  @Test func aSentenceIsHandedOverOnceItIsFollowedByASpace() {
    var cutter = SpokenReplyCutter()
    #expect(cutter.take("Hello the", finished: false, codeBlock: codeBlock) == nil)
    #expect(cutter.take("Hello there. How", finished: false, codeBlock: codeBlock) == "Hello there.")
    #expect(cutter.take("Hello there. How are you?", finished: false, codeBlock: codeBlock) == nil, "no space yet")
    #expect(cutter.take("Hello there. How are you? Fine", finished: false, codeBlock: codeBlock) == "How are you?")
    #expect(cutter.take("Hello there. How are you? Fine", finished: true, codeBlock: codeBlock) == "Fine.")
    #expect(cutter.take("Hello there. How are you? Fine", finished: true, codeBlock: codeBlock) == nil)
  }

  @Test func aFinishedLineIsHandedOverWhole() {
    var cutter = SpokenReplyCutter()
    #expect(cutter.take("## Results\n- one", finished: false, codeBlock: codeBlock) == "Results.")
  }

  @Test func numbersAndOpenEmphasisAreNotSentenceEnds() {
    var cutter = SpokenReplyCutter()
    #expect(cutter.take("Step 1. then", finished: false, codeBlock: codeBlock) == nil, "a number before the stop")
    #expect(cutter.take("**Bold claim. still bold", finished: false, codeBlock: codeBlock) == nil)
    #expect(cutter.take("`a. b` and", finished: false, codeBlock: codeBlock) == nil, "inside a code span")
  }

  @Test func anOpenFenceHoldsEverythingAfterIt() {
    var cutter = SpokenReplyCutter()
    let open = "Look:\n```\nline one\nline two\n"
    #expect(cutter.take(open, finished: false, codeBlock: codeBlock) == "Look:")
    #expect(cutter.take(open + "line three\n", finished: false, codeBlock: codeBlock) == nil)

    let closed = open + "line three\n```\nThat's it. More"
    let said = cutter.take(closed, finished: false, codeBlock: codeBlock)
    #expect(said?.contains("A code block of 3 lines.") == true)
    #expect(said?.contains("That's it.") == true)
    #expect(said?.contains("More") == false)
  }

  @Test func skippingMakesOnlyWhatArrivesLaterSpeakable() {
    var cutter = SpokenReplyCutter()
    cutter.skip("Already there. ")
    #expect(cutter.take("Already there. New words. ", finished: false, codeBlock: codeBlock) == "New words.")
  }

  // MARK: Filler lines

  @Test func aToolsNameChoosesTheKindOfLine() {
    #expect(VoiceFillerKind.of(tool: "web_search") == .search)
    #expect(VoiceFillerKind.of(tool: "browser_navigate") == .search)
    #expect(VoiceFillerKind.of(tool: "read_file") == .reading)
    #expect(VoiceFillerKind.of(tool: "terminal") == .working)
    #expect(VoiceFillerKind.of(tool: "mystery") == .generic)
    #expect(VoiceFillerKind.of(tool: nil) == .generic)
  }

  @Test func aLineIsDueAfterTheQuietAndNotAgainWithinTheSpacing() {
    var policy = VoiceFillerPolicy(quiet: 3, spacing: 12, variants: [.generic: 3])
    #expect(!policy.due(at: 0), "no turn yet")

    policy.began(at: 10)
    #expect(!policy.due(at: 12.9))
    #expect(policy.due(at: 13))

    let first = policy.next(at: 13)
    #expect(first.kind == .generic)
    #expect(!policy.due(at: 20))
    #expect(policy.wait(from: 20) == 5)
    #expect(policy.due(at: 25))

    let second = policy.next(at: 25)
    #expect(second != first, "never the same line twice in a row")
  }

  @Test func theBotsOwnLineHoldsTheFillerBack() {
    var policy = VoiceFillerPolicy(quiet: 3, spacing: 12, variants: [:])
    policy.began(at: 0)
    policy.botSpoke(at: 1)
    #expect(!policy.due(at: 5), "it spoke within the spacing")
    #expect(policy.due(at: 13))
  }

  @Test func aToolThatStartedChoosesTheNextLine() {
    var policy = VoiceFillerPolicy(variants: [.search: 2])
    policy.began(at: 0)
    policy.toolStarted("web_search")
    #expect(policy.next(at: 3).kind == .search)

    policy.began(at: 100)
    #expect(policy.next(at: 103).kind == .generic, "a new turn starts without a tool")
  }

  // MARK: The call's context

  @Test func theContextIsNewestLastAndWithinItsLimit() {
    var log = VoiceContextLog(limit: 40, keep: 8)
    #expect(log.rendered() == nil)

    log.add(.user, "first question")
    log.add(.assistant, "first answer")
    log.add(.user, "second")

    let text = log.rendered() ?? ""
    #expect(text.count <= 40)
    #expect(text.hasSuffix("User: second"))
    #expect(!text.contains("first question"), "the oldest goes first")
  }

  @Test func theContextKeepsTheLastFewAndCutsAnOverlongEntryFromTheFront() {
    var log = VoiceContextLog(limit: 10, keep: 2)
    log.add(.user, "a")
    log.add(.user, "b")
    log.add(.user, "c")
    #expect(log.entries.map(\.text) == ["b", "c"])

    var long = VoiceContextLog(limit: 10)
    long.add(.assistant, "0123456789abcdef")
    #expect(long.rendered() == "6789abcdef", "its end is the part that matters")
  }

  // MARK: Levels

  @Test func silenceIsZeroAndALoudVoiceIsOne() {
    #expect(VoiceLevel.normalized(rms: 0) == 0)
    #expect(VoiceLevel.normalized(rms: .nan) == 0)
    #expect(VoiceLevel.normalized(rms: 0.0001) == 0, "below the floor")
    #expect(VoiceLevel.normalized(rms: 1) == 1)

    let speech = VoiceLevel.normalized(rms: 0.03)
    #expect(speech > 0.3 && speech < 0.9, "speaking volume sits in the middle")
  }

  @Test func theRootMeanSquareOfABuffer() {
    let samples: [Float] = [0.5, -0.5, 0.5, -0.5]
    let rms = samples.withUnsafeBufferPointer { VoiceLevel.rms($0) }
    #expect(abs(rms - 0.5) < 0.0001)
    #expect([Float]().withUnsafeBufferPointer { VoiceLevel.rms($0) } == 0)
  }

  @Test func theMeterCarriesTheLatestLevelClamped() {
    let meter = VoiceLevelMeter()
    meter.record(0.42)
    #expect(abs(meter.level - 0.42) < 0.0001)
    meter.record(7)
    #expect(meter.level == 1)
    meter.record(.nan)
    #expect(meter.level == 0)
  }

  @Test func theSmootherRisesFastFallsSlowlyAndIgnoresTheFrameRate() {
    var smoother = VoiceLevelSmoother(attack: 0.04, release: 0.25)
    let up = smoother.step(toward: 1, elapsed: 1.0 / 60)
    #expect(up > 0.3, "a syllable lifts it at once")

    var down = VoiceLevelSmoother(attack: 0.04, release: 0.25)
    _ = down.step(toward: 1, elapsed: 1)
    let fallen = down.step(toward: 0, elapsed: 1.0 / 60)
    #expect(fallen > 0.9, "and it settles slowly")

    var at60 = VoiceLevelSmoother()
    var at120 = VoiceLevelSmoother()

    for _ in 0..<6 {
      _ = at60.step(toward: 0.8, elapsed: 1.0 / 60)
    }

    for _ in 0..<12 {
      _ = at120.step(toward: 0.8, elapsed: 1.0 / 120)
    }

    #expect(abs(at60.value - at120.value) < 0.0001)

    var gap = VoiceLevelSmoother()
    #expect(abs(gap.step(toward: 0.5, elapsed: 5) - 0.5) < 0.01, "a long gap lands on the target")
  }

  // MARK: Pitch

  @Test func expressivityMovesThePitchWithinBounds() {
    #expect(VoiceProsody.pitch(expressivity: 0.5, sentence: 0) == 1, "the middle is the voice's own")
    #expect(VoiceProsody.pitch(expressivity: 0, sentence: 1) == VoiceProsody.pitch(expressivity: 0, sentence: 2), "flat")
    #expect(VoiceProsody.pitch(expressivity: 1, sentence: 1) != VoiceProsody.pitch(expressivity: 1, sentence: 2))

    for sentence in 0..<8 {
      for amount in [0.0, 0.5, 1.0, 9.0, -3.0] {
        let pitch = VoiceProsody.pitch(expressivity: amount, sentence: sentence)
        #expect(pitch >= 0.8 && pitch <= 1.3)
      }
    }
  }
}
