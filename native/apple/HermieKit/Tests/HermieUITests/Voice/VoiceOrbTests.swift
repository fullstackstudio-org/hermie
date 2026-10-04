import Foundation
import Testing

@testable import HermieCore
@testable import HermieUI

/// What the orb does in each mode is a pure mapping; no frame is drawn here.
@MainActor
@Suite struct VoiceOrbTests {
  private func motion(
    _ mode: VoiceOrbMode, busy: Bool = false, level: Double = 0, reduceMotion: Bool = false
  ) -> VoiceOrbMotion {
    VoiceOrbMotion.target(mode: mode, busy: busy, level: level, reduceMotion: reduceMotion)
  }

  @Test func thinkingSwirlsFasterThanIdle() {
    #expect(motion(.thinking).swirl > motion(.idle).swirl * 2)
    #expect(motion(.thinking).shimmer > 0.5)
    #expect(motion(.idle).shimmer == 0)
  }

  @Test func busyInAnyModeSwirlsLikeThinking() {
    for mode in [VoiceOrbMode.idle, .listening, .speaking, .muted] {
      #expect(motion(mode, busy: true).swirl >= VoiceOrbMotion.workingSwirl)
      #expect(motion(mode, busy: true).swirl > motion(mode, busy: false).swirl)
      #expect(motion(mode, busy: true).shimmer > 0)
    }
  }

  @Test func mutedIsDimmerAndSlowerThanIdle() {
    #expect(motion(.muted).brightness < motion(.idle).brightness)
    #expect(motion(.muted).swirl < motion(.idle).swirl)
    #expect(motion(.muted).glow < motion(.idle).glow)
  }

  @Test func listeningAndSpeakingSwellWithTheLevel() {
    for mode in [VoiceOrbMode.listening, .speaking] {
      let quiet = motion(mode, level: 0)
      let loud = motion(mode, level: 1)

      #expect(loud.scale > quiet.scale)
      #expect(loud.glow > quiet.glow)
      #expect(loud.ripple > quiet.ripple)
      #expect(loud.swirl > quiet.swirl)
    }
  }

  @Test func otherModesIgnoreTheLevel() {
    for mode in [VoiceOrbMode.idle, .thinking, .muted] {
      #expect(motion(mode, level: 1) == motion(mode, level: 0))
    }
  }

  @Test func theLevelIsClamped() {
    #expect(motion(.listening, level: 5) == motion(.listening, level: 1))
    #expect(motion(.listening, level: -3) == motion(.listening, level: 0))
    #expect(motion(.listening, level: .nan) == motion(.listening, level: 0))
  }

  @Test func reduceMotionHasNoSwirlNoParticlesAndNoSwelling() {
    for mode in [VoiceOrbMode.idle, .listening, .thinking, .speaking, .muted] {
      let still = motion(mode, busy: true, level: 1, reduceMotion: true)

      #expect(still.swirl == 0)
      #expect(still.shimmer == 0)
      #expect(still.sparkle == 0)
      #expect(still.ripple == 0)
      #expect(still.scale == 1)
      #expect(still.breath == 0)
      #expect(still.pulse > 0)
    }
  }

  @Test func reduceMotionLetsTheLevelMoveTheBrightness() {
    #expect(motion(.speaking, level: 1, reduceMotion: true).brightness > motion(.speaking, level: 0, reduceMotion: true).brightness)
    #expect(motion(.muted, reduceMotion: true).brightness < motion(.idle, reduceMotion: true).brightness)
  }

  @Test func mixingMovesBetweenTheTwoEnds() {
    let from = motion(.idle)
    let to = motion(.thinking)

    func close(_ left: VoiceOrbMotion, _ right: VoiceOrbMotion) -> Bool {
      abs(left.swirl - right.swirl) < 1e-9 && abs(left.scale - right.scale) < 1e-9
        && abs(left.glow - right.glow) < 1e-9 && abs(left.shimmer - right.shimmer) < 1e-9
        && abs(left.brightness - right.brightness) < 1e-9
    }

    #expect(close(from.mixed(to: to, amount: 0), from))
    #expect(close(from.mixed(to: to, amount: 1), to))
    #expect(close(from.mixed(to: to, amount: 7), to))

    let half = from.mixed(to: to, amount: 0.5)

    #expect(half.swirl > from.swirl && half.swirl < to.swirl)
  }

  // MARK: The driver

  @Test func theFirstFrameLandsOnTheMode() {
    let driver = VoiceOrbDriver()
    let frame = driver.frame(at: 100, mode: .thinking, busy: false, rawLevel: 0, reduceMotion: false)

    #expect(frame.motion == motion(.thinking))
    #expect(frame.level == 0)
  }

  @Test func aChangeOfModeGlidesInsteadOfJumping() {
    let driver = VoiceOrbDriver()
    _ = driver.frame(at: 0, mode: .idle, busy: false, rawLevel: 0, reduceMotion: false)

    let next = driver.frame(at: 1.0 / 60, mode: .thinking, busy: false, rawLevel: 0, reduceMotion: false)

    #expect(next.motion.swirl > motion(.idle).swirl)
    #expect(next.motion.swirl < motion(.thinking).swirl)

    var later = next

    for tick in 2...120 {
      later = driver.frame(at: Double(tick) / 60, mode: .thinking, busy: false, rawLevel: 0, reduceMotion: false)
    }

    #expect(abs(later.motion.swirl - motion(.thinking).swirl) < 0.01)
  }

  @Test func theLevelRisesFastAndFallsSlowly() {
    let driver = VoiceOrbDriver()
    _ = driver.frame(at: 0, mode: .listening, busy: false, rawLevel: 0, reduceMotion: false)

    let up = driver.frame(at: 0.1, mode: .listening, busy: false, rawLevel: 1, reduceMotion: false)

    #expect(up.level > 0.8)
    #expect(up.motion.scale > 1.1)

    let down = driver.frame(at: 0.2, mode: .listening, busy: false, rawLevel: 0, reduceMotion: false)

    #expect(down.level > 0.3)
    #expect(down.level < up.level)
  }

  @Test func aModeThatDoesNotFollowTheLevelDoesNotSwell() {
    let driver = VoiceOrbDriver()
    _ = driver.frame(at: 0, mode: .thinking, busy: false, rawLevel: 1, reduceMotion: false)
    let frame = driver.frame(at: 0.1, mode: .thinking, busy: false, rawLevel: 1, reduceMotion: false)

    #expect(frame.level == 0)
    #expect(frame.motion.scale == 1)
  }

  @Test func theSwirlPhaseAdvancesFasterWhileThinking() {
    func phase(after mode: VoiceOrbMode) -> Double {
      let driver = VoiceOrbDriver()
      var frame = driver.frame(at: 0, mode: mode, busy: false, rawLevel: 0, reduceMotion: false)

      for tick in 1...120 {
        frame = driver.frame(at: Double(tick) / 60, mode: mode, busy: false, rawLevel: 0, reduceMotion: false)
      }

      return frame.swirlPhase
    }

    #expect(phase(after: .thinking) > phase(after: .idle) * 2)
    #expect(phase(after: .muted) < phase(after: .idle))
  }

  @Test func reduceMotionNeverAdvancesThePhase() {
    let driver = VoiceOrbDriver()
    var frame = driver.frame(at: 0, mode: .thinking, busy: true, rawLevel: 1, reduceMotion: true)

    for tick in 1...60 {
      frame = driver.frame(at: Double(tick) / 60, mode: .thinking, busy: true, rawLevel: 1, reduceMotion: true)
    }

    #expect(frame.swirlPhase == 0)
    #expect(frame.shimmerPhase == 0)
  }

  @Test func aLongGapDoesNotThrowThePhase() {
    let driver = VoiceOrbDriver()
    let first = driver.frame(at: 0, mode: .thinking, busy: false, rawLevel: 0, reduceMotion: false)
    // The app was in the background for an hour.
    let second = driver.frame(at: 3600, mode: .thinking, busy: false, rawLevel: 0, reduceMotion: false)

    #expect(second.swirlPhase - first.swirlPhase <= VoiceOrbMotion.workingSwirl * 0.1 + 0.0001)
  }

  @Test func opacityStaysInRange() {
    for time in stride(from: 0.0, to: 5.0, by: 0.25) {
      let still = VoiceOrbFrame(
        motion: motion(.thinking, reduceMotion: true), level: 0, swirlPhase: 0, shimmerPhase: 0, time: time)
      let muted = VoiceOrbFrame(motion: motion(.muted), level: 0, swirlPhase: 0, shimmerPhase: 0, time: time)

      #expect((0...1).contains(still.opacity))
      #expect(muted.opacity <= 0.45 + 0.0001)
    }
  }

  @Test func theMeshKeepsItsCornersAndEdges() {
    for phase in [0.0, 1.3, 7.9, 40] {
      let points = VoiceOrbPainter.meshPoints(phase: phase, amount: 1)

      #expect(points.count == 9)
      #expect(points[0] == SIMD2(0, 0) && points[2] == SIMD2(1, 0))
      #expect(points[6] == SIMD2(0, 1) && points[8] == SIMD2(1, 1))
      #expect(points[1].y == 0 && points[7].y == 1 && points[3].x == 0 && points[5].x == 1)
    }

    #expect(VoiceOrbPainter.meshPoints(phase: 5, amount: 0) == VoiceOrbPainter.meshPoints(phase: 0, amount: 0))
  }
}

/// A synthesiser that holds what it was asked to say: no sound.
@MainActor
private final class PreviewSpeaker: SpeechSynthesizing {
  var isAvailable = true
  var catalogue: [SpeechVoice] = []
  var access: PersonalVoiceAccess = .notAsked
  var accessAfterAsking: PersonalVoiceAccess = .granted
  var catalogueAfterAsking: [SpeechVoice]?
  private(set) var spoken: [(request: ReadRequest, rate: Double, voice: String?)] = []
  private(set) var stops = 0
  private var finish: [@MainActor @Sendable () -> Void] = []

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {
    spoken.append((request, rate, voice))
    finish.append(onDone)
  }

  func stop() { stops += 1 }
  func voices() -> [SpeechVoice] { catalogue }
  func personalVoiceAccess() -> PersonalVoiceAccess { access }

  func requestPersonalVoiceAccess() async -> PersonalVoiceAccess {
    access = accessAfterAsking

    if let more = catalogueAfterAsking {
      catalogue = more
    }

    return access
  }

  /// The utterance `index` ends by itself.
  func complete(_ index: Int) { finish[index]() }
}

/// The Voice screen's rules: which language it opens on, the order of the dots, the preview.
@MainActor
@Suite struct VoiceOrbSetupLogicTests {
  private let voices: [SpeechVoice] = [
    SpeechVoice(id: "nl-a", name: "Xander", language: "nl-NL", quality: .compact),
    SpeechVoice(id: "nl-b", name: "Claire", language: "nl-NL", quality: .enhanced),
    SpeechVoice(id: "en-us-a", name: "Ava", language: "en-US", quality: .enhanced),
    SpeechVoice(id: "en-us-b", name: "Allison", language: "en-US", quality: .compact),
    SpeechVoice(id: "en-us-c", name: "Zoe", language: "en-US", quality: .premium),
    SpeechVoice(id: "en-gb-a", name: "Daniel", language: "en-GB", quality: .compact),
    SpeechVoice(id: "me", name: "Me", language: "en-US", quality: .compact, personal: true)
  ]

  private func model(
    _ speaker: PreviewSpeaker, device: String = "en-US", chosen: String? = nil
  ) -> VoiceSetupModel {
    let settings = VoiceSettings()
    settings.setVoiceIdentifier(chosen)

    return VoiceSetupModel(settings: settings, speaker: speaker, deviceTag: device, sample: "Hello there")
  }

  @Test func dotsAreOrderedPersonalThenBestQualityThenByName() {
    let order = VoiceSetupLogic.voices(in: "en-US", from: voices).map(\.id)

    #expect(order == ["me", "en-us-c", "en-us-a", "en-us-b"])
  }

  @Test func aLanguageNobodyHasHasNoVoices() {
    #expect(VoiceSetupLogic.voices(in: "fr-FR", from: voices).isEmpty)
    #expect(VoiceSetupLogic.voices(in: nil, from: voices).isEmpty)
  }

  @Test func opensOnTheChosenVoicesLanguage() {
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: "nl-b", deviceTag: "en-US") == "nl-NL")
  }

  @Test func opensOnTheDeviceLanguageWhenNoVoiceIsChosen() {
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: nil, deviceTag: "nl-NL") == "nl-NL")
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: nil, deviceTag: "en_GB") == "en-GB")
    // Same language, another region: the region that fits comes first, else any of the language.
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: nil, deviceTag: "nl-BE") == "nl-NL")
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: nil, deviceTag: "en-AU") != nil)
    // A chosen voice that is gone does not decide.
    #expect(VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: "gone", deviceTag: "nl-NL") == "nl-NL")
  }

  @Test func opensOnTheFirstLanguageWhenTheDeviceLanguageHasNoVoices() {
    let tag = VoiceSetupLogic.defaultLanguage(voices: voices, chosenID: nil, deviceTag: "ja-JP")

    #expect(tag != nil)
    #expect(VoiceSetupLogic.defaultLanguage(voices: [], chosenID: nil, deviceTag: "nl-NL") == nil)
  }

  @Test func theHintShowsWhenOnlyBasicVoicesExist() {
    #expect(VoiceSetupLogic.onlyCompact(VoiceSetupLogic.voices(in: "en-GB", from: voices)))
    #expect(!VoiceSetupLogic.onlyCompact(VoiceSetupLogic.voices(in: "en-US", from: voices)))
    #expect(!VoiceSetupLogic.onlyCompact(VoiceSetupLogic.voices(in: "nl-NL", from: voices)))
    #expect(!VoiceSetupLogic.onlyCompact([]))
  }

  @Test func aDotIsNamedByNumberNameQualityAndSelection() {
    let ava = voices[2]
    let plain = VoiceSetupLogic.dotLabel(number: 3, voice: ava, selected: false)
    let chosen = VoiceSetupLogic.dotLabel(number: 3, voice: ava, selected: true)

    #expect(plain.contains("3") && plain.contains("Ava") && plain.contains("enhanced"))
    #expect(chosen.hasPrefix(plain) && chosen.count > plain.count)
  }

  @Test func theSliderSnapsToItsTicks() {
    let steps = VoiceSettings.rateSteps
    let range = steps[0]...steps[steps.count - 1]

    #expect(VoiceSliderMath.value(fraction: 0, range: range, ticks: steps, snap: true) == 0.5)
    #expect(VoiceSliderMath.value(fraction: 1, range: range, ticks: steps, snap: true) == 1.5)
    #expect(VoiceSliderMath.value(fraction: 0.52, range: range, ticks: steps, snap: true) == 1)
    #expect(VoiceSliderMath.value(fraction: 0.7, range: range, ticks: steps, snap: true) == 1.25)
    #expect(VoiceSliderMath.value(fraction: 9, range: range, ticks: steps, snap: true) == 1.5)
    #expect(VoiceSliderMath.value(fraction: 0.3, range: 0...1, ticks: [0, 1], snap: false) == 0.3)
    #expect(VoiceSliderMath.fraction(of: 1, range: range) == 0.5)
  }

  @Test func voiceOverStepsThroughTheTicks() {
    let steps = VoiceSettings.rateSteps
    let range = steps[0]...steps[steps.count - 1]

    #expect(VoiceSliderMath.adjusted(value: 1, direction: 1, range: range, ticks: steps, snap: true) == 1.25)
    #expect(VoiceSliderMath.adjusted(value: 1, direction: -1, range: range, ticks: steps, snap: true) == 0.75)
    #expect(VoiceSliderMath.adjusted(value: 1.5, direction: 1, range: range, ticks: steps, snap: true) == 1.5)
    #expect(abs(VoiceSliderMath.adjusted(value: 0.5, direction: 1, range: 0...1, ticks: [], snap: false) - 0.6) < 1e-9)
    #expect(VoiceSliderMath.adjusted(value: 0.95, direction: 1, range: 0...1, ticks: [], snap: false) == 1)
  }

  @Test func thePreviewLevelStaysInRange() {
    for time in stride(from: 0.0, to: 20.0, by: 0.05) {
      #expect((0...1).contains(VoiceSetupLogic.previewLevel(at: time)))
    }
  }

  // MARK: The model

  @Test func loadingOpensOnALanguageAndListsItsVoices() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker, device: "nl-NL")

    setup.load()

    #expect(setup.language == "nl-NL")
    #expect(setup.shown.map(\.id) == ["nl-b", "nl-a"])
    #expect(setup.languages.count == 3)
    #expect(setup.access == .notAsked)
  }

  @Test func choosingAVoiceSavesItAndSpeaksTheSample() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker, device: "en-US")
    setup.load()
    setup.settings.setRate(1.25)

    setup.select("en-us-c")

    #expect(setup.settings.voiceIdentifier == "en-us-c")
    #expect(setup.previewing)
    #expect(speaker.stops == 1)
    #expect(speaker.spoken.count == 1)
    #expect(speaker.spoken[0].voice == "en-us-c")
    #expect(speaker.spoken[0].rate == 1.25)
    #expect(speaker.spoken[0].request.text == "Hello there")
    #expect(speaker.spoken[0].request.language == "en-US")
    #expect(speaker.spoken[0].request.id == "preview")

    speaker.complete(0)

    #expect(!setup.previewing)
  }

  @Test func automaticClearsTheVoiceAndStillSpeaks() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker, device: "nl-NL", chosen: "nl-b")
    setup.load()

    setup.select(nil)

    #expect(setup.settings.voiceIdentifier == nil)
    #expect(speaker.spoken.count == 1)
    #expect(speaker.spoken[0].voice == nil)
    #expect(speaker.spoken[0].request.language == "nl-NL")
    #expect(setup.caption == NativeStrings.VoiceSetup.automatic)
  }

  @Test func aSampleThatWasCutDoesNotEndTheNextOne() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker)
    setup.load()

    setup.select("en-us-a")
    setup.select("en-us-c")
    // The first sample's callback arrives late: it must not stop the orb for the second.
    speaker.complete(0)

    #expect(setup.previewing)

    speaker.complete(1)

    #expect(!setup.previewing)
  }

  @Test func leavingStopsTheSpeakerAndTheOrb() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker)
    setup.load()
    setup.select("en-us-a")

    setup.stop()

    #expect(!setup.previewing)
    #expect(speaker.stops == 2)

    speaker.complete(0)

    #expect(!setup.previewing)
  }

  @Test func noSynthesiserMeansNoPreview() {
    let speaker = PreviewSpeaker()
    speaker.isAvailable = false
    speaker.catalogue = voices
    let setup = model(speaker)
    setup.load()

    setup.select("en-us-a")

    #expect(speaker.spoken.isEmpty)
    #expect(!setup.previewing)
  }

  @Test func personalVoicesAppearOnceAccessIsGranted() async {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices.filter { !$0.personal }
    speaker.catalogueAfterAsking = voices
    let setup = model(speaker)
    setup.load()

    #expect(setup.access == .notAsked)
    #expect(!setup.shown.contains { $0.personal })

    await setup.requestPersonalVoice()

    #expect(setup.access == .granted)
    #expect(setup.shown.first?.personal == true)
  }

  @Test func deniedPersonalVoiceIsKept() async {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    speaker.accessAfterAsking = .denied
    let setup = model(speaker)
    setup.load()

    await setup.requestPersonalVoice()

    #expect(setup.access == .denied)
  }

  @Test func theCaptionNamesAVoiceFromAnotherLanguageWithItsLanguage() {
    let speaker = PreviewSpeaker()
    speaker.catalogue = voices
    let setup = model(speaker, device: "nl-NL", chosen: "en-us-a")
    setup.load()

    #expect(setup.language == "en-US")
    #expect(setup.caption == "Ava")

    setup.selectLanguage("nl-NL")

    #expect(setup.caption.hasPrefix("Ava · "))
  }
}
