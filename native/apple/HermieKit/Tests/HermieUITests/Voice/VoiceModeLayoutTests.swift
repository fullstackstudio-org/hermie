import CoreGraphics
import Foundation
import HermieTranscript
import ImageIO
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import HermieCore
@testable import HermieUI

// MARK: Fakes for a call that is only ever drawn

@MainActor
private final class QuietSpeaker: VoiceModeSpeaking {
  var isAvailable = true

  func speak(_ request: ReadRequest, rate: Double, voice: String?, onDone: @escaping @MainActor @Sendable () -> Void) {}
  func stop() {}
  func voices() -> [SpeechVoice] { [] }
  func playCue() {}
}

/// A recogniser that opens no microphone and says what it is told to have heard.
@MainActor
private final class ScriptedRecogniser: VoiceModeRecognising {
  var isAvailable = true
  var cancelsEcho = false
  private var events: DictationEvents?

  func requestPermission() async -> RecognitionPermission { .granted }
  func processing(language: String?) -> RecognitionProcessing { .onDevice }
  func supportedLanguages() -> [String] { ["en-US"] }
  func start(language: String?, events: DictationEvents) { self.events = events }
  func stop() {}
  func abort() {}

  func hear(_ words: String) { events?.onPartial(words) }
}

@MainActor
private final class QuietAudio: VoiceModeAudio {
  let meters = VoiceMeters()
  var onEvent: (@MainActor (VoiceAudioEvent) -> Void)?

  func activate() throws {}
  func reactivate() throws {}
  func deactivate() {}
}

/// A clock that never fires: no pause ever ends, nothing is sent on its own.
@MainActor
private final class StillClock: VoiceModeClock {
  final class Idle: VoiceModeTimer {
    func cancel() {}
  }

  var now: Double { 100 }
  func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> any VoiceModeTimer { Idle() }
}

@MainActor
private struct Call {
  let model: VoiceModeModel
  let settings: VoiceSettings
  let recogniser: ScriptedRecogniser

  init() {
    let recogniser = ScriptedRecogniser()
    let settings = VoiceSettings()

    self.recogniser = recogniser
    self.settings = settings
    model = VoiceModeModel(
      engines: VoiceModeEngines(recogniser: recogniser, speaker: QuietSpeaker(), audio: QuietAudio()),
      settings: settings, bot: "hermes", gatewayID: "g1", language: { VoiceSettings.automatic },
      clock: StillClock(), codeBlock: { "A code block of \($0) lines." }, fillers: [.generic: 1],
      fillerText: { _ in "Working." }, send: { _ in true })
  }

  /// The bot answers `reply` and is reading it (the phase is speaking, the caption is the reply).
  func speaking(_ reply: String, orb: VoiceOrbStyle = .light) async {
    settings.setConfirmBeforeSending(false)
    settings.setVoiceModeOrb(orb)
    await model.start()
    recogniser.hear("What is the status of my domains")
    model.sendNow()
    await model.settled()

    let base = ItemBase(id: "u1", seq: 1, ts: 1, origin: .live, version: 1)
    let answer = ItemBase(id: "a1", seq: 2, ts: 1, origin: .live, version: 1)

    model.chatChanged(
      VoiceChatState(
        items: [
          VisibleItem(item: .user(UserItem(base: base, text: "domains")), presentation: .full),
          VisibleItem(
            item: .assistant(AssistantItem(base: answer, text: reply, streaming: true, interim: false)),
            presentation: .full)
        ],
        turnActive: true, activity: .idle, requestUp: false))
  }

  func panel(compact: Bool) -> VoiceModePanel {
    VoiceModePanel(
      call: model, settings: settings, botName: "Hermes", compact: compact, onEnd: {}, onSettings: {})
  }
}

// MARK: Pixels

/// A rendered picture's pixels, premultiplied RGBA, read back to be measured.
private struct Pixels {
  let width: Int
  let height: Int
  let scale: Int
  private let data: [UInt8]

  /// Render `view` over nothing (transparent) at 2x.
  @MainActor
  init?<V: View>(_ view: V, scale: Int = 2) {
    let renderer = ImageRenderer(content: view)
    renderer.scale = CGFloat(scale)
    renderer.isOpaque = false

    guard let image = renderer.cgImage else {
      return nil
    }

    var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = data.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
          bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else {
        return false
      }

      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }

    guard drawn else {
      return nil
    }

    self.width = image.width
    self.height = image.height
    self.scale = scale
    self.data = data
    self.image = image
  }

  let image: CGImage

  func rgba(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
    let at = (min(max(y, 0), height - 1) * width + min(max(x, 0), width - 1)) * 4
    return (Int(data[at]), Int(data[at + 1]), Int(data[at + 2]), Int(data[at + 3]))
  }

  /// The brightest light in the pixel: its largest premultiplied channel (what shows over black).
  func light(_ x: Int, _ y: Int) -> Int {
    let pixel = rgba(x, y)
    return max(pixel.r, pixel.g, pixel.b)
  }

  /// The largest alpha in the rectangle (points, origin top-left).
  func maxAlpha(x: ClosedRange<Int>, y: ClosedRange<Int>) -> Int {
    var best = 0

    for row in y {
      for column in x {
        best = max(best, rgba(column, row).a)
      }
    }

    return best
  }

  /// The brightest pixel in the rectangle, in pixels.
  func maxLight(x: ClosedRange<Int>, y: ClosedRange<Int>) -> Int {
    var best = 0

    for row in y {
      for column in x {
        best = max(best, light(column, row))
      }
    }

    return best
  }

  /// Every pixel in the outermost `band` pixels is fully transparent.
  func borderMaxAlpha(band: Int = 3) -> Int {
    max(
      maxAlpha(x: 0...(width - 1), y: 0...(band - 1)),
      maxAlpha(x: 0...(width - 1), y: (height - band)...(height - 1)),
      maxAlpha(x: 0...(band - 1), y: 0...(height - 1)),
      maxAlpha(x: (width - band)...(width - 1), y: 0...(height - 1)))
  }

  /// How many places along the edges of the square of `side` points, centred, show light that is cut
  /// there: lit on the inner side, and some way further in as well (so it is not a thin line running
  /// along the edge), but a quarter as bright or less on the outer side (so it does not carry on). A line that crosses
  /// the edge carries on, a glow that fades there is not cut; a clipped glow or a clipped line is.
  func cutPlaces(side: Int) -> Int {
    let half = side * scale / 2
    let cx = width / 2
    let cy = height / 2
    let depth = 4
    var cuts = 0

    // `along` is the direction of the edge: the outer side is looked at a few pixels either way along it,
    // so a line that crosses the edge at a slant, and comes out a little to the side, carries on.
    func cut(_ inside: (Int, Int), _ deeper: (Int, Int), _ outside: (Int, Int), along: (Int, Int)) -> Bool {
      let near = light(inside.0, inside.1)

      guard near > 12, light(deeper.0, deeper.1) * 10 >= near * 7 else {
        return false
      }

      let beyond = (-4...4).map { light(outside.0 + $0 * along.0, outside.1 + $0 * along.1) }.max() ?? 0
      return beyond * 4 < near
    }

    for step in -half...half {
      let x = cx + step
      let y = cy + step

      if cut((x, cy - half), (x, cy - half + depth), (x, cy - half - 1), along: (1, 0)) { cuts += 1 }
      if cut((x, cy + half - 1), (x, cy + half - 1 - depth), (x, cy + half), along: (1, 0)) { cuts += 1 }
      if cut((cx - half, y), (cx - half + depth, y), (cx - half - 1, y), along: (0, 1)) { cuts += 1 }
      if cut((cx + half - 1, y), (cx + half - 1 - depth, y), (cx + half, y), along: (0, 1)) { cuts += 1 }
    }

    return cuts
  }

  /// Write it as a PNG in `HERMIE_RENDER_DIR`, when that is set (for looking at it).
  func save(_ name: String) {
    guard let directory = ProcessInfo.processInfo.environment["HERMIE_RENDER_DIR"] else {
      return
    }

    let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
    try? FileManager.default.createDirectory(
      at: URL(fileURLWithPath: directory), withIntermediateDirectories: true)

    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else {
      return
    }

    CGImageDestinationAddImage(destination, image, nil)
    CGImageDestinationFinalize(destination)
  }
}

// MARK: The tests

/// The three things the call screen got wrong on the iPhone (TestFlight 1264): the orb inside a visible
/// square, the settings glyph on the status bar, and a caption cut in the middle. Measured on
/// off-screen renders, no window and no UI automation.
@MainActor
@Suite struct VoiceModeLayoutTests {
  // MARK: The orb's frame

  private func frame(
    mode: VoiceOrbMode, level: Double, phase: Double, busy: Bool = false
  ) -> VoiceOrbFrame {
    // The orb as it is when the level has been loud for a while: the target at that level, fully eased.
    let motion = VoiceOrbMotion.target(mode: mode, busy: busy, level: level, reduceMotion: false)

    return VoiceOrbFrame(
      motion: motion, level: level, swirlPhase: phase, shimmerPhase: phase * 1.7, time: phase * 0.37)
  }

  private static let modes: [VoiceOrbMode] = [.idle, .listening, .speaking, .thinking, .muted]

  @Test func theCanvasIsLargeEnoughForEverythingTheOrbPaintsAtFullSwell() {
    let limit = VoiceOrbPainter.fadeStart * VoiceOrbPainter.bleed / 2

    // What each painter reaches, before the swell.
    #expect(VoiceOrbPainter.cloudHaloReach <= VoiceOrbPainter.reach)
    #expect(VoiceOrbPainter.lightGlowReach <= VoiceOrbPainter.reach)
    #expect(VoiceOrbPainter.sparkleReach <= Double(VoiceOrbPainter.reach))

    // And the rings, at the ripple of every mode and level: the lines' full amplitude.
    var widest = 0.0
    var largest = 0.0

    for mode in Self.modes {
      for busy in [false, true] {
        for step in 0...20 {
          let motion = VoiceOrbMotion.target(mode: mode, busy: busy, level: Double(step) / 20, reduceMotion: false)
          let swell = motion.scale * (1 + motion.breath)
          let rings = VoiceOrbPainter.maxRingExtent(ripple: motion.ripple)

          widest = max(widest, rings)
          largest = max(largest, swell)
          #expect(rings <= Double(VoiceOrbPainter.reach), "\(mode) ring at level \(step)/20")
          #expect(swell <= Double(VoiceOrbPainter.maxScale), "\(mode) swell at level \(step)/20")
          #expect(rings * swell <= Double(limit), "\(mode) ring, swollen, is inside the fade")
        }
      }
    }

    #expect(widest > 0.5, "the rings really do reach past the old square's half side: \(widest)")
    #expect(largest > 1.15)
    #expect(Double(VoiceOrbPainter.paintedReach) <= Double(limit))
    #expect(VoiceOrbPainter.bleed > 1.5)
  }

  @Test func theOrbPaintsNoBackgroundAndNothingAtTheCanvasEdgeAtFullSwell() throws {
    let size: CGFloat = 250
    let canvas = Int(VoiceOrbPainter.canvasSide(for: size))
    var beyondOldFrame = 0

    for style in [VoiceOrbStyle.light, .clouds] {
      for mode in [VoiceOrbMode.listening, .speaking, .thinking] {
        for phase in stride(from: 0.0, to: 12.0, by: 1.3) {
          let layers = VoiceOrbLayers(
            style: style, frame: frame(mode: mode, level: 1, phase: phase), reduceMotion: false, size: size)
          let pixels = try #require(
            Pixels(layers.frame(width: CGFloat(canvas), height: CGFloat(canvas))), "\(style) \(mode)")

          #expect(pixels.borderMaxAlpha() == 0, "\(style) \(mode) phase \(phase): nothing reaches the canvas edge")

          let corners = [(0, 0), (pixels.width - 1, 0), (0, pixels.height - 1), (pixels.width - 1, pixels.height - 1)]
          #expect(corners.allSatisfy { pixels.rgba($0.0, $0.1).a == 0 }, "no layer paints a background")

          // The picture goes on past the old square: the lines and the glow are not cut at it.
          let old = Int(size) * pixels.scale
          let margin = (pixels.width - old) / 2
          beyondOldFrame = max(beyondOldFrame, pixels.maxAlpha(x: 0...(margin - 1), y: 0...(pixels.height - 1)))

          // And there is no step in the picture where the old square's edge was.
          #expect(pixels.cutPlaces(side: Int(size)) == 0, "\(style) \(mode) phase \(phase): nothing is cut at the old frame")

          if phase == 0 {
            pixels.save("orb-\(style.rawValue)-\(mode)-full-swell-on-transparent")
          }
        }
      }
    }

    #expect(beyondOldFrame > 0, "at full swell the orb paints outside the old square")
  }

  @Test func theOrbBlendsIntoBlackWithNoStepAtTheOldFrameOrAnywhere() throws {
    let size: CGFloat = 250
    let canvas = VoiceOrbPainter.canvasSide(for: size)

    for style in [VoiceOrbStyle.light, .clouds] {
      for (name, mode, level) in [("idle", VoiceOrbMode.idle, 0.0), ("loud", .listening, 1.0), ("busy", .thinking, 0)] {
        let layers = VoiceOrbLayers(
          style: style, frame: frame(mode: mode, level: level, phase: 2.2), reduceMotion: false, size: size)
        let pixels = try #require(
          Pixels(layers.frame(width: canvas, height: canvas).background(Color.black)), "\(style) \(name)")

        // The corners of the orb's frame are pure background, and so is the canvas's rim.
        let half = Int(size) * pixels.scale / 2
        let cx = pixels.width / 2
        let cy = pixels.height / 2
        for (dx, dy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
          #expect(pixels.light(cx + dx * (half - 2), cy + dy * (half - 2)) == 0, "\(style) \(name): a corner of the frame")
        }
        #expect(pixels.light(0, 0) == 0)
        #expect(pixels.cutPlaces(side: Int(size)) == 0, "\(style) \(name): nothing is cut at the old frame")

        pixels.save("orb-\(style.rawValue)-\(name)-on-black")
      }
    }
  }

  @Test func theMeasureWouldHaveCaughtTheSquareBefore() throws {
    // The control: the same frames cut to the old square (what the orb did) show cut places. If this
    // stops being so, "nothing is cut" above proves nothing.
    let size: CGFloat = 250
    let canvas = VoiceOrbPainter.canvasSide(for: size)
    var worst = 0

    for style in [VoiceOrbStyle.light, .clouds] {
      let layers = VoiceOrbLayers(
        style: style, frame: frame(mode: .listening, level: 1, phase: 2.2), reduceMotion: false, size: size)
      let cut = layers.frame(width: size, height: size).clipped().frame(width: canvas, height: canvas)
      let pixels = try #require(Pixels(cut.background(Color.black)))

      worst = max(worst, pixels.cutPlaces(side: Int(size)))
      pixels.save("orb-\(style.rawValue)-loud-CLIPPED-to-the-old-square-control")
    }

    #expect(worst > 20, "the clipped orb has cut places: \(worst)")
  }

  @Test func theProductionOrbViewHasTheSameCanvasAndMask() throws {
    let size: CGFloat = 250
    let canvas = VoiceOrbPainter.canvasSide(for: size)
    let orb = VoiceOrb(style: .light, mode: .idle, busy: false, level: { 0 }, size: size)
    let pixels = try #require(Pixels(orb.frame(width: canvas, height: canvas)))

    #expect(pixels.borderMaxAlpha() == 0)
    #expect(pixels.maxAlpha(x: 0...(pixels.width - 1), y: 0...(pixels.height - 1)) > 0, "it did draw")
    pixels.save("orb-production-idle-on-transparent")
  }

  @Test func theFadeIsOpaqueInsideItsStartAndNothingAtTheRim() {
    let limit = VoiceOrbPainter.paintedReach
    #expect(limit < VoiceOrbPainter.fadeStart * VoiceOrbPainter.bleed / 2)
    #expect(VoiceOrbPainter.fadeStart > 0.5 && VoiceOrbPainter.fadeStart < 1)
  }

  // MARK: The shimmer on the rim

  @Test func theShimmerStaysOnTheRingAndHasNoHardSeam() throws {
    let size: CGFloat = 250
    let canvas = VoiceOrbPainter.canvasSide(for: size)
    let core = Double(size) * Double(VoiceOrbPainter.coreShare)
    let rimOuter = core * (1 + Double(VoiceOrbPainter.rimWidth) / 2)

    // A working orb with the shimmer's head at 3 o'clock (where a conic gradient has its seam), and the
    // same orb with the shimmer taken out: the difference is the shimmer alone.
    func render(shimmer: Bool) throws -> Pixels {
      var working = frame(mode: .thinking, level: 0, phase: 2.2)
      working.shimmerPhase = 0
      working.time = 0

      if !shimmer {
        working.motion.shimmer = 0
      }

      let layers = VoiceOrbLayers(style: .light, frame: working, reduceMotion: false, size: size)
      return try #require(Pixels(layers.frame(width: canvas, height: canvas).background(Color.black)))
    }

    let on = try render(shimmer: true)
    let off = try render(shimmer: false)
    on.save("orb-light-thinking-shimmer-on")
    off.save("orb-light-thinking-shimmer-off")

    func at(_ pixels: Pixels, radius: Double, degrees: Double) -> Int {
      let scale = Double(pixels.scale)
      let x = Double(pixels.width) / 2 + radius * scale * cos(degrees * .pi / 180)
      let y = Double(pixels.height) / 2 - radius * scale * sin(degrees * .pi / 180)
      return pixels.light(Int(x.rounded()), Int(y.rounded()))
    }

    // Just outside the rim, at 1:30, at 3 o'clock on either side of the seam, and all the way round:
    // the shimmer adds nothing there.
    let angles: [Double] = [45, 3, 0.5, -0.5, -3] + stride(from: 0.0, to: 360, by: 15).map { $0 }

    for degrees in angles {
      for gap in [1.5, 2.5, 4.0] {
        let radius = rimOuter + gap
        let difference = abs(at(on, radius: radius, degrees: degrees) - at(off, radius: radius, degrees: degrees))
        #expect(difference <= 2, "outside the ring at \(degrees) degrees, \(gap) pt out: the shimmer adds \(difference)")
      }
    }

    // Across the seam the shimmer is the same on both sides: no hard straight edge.
    for radius in stride(from: core * 0.85, through: core * 1.2, by: core * 0.1) {
      let above = at(on, radius: radius, degrees: 1.5) - at(off, radius: radius, degrees: 1.5)
      let below = at(on, radius: radius, degrees: -1.5) - at(off, radius: radius, degrees: -1.5)
      #expect(abs(above - below) <= 12, "no step across the seam at radius \(radius): \(above) vs \(below)")
    }

    // And it does paint on the ring: this is not an empty difference.
    var most = 0

    for degrees in stride(from: 0.0, to: 360, by: 5) {
      for radius in [core * 1.1, core * 1.2] {
        most = max(most, abs(at(on, radius: radius, degrees: degrees) - at(off, radius: radius, degrees: degrees)))
      }
    }

    #expect(most > 15, "the shimmer is there on the ring: \(most)")
  }

  // MARK: The settings glyph

  /// The status bar and the clock's area, in points, on an iPhone with a Dynamic Island.
  private static let statusBar = 59

  /// The panel as the host puts it: in an overlay of a view that has the system's insets.
  private func screen(_ panel: some View) -> some View {
    ZStack {
      Color.black
      Color.clear
        .overlay { panel }
        .safeAreaPadding(.top, CGFloat(Self.statusBar))
        .safeAreaPadding(.bottom, 34)
    }
    .frame(width: 375, height: 812)
  }

  @Test func theSettingsGlyphSitsBelowTheStatusBarOnTheFullScreenCall() async throws {
    for orb in [VoiceOrbStyle.light, .clouds] {
      let call = Call()
      await call.speaking(Self.reply, orb: orb)

      let pixels = try #require(Pixels(screen(call.panel(compact: false))))
      let top = Self.statusBar * pixels.scale
      let width = pixels.width

      // Nothing of the screen but black in the status bar's area (the clock, the battery live there).
      #expect(pixels.maxLight(x: 0...(width - 1), y: 0...(top - 1)) == 0, "\(orb): the status bar's area is empty")

      // The glyph is there, top right, below it.
      let glyph = pixels.maxLight(x: (width - 70 * pixels.scale)...(width - 1), y: top...(top + 64 * pixels.scale))
      #expect(glyph > 80, "\(orb): the settings glyph is inside the safe area, top trailing: \(glyph)")
      pixels.save("screen-iphone-375x812-\(orb.rawValue)-long-reply")
    }
  }

  @Test func theHarnessWouldHaveCaughtTheGlyphOnTheBatteryBefore() async throws {
    // The control: with the safe area ignored (the host did that on the iPhone), the same screen puts the
    // glyph in the status bar's area. If this stops being so, the test above proves nothing.
    let call = Call()
    await call.speaking(Self.reply)

    let view = screen(call.panel(compact: false).ignoresSafeArea())
    let pixels = try #require(Pixels(view))
    let top = Self.statusBar * pixels.scale
    let width = pixels.width

    #expect(pixels.maxLight(x: (width - 70 * pixels.scale)...(width - 1), y: 0...(top - 1)) > 80)
    pixels.save("screen-iphone-375x812-CONTROL-ignoring-the-safe-area-glyph-on-status-bar")
  }

  @Test func theMacPanelDrawsInItsOwnBounds() async throws {
    for orb in [VoiceOrbStyle.light, .clouds] {
      let call = Call()
      await call.speaking(Self.reply, orb: orb)

      let view = call.panel(compact: true).frame(width: 440, height: 600)
      let pixels = try #require(Pixels(view))

      // The panel is 380 x 540, centred: its glyph is inside it, top right, and not at its edge.
      let panelRight = (440 + 380) / 2 * pixels.scale
      let panelTop = (600 - 540) / 2 * pixels.scale
      let glyph = pixels.maxLight(
        x: (panelRight - 70 * pixels.scale)...(panelRight - 1), y: panelTop...(panelTop + 64 * pixels.scale))
      #expect(glyph > 80, "\(orb)")
      pixels.save("screen-mac-panel-440x600-\(orb.rawValue)-long-reply")
    }
  }

  // MARK: The caption

  private static let reply =
    "Ik heb het gecontroleerd en de domeinen zijn nu allemaal gekoppeld aan de nieuwe server, "
    + "de certificaten zijn vernieuwd en de oude records zijn opgeruimd zodat de verwijzingen "
    + "kloppen, dus alles loopt via de nieuwe machine en de oude draait niet meer, wat betekent dat "
    + "de overstap is afgerond en dat de websites van de domeinen inmiddels actief is."

  private func caption(_ text: String) -> some View {
    VoiceCaptionText(text: text)
      .font(.callout)
      .foregroundStyle(.white)
      .multilineTextAlignment(.center)
      .padding(.horizontal, 28)
      .frame(width: 375)
      .background(Color.black)
  }

  @Test func theCaptionIsThreeLinesTallWhateverTheTextAndShowsItsEnd() throws {
    let short = try #require(Pixels(caption("Hi.")))
    let three = try #require(Pixels(caption("Eén twee drie vier vijf zes zeven acht negen tien elf twaalf dertien veertien vijftien zestien zeventien achttien.")))
    let long = try #require(Pixels(caption(Self.reply)))
    let longer = try #require(Pixels(caption(Self.reply + " " + Self.reply)))

    #expect(short.height == long.height, "the box is three lines, however much is said: it does not jump")
    #expect(three.height == long.height)
    #expect(longer.height == long.height)

    // The newest words are at the bottom, bright; the top line has faded.
    let band = long.height / 3
    let bottom = long.maxLight(x: 0...(long.width - 1), y: (long.height - band)...(long.height - 1))
    let topRow = long.maxLight(x: 0...(long.width - 1), y: 0...(band / 4))
    #expect(bottom > 200, "the last line is drawn at full strength: \(bottom)")
    #expect(topRow < bottom * 6 / 10, "the oldest visible line fades out: \(topRow) vs \(bottom)")

    // Text that fits shows from the top and is not faded at all.
    let shortTop = short.maxLight(x: 0...(short.width - 1), y: 0...(band - 1))
    #expect(shortTop > 200)
    let threeTop = three.maxLight(x: 0...(three.width - 1), y: 0...(band - 1))
    #expect(threeTop > 200, "three lines that fit are not faded")

    short.save("caption-short")
    three.save("caption-three-lines")
    long.save("caption-long-tail")
    longer.save("caption-longer-tail")
  }

  @Test func theCaptionCarriesTheFullTextForVoiceOver() async {
    let call = Call()
    await call.speaking(Self.reply)

    #expect(VoiceModeView.caption(call.model) == Self.reply, "nothing is cut from the words: the screen only clips what it shows")
    #expect(VoiceCaptionText.maxLines == 3)
  }
}
