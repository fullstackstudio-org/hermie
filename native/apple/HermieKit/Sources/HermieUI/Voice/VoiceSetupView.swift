import HermieCore
import Observation
import SwiftUI

/// Where the voice comes from. One today (the device's own synthesiser); a gateway's voices are added
/// here as another case, and the row's menu, its title and the model's source-specific parts follow.
enum VoiceSourceChoice: CaseIterable, Identifiable, Hashable {
  case device

  var id: Self { self }

  var title: String {
    switch self {
    case .device: NativeStrings.VoiceSetup.sourceDevice
    }
  }
}

/// The pure parts of the screen: which language to open on, which voices to show and in what order, what
/// the dots are called, the level the orb moves to while a sample plays. Plain functions, tested without a view.
enum VoiceSetupLogic {
  /// `nl-NL` → `nl`; `zh_Hans_CN` → `zh`.
  static func languageCode(_ tag: String) -> String {
    tag.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map { $0.lowercased() } ?? ""
  }

  /// Personal voices first, then the best quality, then by name: the order of the dots, so voice 1 is the
  /// one most worth choosing.
  static func ordered(_ voices: [SpeechVoice]) -> [SpeechVoice] {
    voices.sorted { left, right in
      if left.personal != right.personal {
        return left.personal
      }

      if left.quality != right.quality {
        return left.quality > right.quality
      }

      let order = left.name.localizedStandardCompare(right.name)

      return order == .orderedSame ? left.id < right.id : order == .orderedAscending
    }
  }

  /// The voices of one language tag, in dot order.
  static func voices(in tag: String?, from voices: [SpeechVoice]) -> [SpeechVoice] {
    guard let tag else {
      return []
    }

    return ordered(voices.filter { $0.language == tag })
  }

  /// The language the screen opens on: the chosen voice's, else the device's (its own tag, else any tag
  /// of its language, preferring the same region), else the first by name.
  static func defaultLanguage(voices: [SpeechVoice], chosenID: String?, deviceTag: String) -> String? {
    if let chosenID, let chosen = voices.first(where: { $0.id == chosenID }) {
      return chosen.language
    }

    let tags = VoiceLanguageChoice.choices(voices.map(\.language)).map(\.tag)

    guard !tags.isEmpty else {
      return nil
    }

    let device = deviceTag.replacingOccurrences(of: "_", with: "-")

    if let exact = tags.first(where: { $0.caseInsensitiveCompare(device) == .orderedSame }) {
      return exact
    }

    let code = languageCode(device)
    let sameLanguage = tags.filter { languageCode($0) == code }
    let region = device.split(separator: "-").last.map { $0.uppercased() }

    if let match = sameLanguage.first(where: { tag in tag.split(separator: "-").last.map { $0.uppercased() } == region }) {
      return match
    }

    return sameLanguage.first ?? tags.first
  }

  /// Every voice of the language is a basic one: better ones are a download in the system settings.
  static func onlyCompact(_ voices: [SpeechVoice]) -> Bool {
    !voices.isEmpty && voices.allSatisfy { $0.quality == .compact && !$0.personal }
  }

  /// "Voice 3, Ava, enhanced, selected".
  static func dotLabel(number: Int, voice: SpeechVoice, selected: Bool) -> String {
    var parts = [NativeStrings.VoiceSetup.voiceNumber(number), voice.name]

    parts.append(voice.personal ? NativeStrings.VoiceSetup.qualityPersonal : quality(voice.quality))

    if selected {
      parts.append(NativeStrings.VoiceSetup.selected)
    }

    return parts.joined(separator: ", ")
  }

  static func quality(_ quality: SpeechVoice.Quality) -> String {
    switch quality {
    case .compact: NativeStrings.VoiceSetup.qualityCompact
    case .enhanced: NativeStrings.VoiceSetup.qualityEnhanced
    case .premium: NativeStrings.VoiceSetup.qualityPremium
    }
  }

  /// A level for the orb while a sample plays: the speaker's real level is not known (the synthesiser
  /// is a black box), so a few slow sines that rise and fall like a sentence do.
  static func previewLevel(at time: Double) -> Double {
    let wave = 0.5 + 0.28 * sin(time * 7.3) + 0.14 * sin(time * 3.1 + 1) + 0.08 * sin(time * 12.9 + 2)
    return min(1, max(0, wave))
  }
}

/// The maths of the tick sliders: a fraction of the track and a value, with and without snapping to ticks.
enum VoiceSliderMath {
  /// The value at `fraction` (0...1) of the track, snapped to the nearest of `ticks` when `snap`.
  static func value(fraction: Double, range: ClosedRange<Double>, ticks: [Double], snap: Bool) -> Double {
    let share = min(1, max(0, fraction.isFinite ? fraction : 0))
    let raw = range.lowerBound + share * (range.upperBound - range.lowerBound)

    guard snap, !ticks.isEmpty else {
      return raw
    }

    return ticks.min { abs($0 - raw) < abs($1 - raw) } ?? raw
  }

  /// Where `value` sits on the track, 0...1.
  static func fraction(of value: Double, range: ClosedRange<Double>) -> Double {
    let span = range.upperBound - range.lowerBound

    guard span > 0 else {
      return 0
    }

    return min(1, max(0, (value - range.lowerBound) / span))
  }

  /// The value after VoiceOver's increment (+1) or decrement (-1): the next tick, or a tenth of the range.
  static func adjusted(value: Double, direction: Int, range: ClosedRange<Double>, ticks: [Double], snap: Bool) -> Double {
    if snap, !ticks.isEmpty {
      let sorted = ticks.sorted()
      let index = sorted.indices.min { abs(sorted[$0] - value) < abs(sorted[$1] - value) } ?? 0
      return sorted[min(sorted.count - 1, max(0, index + direction))]
    }

    let step = (range.upperBound - range.lowerBound) / 10
    return min(range.upperBound, max(range.lowerBound, value + Double(direction) * step))
  }
}

/**
 What the Voice screen knows and does, apart from how it looks: the voices, the language shown, whether
 a sample is playing. A reference type with an injected synthesiser, so the screen's rules run in tests
 with a fake speaker.
 */
@MainActor
@Observable
final class VoiceSetupModel {
  let settings: VoiceSettings
  let speaker: any SpeechSynthesizing

  private(set) var voices: [SpeechVoice] = []
  private(set) var access: PersonalVoiceAccess = .unsupported
  /// The language tag whose voices are shown.
  private(set) var language: String?
  private(set) var previewing = false
  var source: VoiceSourceChoice = .device

  @ObservationIgnored private let deviceTag: String
  @ObservationIgnored private let sample: String
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var loaded = false

  init(
    settings: VoiceSettings, speaker: any SpeechSynthesizing,
    deviceTag: String = Locale.preferredLanguages.first ?? Locale.current.identifier,
    sample: String = NativeStrings.VoiceSetup.sample
  ) {
    self.settings = settings
    self.speaker = speaker
    self.deviceTag = deviceTag
    self.sample = sample
  }

  /// Read the device's voices (once opens the screen on a language; again after Personal Voice changed).
  func load() {
    refresh()

    if !loaded {
      loaded = true
      language = VoiceSetupLogic.defaultLanguage(
        voices: voices, chosenID: settings.voiceIdentifier, deviceTag: deviceTag)
    }
  }

  private func refresh() {
    voices = speaker.voices()
    access = speaker.personalVoiceAccess()
  }

  var languages: [VoiceLanguageChoice] { VoiceLanguageChoice.choices(voices.map(\.language)) }

  var languageName: String { language.map { VoiceLanguageChoice.name(of: $0) } ?? NativeStrings.VoiceSetup.automatic }

  /// The dots, in order.
  var shown: [SpeechVoice] { VoiceSetupLogic.voices(in: language, from: voices) }

  var showsBetterVoicesHint: Bool { VoiceSetupLogic.onlyCompact(shown) }

  var selectedVoice: SpeechVoice? {
    settings.voiceIdentifier.flatMap { id in voices.first { $0.id == id } }
  }

  /// The name under the dots: the voice, "Automatic", or the voice with its language when it is in another.
  var caption: String {
    guard let voice = selectedVoice else {
      return NativeStrings.VoiceSetup.automatic
    }

    if voice.language == language {
      return voice.name
    }

    return "\(voice.name) · \(VoiceLanguageChoice.name(of: voice.language))"
  }

  func selectLanguage(_ tag: String) {
    language = tag
  }

  /// Choose a voice (nil is automatic), and say the sample in it.
  func select(_ id: String?) {
    settings.setVoiceIdentifier(id)
    preview()
  }

  /// Say the sample in the voice, pace and expressivity in force; whatever it was saying stops.
  func preview() {
    speaker.stop()
    generation += 1

    guard speaker.isAvailable else {
      previewing = false
      return
    }

    let current = generation
    let request = ReadRequest(
      id: "preview", text: sample, language: selectedVoice?.language ?? language,
      pitch: VoiceProsody.pitch(expressivity: settings.expressivity, sentence: 0))

    previewing = true
    speaker.speak(request, rate: settings.rate, voice: settings.voiceIdentifier) { [weak self] in
      guard let self, self.generation == current else {
        return
      }

      self.previewing = false
    }
  }

  func stop() {
    generation += 1
    previewing = false
    speaker.stop()
  }

  func requestPersonalVoice() async {
    access = await speaker.requestPersonalVoiceAccess()
    refresh()
  }
}

/**
 Hermie's Voice screen, in the manner of the system's "Customize Your Siri Voice": a black page, the orb
 in its light look above, and under it the choices: which voice, how fast, how lively, which orb. Picking
 a voice, or letting go of a slider, says a sentence in it, and the orb moves while it is said.

 Always dark, whatever the system's appearance is. Shown on first run before the first call (the button
 says "Continue") and from the settings (it says "Done").
 */
struct VoiceSetupView: View {
  let settings: VoiceSettings
  let firstRun: Bool
  let onDone: () -> Void

  @State private var model: VoiceSetupModel
  @State private var rateDraft: Double?
  @State private var expressivityDraft: Double?

  @ScaledMetric(relativeTo: .body) private var dotSize: CGFloat = 44

  init(settings: VoiceSettings, speaker: any SpeechSynthesizing, firstRun: Bool, onDone: @escaping () -> Void) {
    self.settings = settings
    self.firstRun = firstRun
    self.onDone = onDone
    _model = State(initialValue: VoiceSetupModel(settings: settings, speaker: speaker))
  }

  private static let accent = Color(red: 0.04, green: 0.52, blue: 1.0)
  private static let card = Color.white.opacity(0.09)
  private static let secondary = Color.white.opacity(0.62)

  var body: some View {
    ScrollView {
      VStack(spacing: 22) {
        orb

        VStack(spacing: 6) {
          Text(NativeStrings.VoiceSetup.title)
            .font(.title.bold())
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("hermie.voiceSetup.title")
          Text(NativeStrings.VoiceSetup.subtitle)
            .font(.subheadline)
            .foregroundStyle(Self.secondary)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("hermie.voiceSetup.subtitle")
        }

        voiceCard

        if model.access != .unsupported {
          personalCard
        }

        paceCard
        orbCard
        sourceCard
        doneButton
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 24)
      .frame(maxWidth: 560)
      .frame(maxWidth: .infinity)
    }
    .foregroundStyle(.white)
    .background(Color.black.ignoresSafeArea())
    // Dark here only: a preference would turn the whole window dark while the page is pushed in Settings.
    .environment(\.colorScheme, .dark)
    .onAppear { model.load() }
    .onDisappear { model.stop() }
    .accessibilityIdentifier("hermie.voiceSetup")
  }

  // MARK: The orb

  private var orb: some View {
    // Read through the model's own property: the closure runs every frame, and `previewing` is what
    // tells it whether there is anything to follow.
    let model = model

    return VoiceOrb(
      style: .light, mode: model.previewing ? .speaking : .idle, busy: false,
      level: {
        model.previewing ? VoiceSetupLogic.previewLevel(at: Date.timeIntervalSinceReferenceDate) : 0
      },
      size: 200
    )
    .padding(.top, 4)
  }

  // MARK: Voice

  private var voiceCard: some View {
    card {
      HStack {
        Text(NativeStrings.VoiceSetup.voice)
          .font(.body.weight(.semibold))

        Spacer(minLength: 12)

        Menu {
          ForEach(model.languages) { choice in
            Button {
              model.selectLanguage(choice.tag)
            } label: {
              if choice.tag == model.language {
                Label(choice.name, systemImage: "checkmark")
              } else {
                Text(choice.name)
              }
            }
          }
        } label: {
          HStack(spacing: 4) {
            Text(model.languageName)
              .multilineTextAlignment(.trailing)
            Image(systemName: "chevron.up.chevron.down")
              .font(.caption2.weight(.semibold))
              .accessibilityHidden(true)
          }
          .foregroundStyle(Self.secondary)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel(NativeStrings.VoiceSetup.language)
        .accessibilityValue(model.languageName)
        .accessibilityIdentifier("hermie.voiceSetup.language")
      }

      if model.shown.isEmpty {
        Text(NativeStrings.VoiceSetup.noVoices)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .accessibilityIdentifier("hermie.voiceSetup.noVoices")
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: dotSize + 10), spacing: 8)], spacing: 10) {
          ForEach(Array(model.shown.enumerated()), id: \.element.id) { offset, voice in
            dot(number: offset + 1, voice: voice)
          }
        }
        .padding(.vertical, 4)
      }

      HStack(spacing: 10) {
        automaticButton

        Text(model.caption)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .frame(maxWidth: .infinity, alignment: .trailing)
          .multilineTextAlignment(.trailing)
          .accessibilityIdentifier("hermie.voiceSetup.caption")
      }

      if model.showsBetterVoicesHint {
        Text(NativeStrings.VoiceSetup.betterVoices)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.voiceSetup.betterVoices")
      }
    }
  }

  private func dot(number: Int, voice: SpeechVoice) -> some View {
    let selected = voice.id == settings.voiceIdentifier
    let colour = Self.dotColours[(number - 1) % Self.dotColours.count]

    return Button {
      model.select(voice.id)
    } label: {
      ZStack {
        Circle()
          .fill(
            LinearGradient(
              colors: [colour.opacity(0.95), colour.opacity(0.6)], startPoint: .topLeading, endPoint: .bottomTrailing)
          )
          .frame(width: dotSize, height: dotSize)

        if selected {
          Circle()
            .strokeBorder(.white, lineWidth: 2.5)
            .frame(width: dotSize + 8, height: dotSize + 8)

          Text("\(number)")
            .font(.headline.monospacedDigit())
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.35), radius: 2)
        }
      }
      .frame(width: dotSize + 10, height: dotSize + 10)
      .overlay(alignment: .bottomTrailing) {
        if voice.personal {
          Image(systemName: "person.crop.circle.fill")
            .font(.caption)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.black, .white)
            .accessibilityHidden(true)
        }
      }
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(VoiceSetupLogic.dotLabel(number: number, voice: voice, selected: selected))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.voiceSetup.voice.\(number)")
  }

  private var automaticButton: some View {
    let selected = settings.voiceIdentifier == nil

    return Button {
      model.select(nil)
    } label: {
      Text(NativeStrings.VoiceSetup.automatic)
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .foregroundStyle(selected ? Color.black : Color.white)
        .background(Capsule().fill(selected ? Color.white : Color.white.opacity(0.14)))
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("hermie.voiceSetup.automatic")
  }

  /// One colour for each voice, by its place in the row.
  private static let dotColours: [Color] = [
    Color(red: 0.36, green: 0.55, blue: 1.0), Color(red: 0.62, green: 0.42, blue: 0.95),
    Color(red: 0.98, green: 0.4, blue: 0.62), Color(red: 1.0, green: 0.58, blue: 0.3),
    Color(red: 0.98, green: 0.8, blue: 0.3), Color(red: 0.4, green: 0.82, blue: 0.5),
    Color(red: 0.25, green: 0.78, blue: 0.78), Color(red: 0.5, green: 0.7, blue: 0.95)
  ]

  // MARK: Personal Voice

  private var personalCard: some View {
    card {
      VStack(alignment: .leading, spacing: 4) {
        Text(NativeStrings.VoiceSetup.personalTitle)
          .font(.body.weight(.semibold))
        Text(NativeStrings.VoiceSetup.personalDetail)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      switch model.access {
      case .notAsked:
        Button {
          Task { await model.requestPersonalVoice() }
        } label: {
          Text(NativeStrings.VoiceSetup.personalUse)
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Capsule().fill(Self.accent))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hermie.voiceSetup.personal.use")
      case .denied:
        Text(NativeStrings.VoiceSetup.personalDenied)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.voiceSetup.personal.denied")
      case .granted:
        if !model.voices.contains(where: \.personal) {
          Text(NativeStrings.VoiceSetup.personalNone)
            .font(.footnote)
            .foregroundStyle(Self.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("hermie.voiceSetup.personal.none")
        }
      case .unsupported:
        EmptyView()
      }
    }
  }

  // MARK: Pace and expressivity

  private var paceCard: some View {
    let rate = rateDraft ?? settings.rate
    let expressivity = expressivityDraft ?? settings.expressivity

    return card {
      sliderRow(
        title: NativeStrings.VoiceSetup.pace, valueText: VoiceSettings.rateLabel(rate),
        value: rate, range: VoiceSettings.rateSteps[0]...VoiceSettings.rateSteps[VoiceSettings.rateSteps.count - 1],
        ticks: VoiceSettings.rateSteps, snap: true, identifier: "hermie.voiceSetup.pace",
        change: { rateDraft = $0 },
        commit: {
          if let draft = rateDraft {
            settings.setRate(draft)
          }

          rateDraft = nil
          model.preview()
        })

      Divider().overlay(Color.white.opacity(0.12))

      sliderRow(
        title: NativeStrings.VoiceSetup.expressivity,
        valueText: NativeStrings.VoiceSetup.percent(Int((expressivity * 100).rounded())),
        value: expressivity, range: 0...1, ticks: [0, 0.25, 0.5, 0.75, 1], snap: false,
        identifier: "hermie.voiceSetup.expressivity",
        change: { expressivityDraft = $0 },
        commit: {
          if let draft = expressivityDraft {
            settings.setExpressivity(draft)
          }

          expressivityDraft = nil
          model.preview()
        })
    }
  }

  private func sliderRow(
    title: String, valueText: String, value: Double, range: ClosedRange<Double>, ticks: [Double],
    snap: Bool, identifier: String, change: @escaping (Double) -> Void, commit: @escaping () -> Void
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(title)
          .font(.body.weight(.semibold))
        Spacer(minLength: 12)
        Text(valueText)
          .font(.subheadline)
          .foregroundStyle(Self.secondary)
          .accessibilityHidden(true)
      }

      VoiceTickSlider(
        value: value, range: range, ticks: ticks, snap: snap, label: title, valueText: valueText,
        accent: Self.accent, onChange: change, onCommit: commit
      )
      .accessibilityIdentifier(identifier)
    }
  }

  // MARK: Orb choice

  private var orbCard: some View {
    card {
      Text(NativeStrings.VoiceSetup.orb)
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity, alignment: .leading)

      HStack(spacing: 12) {
        orbChoice(.clouds, title: NativeStrings.VoiceSetup.orbClouds)
        orbChoice(.light, title: NativeStrings.VoiceSetup.orbLight)
      }
    }
  }

  private func orbChoice(_ style: VoiceOrbStyle, title: String) -> some View {
    let selected = settings.voiceModeOrb == style

    return Button {
      settings.setVoiceModeOrb(style)
    } label: {
      VStack(spacing: 6) {
        VoiceOrb(style: style, mode: .idle, busy: false, level: { 0 }, size: 72)

        Text(title)
          .font(.footnote.weight(.semibold))
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 10)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(Color.white.opacity(selected ? 0.12 : 0.04))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(selected ? Color.white : Color.white.opacity(0.12), lineWidth: selected ? 2 : 1)
      )
      .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("hermie.voiceSetup.orb.\(style.rawValue)")
  }

  // MARK: Source

  private var sourceCard: some View {
    @Bindable var model = model

    return card {
      HStack {
        Text(NativeStrings.VoiceSetup.source)
          .font(.body.weight(.semibold))

        Spacer(minLength: 12)

        Picker(NativeStrings.VoiceSetup.source, selection: $model.source) {
          ForEach(VoiceSourceChoice.allCases) { choice in
            Text(choice.title).tag(choice)
          }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize()
        .accessibilityIdentifier("hermie.voiceSetup.source")
      }
    }
  }

  // MARK: Done

  private var doneButton: some View {
    Button {
      settings.setVoiceModeSetUp(true)
      onDone()
    } label: {
      Text(firstRun ? NativeStrings.VoiceSetup.continueLabel : NativeStrings.VoiceSetup.done)
        .font(.headline)
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Capsule().fill(Self.accent))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .padding(.top, 4)
    .accessibilityIdentifier("hermie.voiceSetup.done")
  }

  // MARK: Pieces

  /// A rounded grey card holding rows.
  private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      content()
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Self.card))
  }
}

/// A slider with tick marks, drawn by hand: the system slider's track and its ticks do not line up the
/// same way on both platforms, and this one snaps to its ticks where it is asked to.
struct VoiceTickSlider: View {
  let value: Double
  let range: ClosedRange<Double>
  let ticks: [Double]
  let snap: Bool
  let label: String
  let valueText: String
  let accent: Color
  let onChange: (Double) -> Void
  let onCommit: () -> Void

  @ScaledMetric(relativeTo: .body) private var thumb: CGFloat = 28

  var body: some View {
    GeometryReader { proxy in
      let inset = thumb / 2
      let track = max(1, proxy.size.width - thumb)
      let position = inset + track * VoiceSliderMath.fraction(of: value, range: range)
      let mid = proxy.size.height / 2

      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.white.opacity(0.18))
          .frame(height: 6)
          .padding(.horizontal, inset)
          .position(x: proxy.size.width / 2, y: mid)

        Capsule()
          .fill(accent)
          .frame(width: max(0, position - inset), height: 6)
          .position(x: inset + max(0, position - inset) / 2, y: mid)

        ForEach(ticks, id: \.self) { tick in
          Circle()
            .fill(Color.white.opacity(0.5))
            .frame(width: 4, height: 4)
            .position(x: inset + track * VoiceSliderMath.fraction(of: tick, range: range), y: mid)
        }

        Circle()
          .fill(.white)
          .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
          .frame(width: thumb, height: thumb)
          .position(x: position, y: mid)
      }
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { drag in
            let next = VoiceSliderMath.value(
              fraction: (drag.location.x - inset) / track, range: range, ticks: ticks, snap: snap)

            if next != value {
              onChange(next)
            }
          }
          .onEnded { _ in onCommit() }
      )
    }
    .frame(height: max(thumb, 32))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue(valueText)
    .accessibilityAdjustableAction { direction in
      let step: Int

      switch direction {
      case .increment: step = 1
      case .decrement: step = -1
      @unknown default: return
      }

      onChange(VoiceSliderMath.adjusted(value: value, direction: step, range: range, ticks: ticks, snap: snap))
      onCommit()
    }
  }
}

extension NativeStrings {
  enum VoiceSetup {
    /// Choose a voice (the title of the Voice screen)
    static var title: String {
      String(localized: "native.voiceSetup.title", defaultValue: "Choose a voice", table: "Native", bundle: .module)
    }
    /// The line under the title: bots speak in this voice on calls, and it all happens on the device.
    static var subtitle: String {
      String(
        localized: "native.voiceSetup.subtitle",
        defaultValue: "Bots will speak in this voice on calls. Everything is spoken on this device.",
        table: "Native", bundle: .module)
    }
    /// Voice (the row with the language picker)
    static var voice: String {
      String(localized: "native.voiceSetup.voice", defaultValue: "Voice", table: "Native", bundle: .module)
    }
    /// Language (the language picker's accessibility label)
    static var language: String {
      String(localized: "native.voiceSetup.language", defaultValue: "Language", table: "Native", bundle: .module)
    }
    /// Automatic (no voice chosen: the system's voice for each reply's language)
    static var automatic: String {
      String(localized: "native.voiceSetup.automatic", defaultValue: "Automatic", table: "Native", bundle: .module)
    }
    /// Shown when the device has no voice for any language.
    static var noVoices: String {
      String(
        localized: "native.voiceSetup.noVoices", defaultValue: "No voices are available on this device.",
        table: "Native", bundle: .module)
    }
    /// The sentence spoken as a preview of a voice.
    static var sample: String {
      String(
        localized: "native.voiceSetup.sample",
        defaultValue: "Hi, this is how I sound. I will read your bots' replies in this voice.",
        table: "Native", bundle: .module)
    }
    /// Hint that only basic voices exist; says where better ones are downloaded (the platform's own path).
    static var betterVoices: String {
      #if os(iOS)
        String(
          localized: "native.voiceSetup.betterVoicesIOS",
          defaultValue:
            "Only basic voices are installed for this language. You can download better ones in Settings › Accessibility › Spoken Content › Voices.",
          table: "Native", bundle: .module)
      #else
        String(
          localized: "native.voiceSetup.betterVoicesMac",
          defaultValue:
            "Only basic voices are installed for this language. You can download better ones in System Settings › Accessibility › Spoken Content.",
          table: "Native", bundle: .module)
      #endif
    }
    /// Personal Voice (the row's title)
    static var personalTitle: String {
      String(
        localized: "native.voiceSetup.personalTitle", defaultValue: "Personal Voice", table: "Native",
        bundle: .module)
    }
    /// What Personal Voice is, in a line.
    static var personalDetail: String {
      String(
        localized: "native.voiceSetup.personalDetail",
        defaultValue: "Speak with your own voice. A Personal Voice is made and kept on this device.",
        table: "Native", bundle: .module)
    }
    /// The button that asks the system for permission to use Personal Voice.
    static var personalUse: String {
      String(
        localized: "native.voiceSetup.personalUse", defaultValue: "Use my Personal Voice", table: "Native",
        bundle: .module)
    }
    /// Personal Voice was refused; it can be allowed in the system settings.
    static var personalDenied: String {
      String(
        localized: "native.voiceSetup.personalDenied",
        defaultValue: "Hermie is not allowed to use your Personal Voice. You can allow it in the system settings.",
        table: "Native", bundle: .module)
    }
    /// Permission was given but this device has no Personal Voice yet.
    static var personalNone: String {
      String(
        localized: "native.voiceSetup.personalNone",
        defaultValue: "No Personal Voice found on this device. You can create one in the Accessibility settings.",
        table: "Native", bundle: .module)
    }
    /// Pace (the speaking-rate slider)
    static var pace: String {
      String(localized: "native.voiceSetup.pace", defaultValue: "Pace", table: "Native", bundle: .module)
    }
    /// Expressivity (how much the voice's pitch moves)
    static var expressivity: String {
      String(
        localized: "native.voiceSetup.expressivity", defaultValue: "Expressivity", table: "Native",
        bundle: .module)
    }
    /// {n} percent (the expressivity slider's value)
    static func percent(_ number: Int) -> String {
      String(
        localized: "native.voiceSetup.percent", defaultValue: "\(number) percent", table: "Native",
        bundle: .module)
    }
    /// Orb (the choice between the two looks)
    static var orb: String {
      String(localized: "native.voiceSetup.orb", defaultValue: "Orb", table: "Native", bundle: .module)
    }
    /// Clouds (the orb look made of drifting clouds)
    static var orbClouds: String {
      String(localized: "native.voiceSetup.orbClouds", defaultValue: "Clouds", table: "Native", bundle: .module)
    }
    /// Light (the orb look made of a glowing core with rings)
    static var orbLight: String {
      String(localized: "native.voiceSetup.orbLight", defaultValue: "Light", table: "Native", bundle: .module)
    }
    /// Source (where the voice comes from)
    static var source: String {
      String(localized: "native.voiceSetup.source", defaultValue: "Source", table: "Native", bundle: .module)
    }
    /// On this device (Apple) (the only source: the device's own synthesiser)
    static var sourceDevice: String {
      String(
        localized: "native.voiceSetup.sourceDevice", defaultValue: "On this device (Apple)", table: "Native",
        bundle: .module)
    }
    /// Continue (the button on first run)
    static var continueLabel: String {
      String(localized: "native.voiceSetup.continue", defaultValue: "Continue", table: "Native", bundle: .module)
    }
    /// Done (the button when the screen is opened again from the settings)
    static var done: String {
      String(localized: "native.voiceSetup.done", defaultValue: "Done", table: "Native", bundle: .module)
    }
    /// Voice {n} (a voice's accessibility label starts with its number)
    static func voiceNumber(_ number: Int) -> String {
      String(
        localized: "native.voiceSetup.voiceNumber", defaultValue: "Voice \(number)", table: "Native",
        bundle: .module)
    }
    /// selected (the end of the selected voice's accessibility label)
    static var selected: String {
      String(localized: "native.voiceSetup.selected", defaultValue: "selected", table: "Native", bundle: .module)
    }
    /// basic (a compact voice's quality, in its accessibility label)
    static var qualityCompact: String {
      String(
        localized: "native.voiceSetup.qualityCompact", defaultValue: "basic", table: "Native", bundle: .module)
    }
    /// enhanced (an enhanced voice's quality)
    static var qualityEnhanced: String {
      String(
        localized: "native.voiceSetup.qualityEnhanced", defaultValue: "enhanced", table: "Native",
        bundle: .module)
    }
    /// premium (a premium voice's quality)
    static var qualityPremium: String {
      String(
        localized: "native.voiceSetup.qualityPremium", defaultValue: "premium", table: "Native",
        bundle: .module)
    }
    /// Personal Voice (a Personal Voice's quality, in its accessibility label)
    static var qualityPersonal: String {
      String(
        localized: "native.voiceSetup.qualityPersonal", defaultValue: "Personal Voice", table: "Native",
        bundle: .module)
    }
  }
}
