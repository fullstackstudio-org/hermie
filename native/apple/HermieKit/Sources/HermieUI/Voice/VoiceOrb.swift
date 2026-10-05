import HermieCore
import SwiftUI

/**
 What the orb does in a mode, as plain numbers: how fast it swirls, how far it swells, how bright the
 rim is, how much it is dimmed. The numbers for a mode are a pure function (`target`), so the mapping
 from mode, busy and level to motion is tested without drawing a frame; the painters only read them.

 Everything that depends on the level is (nearly) linear in it, which lets the driver ease the mode's
 own numbers (slowly: a mode change is a glide) and add the level on top (quickly: a syllable is a beat).
 */
struct VoiceOrbMotion: Equatable, Sendable {
  /// Radians a second the clouds, rings and sparkles drift.
  var swirl: Double
  /// 1 is the orb at rest; the level swells it.
  var scale: Double
  /// 0...1: how bright the glow around the rim is.
  var glow: Double
  /// 0...1: how strong the shimmer that travels round the rim is.
  var shimmer: Double
  /// How far the rings wave, as a share of their radius.
  var ripple: Double
  /// 0...1: how many sparkles show.
  var sparkle: Double
  /// How far the idle breathing swells the orb, as a share of its size.
  var breath: Double
  /// 1 is full brightness; a muted orb is dimmed.
  var brightness: Double
  /// How far the opacity pulses (the whole orb breathes in opacity, the way Reduce Motion asks for).
  var pulse: Double

  /// The swirl of an orb that is working (thinking, or busy in any mode): clearly faster than any
  /// other mode's.
  static let workingSwirl = 1.8

  /// Where the orb heads for `mode`, with `level` (0...1) of the voice it follows. Only listening and
  /// speaking follow the level.
  static func target(mode: VoiceOrbMode, busy: Bool, level: Double, reduceMotion: Bool) -> VoiceOrbMotion {
    let clamped = min(1, max(0, level.isFinite ? level : 0))
    let working = busy || mode == .thinking
    let follows = mode == .listening || mode == .speaking
    let lv = follows ? clamped : 0

    var motion: VoiceOrbMotion

    switch mode {
    case .idle:
      motion = VoiceOrbMotion(
        swirl: 0.35, scale: 1, glow: 0.35, shimmer: 0, ripple: 0.02, sparkle: 0.5, breath: 0.025,
        brightness: 1, pulse: 0)
    case .listening:
      motion = VoiceOrbMotion(
        swirl: 0.6 + 0.9 * lv, scale: 1 + 0.18 * lv, glow: 0.45 + 0.45 * lv, shimmer: 0,
        ripple: 0.02 + 0.07 * lv, sparkle: 0.6 + 0.4 * lv, breath: 0.012, brightness: 1, pulse: 0)
    case .speaking:
      motion = VoiceOrbMotion(
        swirl: 0.7 + 0.8 * lv, scale: 1 + 0.12 * lv, glow: 0.45 + 0.4 * lv, shimmer: 0,
        ripple: 0.02 + 0.06 * lv, sparkle: 0.6 + 0.4 * lv, breath: 0.012, brightness: 1, pulse: 0)
    case .thinking:
      motion = VoiceOrbMotion(
        swirl: workingSwirl, scale: 1, glow: 0.8, shimmer: 1, ripple: 0.035, sparkle: 0.9, breath: 0.015,
        brightness: 1, pulse: 0)
    case .muted:
      motion = VoiceOrbMotion(
        swirl: 0.12, scale: 0.95, glow: 0.1, shimmer: 0, ripple: 0.006, sparkle: 0.15, breath: 0.01,
        brightness: 0.45, pulse: 0)
    }

    if working {
      motion.swirl = max(motion.swirl, workingSwirl)
      motion.glow = max(motion.glow, 0.8)
      motion.shimmer = mode == .muted ? 0.5 : 1
      motion.sparkle = max(motion.sparkle, 0.9)
    }

    if reduceMotion {
      // No swirling, no particles, no swelling: a static picture whose opacity pulses gently (more
      // when the orb is working), and whose brightness moves a little with the voice.
      motion.swirl = 0
      motion.scale = 1
      motion.shimmer = 0
      motion.ripple = 0
      motion.sparkle = 0
      motion.breath = 0
      motion.brightness = mode == .muted ? 0.45 : 0.88 + 0.12 * lv
      motion.pulse = working ? 0.2 : (mode == .muted ? 0.03 : 0.08)
    }

    return motion
  }

  /// `self` moved `amount` (0...1) of the way to `other`.
  func mixed(to other: VoiceOrbMotion, amount: Double) -> VoiceOrbMotion {
    let t = min(1, max(0, amount))

    func mix(_ from: Double, _ to: Double) -> Double { from + (to - from) * t }

    return VoiceOrbMotion(
      swirl: mix(swirl, other.swirl), scale: mix(scale, other.scale), glow: mix(glow, other.glow),
      shimmer: mix(shimmer, other.shimmer), ripple: mix(ripple, other.ripple),
      sparkle: mix(sparkle, other.sparkle), breath: mix(breath, other.breath),
      brightness: mix(brightness, other.brightness), pulse: mix(pulse, other.pulse))
  }
}

/// Everything a painter needs for one frame.
struct VoiceOrbFrame: Sendable, Equatable {
  /// How often the idle breathing swells and settles, a second.
  static let breathHertz = 0.22

  var motion: VoiceOrbMotion
  /// The smoothed level, 0...1.
  var level: Double
  /// The clouds' and rings' phase: it advances by the swirl, so a faster swirl never jumps.
  var swirlPhase: Double
  /// The shimmer's angle round the rim, in radians.
  var shimmerPhase: Double
  /// Seconds, for the things that run on their own (twinkling, breathing).
  var time: Double

  /// The orb's size now: its scale, and the slow breathing on top.
  var effectiveScale: Double {
    motion.scale * (1 + motion.breath * sin(time * 2 * .pi * VoiceOrbFrame.breathHertz))
  }

  /// The opacity: brightness, and a slow pulse of it.
  var opacity: Double {
    let wave = 0.5 + 0.5 * sin(time * 2 * .pi * 0.5)
    return min(1, max(0, motion.brightness * (1 - motion.pulse * (1 - wave))))
  }
}

/**
 The orb's state between frames: the smoothed level, the eased motion, the phases. A reference type so
 a frame advances it without writing to the view's state (and so invalidating the view) sixty times a
 second.
 */
@MainActor
final class VoiceOrbDriver {
  /// Seconds for a change of mode to cover about two thirds of its way.
  static let settleSeconds = 0.3

  private var smoother = VoiceLevelSmoother()
  private var base: VoiceOrbMotion?
  private var full: VoiceOrbMotion?
  private var last: Double?
  private var swirlPhase = 0.0
  private var shimmerPhase = 0.0

  /// The frame at `time` (seconds, any origin that only grows). `rawLevel` is the meter's own number.
  func frame(
    at time: Double, mode: VoiceOrbMode, busy: Bool, rawLevel: Double, reduceMotion: Bool
  ) -> VoiceOrbFrame {
    let elapsed = last.map { max(0, time - $0) } ?? 0
    last = time

    let follows = mode == .listening || mode == .speaking
    let level = smoother.step(toward: follows ? rawLevel : 0, elapsed: elapsed)

    let baseTarget = VoiceOrbMotion.target(mode: mode, busy: busy, level: 0, reduceMotion: reduceMotion)
    let fullTarget = VoiceOrbMotion.target(mode: mode, busy: busy, level: 1, reduceMotion: reduceMotion)
    let share = 1 - exp(-min(1, elapsed) / Self.settleSeconds)

    let easedBase = (base ?? baseTarget).mixed(to: baseTarget, amount: base == nil ? 1 : share)
    let easedFull = (full ?? fullTarget).mixed(to: fullTarget, amount: full == nil ? 1 : share)
    base = easedBase
    full = easedFull

    let motion = easedBase.mixed(to: easedFull, amount: level)

    let step = min(elapsed, 0.1)
    swirlPhase += motion.swirl * step
    shimmerPhase += (0.9 + 2.2 * motion.shimmer) * motion.shimmer * step

    return VoiceOrbFrame(
      motion: motion, level: level, swirlPhase: swirlPhase, shimmerPhase: shimmerPhase, time: time)
  }
}

/**
 The call screen's orb, in one of two looks:

 - **Clouds**: a sphere of soft white and blue clouds that drift and swirl inside it.
 - **Light**: a glowing white core with an iridescent rim, ringed by slowly waving outlines and a few
   drifting sparkles.

 It is drawn by one `TimelineView` that stops when the orb is off screen or the app is not in front, so
 it costs nothing then. `level` is the raw meter (the microphone while listening, the speaker while
 speaking); the orb smooths it by the real time between frames. Decorative: the call screen says what
 is happening in words.
 */
struct VoiceOrb: View {
  let style: VoiceOrbStyle
  let mode: VoiceOrbMode
  let busy: Bool
  let level: @MainActor () -> Double
  let size: CGFloat

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase

  @State private var visible = false
  @State private var driver = VoiceOrbDriver()

  init(
    style: VoiceOrbStyle, mode: VoiceOrbMode, busy: Bool, level: @escaping @MainActor () -> Double,
    size: CGFloat = 250
  ) {
    self.style = style
    self.mode = mode
    self.busy = busy
    self.level = level
    self.size = size
  }

  var body: some View {
    let paused = !visible || scenePhase != .active

    Color.clear
      .frame(width: size, height: size)
      .overlay {
        TimelineView(.animation(minimumInterval: reduceMotion ? 1.0 / 15 : nil, paused: paused)) { timeline in
          let follows = mode == .listening || mode == .speaking
          let frame = driver.frame(
            at: timeline.date.timeIntervalSinceReferenceDate, mode: mode, busy: busy,
            rawLevel: follows ? level() : 0, reduceMotion: reduceMotion)

          VoiceOrbLayers(style: style, frame: frame, reduceMotion: reduceMotion, size: size)
        }
      }
      .onAppear { visible = true }
      .onDisappear { visible = false }
      .accessibilityHidden(true)
  }
}

/**
 One frame of the orb, as it is put on the screen: the layers of the chosen look on a canvas
 `VoiceOrbPainter.bleed` times the orb's frame, centred on it, and faded to nothing at the canvas's rim.
 None of it paints a background, and it never takes a touch.
 */
struct VoiceOrbLayers: View {
  let style: VoiceOrbStyle
  let frame: VoiceOrbFrame
  let reduceMotion: Bool
  /// The orb's frame; the canvas is bigger than this and overflows it on every side.
  let size: CGFloat

  var body: some View {
    let canvas = VoiceOrbPainter.canvasSide(for: size)

    Group {
      switch style {
      case .clouds:
        CloudsOrbView(frame: frame, reduceMotion: reduceMotion, size: size)
      case .light:
        LightOrbView(frame: frame, size: size)
      }
    }
    .frame(width: canvas, height: canvas)
    .mask { Rectangle().fill(VoiceOrbPainter.rimFade(side: canvas)) }
    .allowsHitTesting(false)
  }
}

// MARK: The clouds

struct CloudsOrbView: View {
  let frame: VoiceOrbFrame
  let reduceMotion: Bool
  /// The orb's frame; the layers are drawn on a canvas `VoiceOrbPainter.bleed` times it, and paint no
  /// background of their own.
  let size: CGFloat

  var body: some View {
    let diameter = size * VoiceOrbPainter.sphereShare
    let side = VoiceOrbPainter.canvasSide(for: size)

    ZStack {
      Canvas(opaque: false) { context, canvas in
        VoiceOrbPainter.drawCloudHalo(&context, size: canvas, frame: frame)
      }

      MeshGradient(
        width: 3, height: 3,
        points: VoiceOrbPainter.meshPoints(phase: frame.swirlPhase, amount: reduceMotion ? 0 : 1),
        colors: VoiceOrbPainter.meshColors
      )
      .frame(width: diameter, height: diameter)
      .clipShape(Circle())

      Canvas(opaque: false) { context, canvas in
        VoiceOrbPainter.drawClouds(&context, size: canvas, frame: frame)
      }
    }
    .frame(width: side, height: side)
    .scaleEffect(frame.effectiveScale)
    .opacity(frame.opacity)
  }
}

// MARK: The light

struct LightOrbView: View {
  let frame: VoiceOrbFrame
  /// The orb's frame; drawn on a canvas `VoiceOrbPainter.bleed` times it, with no background.
  let size: CGFloat

  var body: some View {
    let side = VoiceOrbPainter.canvasSide(for: size)

    Canvas(opaque: false) { context, canvas in
      VoiceOrbPainter.drawLight(&context, size: canvas, frame: frame)
    }
    .frame(width: side, height: side)
    .opacity(frame.opacity)
  }
}

/// The drawing, as plain functions of a frame: no view tree is built per frame, only paths and shadings.
enum VoiceOrbPainter {
  /// The sphere's diameter as a share of the orb's square: the rest is its glow.
  static let sphereShare: CGFloat = 0.8

  /// The farthest any painter reaches from the centre, as a share of the orb's frame and before the
  /// swell: the clouds' halo (0.512), the light's outermost ring at full ripple (`maxRingExtent`,
  /// about 0.54), its sparkles (about 0.49) and its glow (0.52). The canvas is sized for this.
  static let reach: CGFloat = 0.56
  /// The largest `VoiceOrbFrame.effectiveScale` any mode reaches: listening at full level (1.18) with
  /// the breathing on top.
  static let maxScale: CGFloat = 1.2

  /// The drawing is laid out on a canvas this many times the orb's frame, centred on it, so that
  /// nothing the orb paints (the rings at full swell, the glow, the sparkles) is ever cut at the
  /// frame's edge. The canvas takes no room: it is an overlay.
  static let bleed: CGFloat = 1.8
  /// Where, as a share of the canvas's half-width, the fade to nothing starts. Everything the painters
  /// draw lies inside this (`VoiceOrbPainter.reach` at the full swell), so the fade is a safety net: an
  /// edge cannot show, whatever a painter does.
  static let fadeStart: CGFloat = 0.8

  /// How far from the centre, as a share of the orb's frame, the painted pixels can reach: the largest
  /// extent of any painter (`VoiceOrbPainter.reach`) at the largest swell.
  static var paintedReach: CGFloat { reach * maxScale }

  /// The side of the canvas the orb is drawn on.
  static func canvasSide(for size: CGFloat) -> CGFloat { size * bleed }

  /// The fade at the rim of a canvas `side` points across: opaque inside `fadeStart`, nothing at the edge.
  static func rimFade(side: CGFloat) -> RadialGradient {
    RadialGradient(
      stops: [
        .init(color: .black, location: 0),
        .init(color: .black, location: fadeStart),
        .init(color: .clear, location: 1)
      ],
      center: .center, startRadius: 0, endRadius: side / 2)
  }

  /// The clouds' halo reaches this many times the sphere's radius.
  static let cloudHaloFactor: CGFloat = 1.28
  /// The light's core, as a share of the orb's side, and how many times its radius the glow reaches.
  static let coreShare: CGFloat = 0.2
  static let glowFactor: CGFloat = 2.6
  /// The sparkles drift from `sparkleInner` outward by `sparkleSpan`, as shares of the orb's side.
  static let sparkleInner: Double = 0.14
  static let sparkleSpan: Double = 0.34

  /// The farthest each painter reaches at rest, as a share of the orb's side (the sparkles are
  /// points, so they add their size, a few points, on top).
  static var cloudHaloReach: CGFloat { sphereShare / 2 * cloudHaloFactor }
  static var lightGlowReach: CGFloat { coreShare * glowFactor }
  static var sparkleReach: Double { sparkleInner + sparkleSpan }

  /// The orb's own side, in a canvas that is `VoiceOrbPainter.bleed` times it.
  static func orbSide(in canvas: CGSize) -> CGFloat { min(canvas.width, canvas.height) / VoiceOrbPainter.bleed }

  /// The ring `ring`'s radius at rest, as a share of the orb's side.
  static func ringBase(_ ring: Int) -> Double { 0.27 + 0.055 * Double(ring) }

  /// How far the ring `ring` waves, as a share of the orb's side, at this ripple.
  static func ringAmplitude(_ ring: Int, ripple: Double) -> Double {
    ringBase(ring) * (0.035 + ripple * (1 + 0.4 * Double(ring)))
  }

  /// The farthest any of the rings gets from the centre at this ripple (the wave is within -1...1).
  static func maxRingExtent(ripple: Double) -> Double {
    (0..<petals.count).map { ringBase($0) + ringAmplitude($0, ripple: ripple) }.max() ?? 0
  }

  // MARK: Palette

  static let skyBlue = Color(red: 0.62, green: 0.82, blue: 1.0)
  static let blue = Color(red: 0.2, green: 0.5, blue: 1.0)
  static let deepBlue = Color(red: 0.1, green: 0.3, blue: 0.85)

  static let meshColors: [Color] = [
    Color(red: 0.85, green: 0.93, blue: 1.0), .white, Color(red: 0.6, green: 0.8, blue: 1.0),
    Color(red: 0.3, green: 0.55, blue: 1.0), Color(red: 0.92, green: 0.96, blue: 1.0),
    Color(red: 0.55, green: 0.78, blue: 1.0),
    Color(red: 0.18, green: 0.4, blue: 0.95), Color(red: 0.5, green: 0.75, blue: 1.0), .white
  ]

  /// The rainbow that edges the light's core and rings; the last stop is the first, so it closes.
  static let rainbow = Gradient(colors: [
    Color(hue: 0.0, saturation: 0.45, brightness: 1), Color(hue: 0.12, saturation: 0.5, brightness: 1),
    Color(hue: 0.3, saturation: 0.45, brightness: 1), Color(hue: 0.5, saturation: 0.5, brightness: 1),
    Color(hue: 0.65, saturation: 0.5, brightness: 1), Color(hue: 0.82, saturation: 0.45, brightness: 1),
    Color(hue: 0.0, saturation: 0.45, brightness: 1)
  ])

  /// A comet: nothing, then a tail that brightens to a head, which rounds off over the last stretch.
  /// (A conic gradient has its seam at the angle it starts from: if the head ran straight into it, the
  /// seam would be a hard, straight edge across the ring.)
  static let comet = Gradient(stops: [
    .init(color: .white.opacity(0), location: 0),
    .init(color: .white.opacity(0), location: 0.55),
    .init(color: .white.opacity(0.95), location: 0.94),
    .init(color: .white.opacity(0), location: 1)
  ])

  /// The width of the light orb's rainbow rim, as a share of its core's radius. Nothing laid over the
  /// rim (the shimmer) is wider than it, or it would stick out past the ring.
  static let rimWidth: CGFloat = 0.5

  // MARK: Clouds

  /// A nine-point mesh whose edge and middle points wander with the phase; corners stay put.
  static func meshPoints(phase: Double, amount: Double) -> [SIMD2<Float>] {
    func point(_ x: Double, _ y: Double) -> SIMD2<Float> { SIMD2(Float(x), Float(y)) }

    let a = phase * 0.5
    let b = phase * 0.37
    let edge = 0.12 * amount
    let middle = 0.2 * amount

    return [
      point(0, 0), point(0.5 + edge * sin(a), 0), point(1, 0),
      point(0, 0.5 + edge * cos(b)), point(0.5 + middle * cos(a * 1.3), 0.5 + middle * sin(b * 1.7)),
      point(1, 0.5 + edge * sin(b + 1)),
      point(0, 1), point(0.5 + edge * cos(a + 2), 1), point(1, 1)
    ]
  }

  private struct Blob {
    var angle: Double
    var orbit: Double
    var size: Double
    var speed: Double
    var squash: Double
    var alpha: Double
    var tint: Int
  }

  private static let blobs: [Blob] = [
    Blob(angle: 0.0, orbit: 0.45, size: 0.55, speed: 1.0, squash: 0.8, alpha: 0.85, tint: 0),
    Blob(angle: 1.1, orbit: 0.55, size: 0.45, speed: -0.8, squash: 1.0, alpha: 0.7, tint: 1),
    Blob(angle: 2.3, orbit: 0.35, size: 0.6, speed: 0.7, squash: 0.9, alpha: 0.8, tint: 0),
    Blob(angle: 3.4, orbit: 0.6, size: 0.4, speed: -1.1, squash: 0.7, alpha: 0.6, tint: 2),
    Blob(angle: 4.2, orbit: 0.4, size: 0.5, speed: 0.9, squash: 1.0, alpha: 0.75, tint: 0),
    Blob(angle: 5.1, orbit: 0.5, size: 0.5, speed: -0.6, squash: 0.8, alpha: 0.65, tint: 1),
    Blob(angle: 0.6, orbit: 0.15, size: 0.45, speed: 1.3, squash: 1.0, alpha: 0.7, tint: 0),
    Blob(angle: 2.9, orbit: 0.2, size: 0.35, speed: -1.4, squash: 0.9, alpha: 0.55, tint: 2),
    Blob(angle: 4.8, orbit: 0.65, size: 0.35, speed: 0.5, squash: 0.8, alpha: 0.5, tint: 0)
  ]

  /// The glow around the sphere.
  static func drawCloudHalo(_ context: inout GraphicsContext, size: CGSize, frame: VoiceOrbFrame) {
    let side = orbSide(in: size)
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    let radius = side * sphereShare / 2
    let reach = radius * cloudHaloFactor
    let strength = 0.15 + 0.45 * frame.motion.glow

    context.fill(
      Path(ellipseIn: CGRect(x: center.x - reach, y: center.y - reach, width: reach * 2, height: reach * 2)),
      with: .radialGradient(
        Gradient(stops: [
          .init(color: blue.opacity(0), location: 0),
          .init(color: blue.opacity(0), location: 0.7),
          .init(color: skyBlue.opacity(strength), location: 0.78),
          .init(color: blue.opacity(0), location: 1)
        ]),
        center: center, startRadius: 0, endRadius: reach))
  }

  /// The clouds, the light on the sphere, its rim and the shimmer that circles it.
  static func drawClouds(_ context: inout GraphicsContext, size: CGSize, frame: VoiceOrbFrame) {
    let side = orbSide(in: size)
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    let radius = side * sphereShare / 2
    let sphere = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    let motion = frame.motion

    var inner = context
    inner.clip(to: Path(ellipseIn: sphere))

    let swell = 1 + 0.15 * frame.level

    for (index, blob) in blobs.enumerated() {
      let seed = Double(index)
      let angle = blob.angle + frame.swirlPhase * blob.speed * 0.5
      let wander = 1 + 0.18 * sin(frame.swirlPhase * 0.6 * abs(blob.speed) + seed)
      let orbit = radius * blob.orbit * swell * wander
      let spot = CGPoint(
        x: center.x + cos(angle) * orbit, y: center.y + sin(angle) * orbit * blob.squash)
      let reach = radius * blob.size * (1 + 0.12 * sin(frame.swirlPhase * 0.8 + seed * 1.7))
      let colour: Color = blob.tint == 0 ? .white : (blob.tint == 1 ? skyBlue : blue)
      let box = CGRect(x: spot.x - reach, y: spot.y - reach * 0.8, width: reach * 2, height: reach * 1.6)

      inner.opacity = min(1, blob.alpha + 0.12 * frame.level)
      inner.fill(
        Path(ellipseIn: box),
        with: .radialGradient(
          Gradient(colors: [colour.opacity(0.95), colour.opacity(0)]),
          center: spot, startRadius: 0, endRadius: reach))
    }

    inner.opacity = 1

    // The light on the sphere: a highlight high on the left, and its edge a little darker.
    inner.fill(
      Path(sphere),
      with: .radialGradient(
        Gradient(colors: [.white.opacity(0.4), .white.opacity(0)]),
        center: CGPoint(x: center.x - radius * 0.35, y: center.y - radius * 0.42), startRadius: 0,
        endRadius: radius))
    inner.fill(
      Path(sphere),
      with: .radialGradient(
        Gradient(colors: [deepBlue.opacity(0), deepBlue.opacity(0.32)]),
        center: center, startRadius: radius * 0.62, endRadius: radius))

    context.stroke(
      Path(ellipseIn: sphere), with: .color(.white.opacity(0.3 + 0.4 * motion.glow)), lineWidth: 1.5)

    if motion.shimmer > 0.01 {
      var ring = context
      let sweep = GraphicsContext.Shading.conicGradient(
        comet, center: center, angle: .radians(frame.shimmerPhase))
      let outer = sphere.insetBy(dx: -side * 0.01, dy: -side * 0.01)

      ring.opacity = 0.35 * motion.shimmer
      ring.stroke(Path(ellipseIn: outer), with: sweep, lineWidth: side * 0.09)
      ring.opacity = motion.shimmer
      ring.stroke(Path(ellipseIn: sphere), with: sweep, lineWidth: side * 0.03)
    }
  }

  // MARK: Light

  private struct Sparkle {
    var angle: Double
    var distance: Double
    var speed: Double
    var size: Double
    var twinkle: Double
    var phase: Double
  }

  /// A fixed scatter, from a small linear generator: the same sparkles on every frame and every run.
  private static let sparkles: [Sparkle] = {
    var state: UInt64 = 0x9E37_79B9
    func next() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double((state >> 33) & 0xFFFF) / 65_536
    }

    return (0..<28).map { _ in
      Sparkle(
        angle: next() * 2 * .pi, distance: next(), speed: 0.4 + next(), size: 0.8 + next() * 1.6,
        twinkle: 1.5 + next() * 2.5, phase: next() * 2 * .pi)
    }
  }()

  /// The petals on each ring.
  private static let petals: [Double] = [5, 6, 7, 8]

  static func drawLight(_ context: inout GraphicsContext, size: CGSize, frame: VoiceOrbFrame) {
    let side = orbSide(in: size)
    let center = CGPoint(x: size.width / 2, y: size.height / 2)
    let motion = frame.motion
    let core = side * coreShare

    var canvas = context
    canvas.translateBy(x: center.x, y: center.y)
    canvas.scaleBy(x: frame.effectiveScale, y: frame.effectiveScale)

    let origin = CGPoint.zero
    let rainbowAngle = Angle.radians(frame.swirlPhase * 0.4)

    // The rings: outlines with petals that wave, each at its own speed and direction.
    for ring in 0..<petals.count {
      let index = Double(ring)
      let base = side * ringBase(ring)
      let amplitude = side * ringAmplitude(ring, ripple: motion.ripple)
      let phase = frame.swirlPhase * (0.5 + 0.2 * index) * (ring % 2 == 0 ? 1 : -1)
      let count = petals[ring]
      let segments = 96
      var path = Path()

      for step in 0...segments {
        let theta = Double(step) / Double(segments) * 2 * .pi
        let wave = (sin(count * theta + phase) + 0.5 * sin((count + 2) * theta - phase * 1.3)) / 1.5
        let radius = base + amplitude * wave
        let point = CGPoint(x: cos(theta) * radius, y: sin(theta) * radius)

        if step == 0 {
          path.move(to: point)
        } else {
          path.addLine(to: point)
        }
      }

      path.closeSubpath()

      canvas.opacity = (0.55 - 0.1 * index) * (0.45 + 0.55 * motion.glow)
      canvas.stroke(
        path,
        with: .conicGradient(rainbow, center: origin, angle: rainbowAngle + .radians(index)),
        lineWidth: 1.3)
    }

    // The sparkles drift outward and fade at either end of the way, twinkling as they go.
    if motion.sparkle > 0.02 {
      for sparkle in sparkles {
        let travel = (sparkle.distance + frame.swirlPhase * 0.03 * sparkle.speed)
          .truncatingRemainder(dividingBy: 1)
        let fade = sin(travel * .pi)
        let twinkle = 0.4 + 0.6 * (0.5 + 0.5 * sin(frame.time * sparkle.twinkle + sparkle.phase))
        let angle = sparkle.angle + frame.swirlPhase * 0.05
        let distance = side * (sparkleInner + sparkleSpan * travel)
        let dot = sparkle.size
        let box = CGRect(
          x: cos(angle) * distance - dot / 2, y: sin(angle) * distance - dot / 2, width: dot, height: dot)

        canvas.opacity = fade * twinkle * motion.sparkle
        canvas.fill(Path(ellipseIn: box), with: .color(.white))
      }
    }

    canvas.opacity = 1

    // The core's glow, then the core, then its iridescent rim.
    let halo = core * glowFactor
    canvas.fill(
      Path(ellipseIn: CGRect(x: -halo, y: -halo, width: halo * 2, height: halo * 2)),
      with: .radialGradient(
        Gradient(colors: [.white.opacity(0.35 + 0.4 * motion.glow), .white.opacity(0)]),
        center: origin, startRadius: core * 0.4, endRadius: halo))

    let disc = CGRect(x: -core, y: -core, width: core * 2, height: core * 2)
    canvas.fill(
      Path(ellipseIn: disc),
      with: .radialGradient(
        Gradient(colors: [.white, .white.opacity(0.9)]), center: origin, startRadius: 0, endRadius: core))

    let rim = GraphicsContext.Shading.conicGradient(rainbow, center: origin, angle: rainbowAngle * 1.5)

    canvas.opacity = 0.3 + 0.2 * motion.glow
    canvas.stroke(Path(ellipseIn: disc), with: rim, lineWidth: core * rimWidth)
    canvas.opacity = 0.95
    canvas.stroke(Path(ellipseIn: disc), with: rim, lineWidth: core * 0.2)

    if motion.shimmer > 0.01 {
      let sweep = GraphicsContext.Shading.conicGradient(
        comet, center: origin, angle: .radians(frame.shimmerPhase))

      canvas.opacity = 0.4 * motion.shimmer
      canvas.stroke(Path(ellipseIn: disc), with: sweep, lineWidth: core * rimWidth)
      canvas.opacity = motion.shimmer
      canvas.stroke(Path(ellipseIn: disc), with: sweep, lineWidth: core * 0.16)
    }
  }
}
