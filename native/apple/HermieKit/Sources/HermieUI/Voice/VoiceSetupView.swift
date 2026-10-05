import HermieCore
import Observation
import SwiftUI

/// Where the voice comes from: the device's own synthesiser, or the gateway's text-to-speech (offered
/// only where the gateway says it has one).
enum VoiceSourceChoice: CaseIterable, Identifiable, Hashable {
  case device
  case gateway

  var id: Self { self }

  init(_ source: SpeechSource) {
    self = source == .gateway ? .gateway : .device
  }

  var speechSource: SpeechSource {
    switch self {
    case .device: .apple
    case .gateway: .gateway
    }
  }

  var title: String {
    switch self {
    case .device: NativeStrings.VoiceSetup.sourceDevice
    case .gateway: NativeStrings.VoiceSetup.sourceGateway
    }
  }
}

/// What a screen knows of a gateway's text-to-speech: not yet, yes, or no. A choice of the gateway is
/// kept in all three; only what is heard (and what the screen says about it) differs.
enum GatewayVoiceState: Equatable {
  /// `voice-config` has not answered yet.
  case unknown
  /// The gateway can speak.
  case ready
  /// There is no gateway to ask, it could not be reached, or it says it cannot speak.
  case unavailable
}

enum GatewayVoiceLogic {
  /// `listed`, and the voice `chosen` in front when it is not among them: a gateway voice that is chosen is
  /// always on screen, selected, whether or not the list has it (yet).
  static func keeping(_ chosen: String?, in listed: [GatewayVoice]) -> [GatewayVoice] {
    guard let chosen, !chosen.isEmpty, !listed.contains(where: { $0.id == chosen }) else {
      return listed
    }

    return [GatewayVoice(id: chosen, name: chosen)] + listed
  }

  /// The state of `gateway`'s text-to-speech: no gateway at all is unavailable.
  @MainActor
  static func state(of gateway: GatewaySpeechAccess?) -> GatewayVoiceState {
    guard let gateway else {
      return .unavailable
    }

    guard let config = gateway.config else {
      return .unknown
    }

    return config.ttsAvailable ? .ready : .unavailable
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

  /// Every installed voice of the language `tag` names, in dot order. The language is the tag's language
  /// code, not the whole tag: Dutch lists the `nl-NL` and `nl-BE` voices together, English `en-US`,
  /// `en-GB`, `en-AU` and the rest, so no regional variant is thrown away.
  static func voices(in tag: String?, from voices: [SpeechVoice]) -> [SpeechVoice] {
    guard let tag else {
      return []
    }

    let code = languageCode(tag)

    return ordered(voices.filter { languageCode($0.language) == code })
  }

  /// The languages the menu lists: one per language code (a language is offered once, whatever regions
  /// its voices come from), named by the language alone ("Dutch"). Each carries a tag to speak in: the
  /// device's own where there is a voice for it, else one of the device's region, else the first.
  static func languageChoices(
    voices: [SpeechVoice], deviceTag: String, locale: Locale = .current
  ) -> [VoiceLanguageChoice] {
    let device = deviceTag.replacingOccurrences(of: "_", with: "-")
    let region = device.split(separator: "-").last.map { $0.uppercased() }

    return Dictionary(grouping: Set(voices.map(\.language)), by: { languageCode($0) })
      .compactMap { code, tags -> VoiceLanguageChoice? in
        guard !code.isEmpty else {
          return nil
        }

        let sorted = tags.sorted()
        let tag =
          sorted.first { $0.caseInsensitiveCompare(device) == .orderedSame }
          ?? sorted.first { $0.contains("-") && $0.split(separator: "-").last.map { $0.uppercased() } == region }
          ?? sorted[0]

        return VoiceLanguageChoice(tag: tag, name: VoiceLanguageChoice.name(of: code, locale: locale))
      }
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  /// The voices come from more than one region of the language, so a voice's region tells it apart.
  static func spansRegions(_ voices: [SpeechVoice]) -> Bool {
    Set(voices.map { $0.language.replacingOccurrences(of: "_", with: "-").lowercased() }).count > 1
  }

  /// `nl-BE` as "Belgium", in the reader's language; nil for a tag with no region.
  static func regionName(of tag: String, locale: Locale = .current) -> String? {
    let parts = tag.replacingOccurrences(of: "_", with: "-").split(separator: "-")

    guard let region = parts.dropFirst().last(where: { $0.count == 2 || $0.count == 3 }) else {
      return nil
    }

    return locale.localizedString(forRegionCode: String(region))
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

  /// "Voice 3, Ava, enhanced, selected"; with the region ("…, Belgium, …") where the voices span several.
  static func dotLabel(number: Int, voice: SpeechVoice, selected: Bool, showRegion: Bool = false) -> String {
    var parts = [NativeStrings.VoiceSetup.voiceNumber(number), voice.name]

    parts.append(voice.personal ? NativeStrings.VoiceSetup.qualityPersonal : quality(voice.quality))

    if showRegion, let region = regionName(of: voice.language) {
      parts.append(region)
    }

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
  /// The gateway's text-to-speech as this screen's bot (or the default profile) sees it; nil where the
  /// screen has no gateway to ask.
  let gateway: GatewaySpeechAccess?
  /// Hearing a gateway voice before choosing it, where the gateway says that is free; one per screen, so
  /// a fetched sample is kept as long as the screen is.
  let previewer: GatewayVoicePreviewer?

  @ObservationIgnored private let deviceTag: String
  @ObservationIgnored private let sample: String
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var loaded = false

  init(
    settings: VoiceSettings, speaker: any SpeechSynthesizing, gateway: GatewaySpeechAccess? = nil,
    deviceTag: String = Locale.preferredLanguages.first ?? Locale.current.identifier,
    sample: String = NativeStrings.VoiceSetup.sample, clipPlayer: (any GatewayClipPlaying)? = nil,
    callActive: (@MainActor () -> Bool)? = nil
  ) {
    self.settings = settings
    self.speaker = speaker
    self.gateway = gateway
    previewer = gateway.map {
      GatewayVoicePreviewer(
        access: $0, player: clipPlayer ?? GatewayClipPlayer(), sentence: sample, callActive: callActive)
    }
    self.deviceTag = deviceTag
    self.sample = sample
  }

  // MARK: The gateway's voice

  /// Read what the gateway offers: whether it speaks, with whom, and the voices to choose from.
  func loadGateway() async {
    guard let gateway else {
      return
    }

    await gateway.loadConfig()
    await gateway.loadVoices()
  }

  /// What the screen knows of the gateway's text-to-speech right now.
  var gatewayState: GatewayVoiceState { GatewayVoiceLogic.state(of: gateway) }

  /// The gateway says its text-to-speech is there.
  var offersGateway: Bool { gatewayState == .ready }

  /// The Source row is drawn: the gateway can speak, or it is what was chosen. A choice already made is
  /// never hidden because the answer has not come yet or did not come: it stays on screen, as chosen.
  var showsSourceRow: Bool { offersGateway || settings.speechSource == .gateway }

  /// The chosen gateway cannot be reached or cannot speak (not: has not answered yet): the choice is
  /// kept, and the screen says that the device speaks meanwhile.
  var gatewayUnavailable: Bool { source == .gateway && gatewayState == .unavailable }

  /// Where the voice is from: what was chosen, as chosen. Whether the gateway can speak now decides what
  /// is heard (the device's voice speaks when it cannot), never what is shown as chosen.
  var source: VoiceSourceChoice {
    get { VoiceSourceChoice(settings.speechSource) }
    set {
      settings.setSpeechSource(newValue.speechSource)
      preview()
    }
  }

  /// The line under the title: what is said stays on the device only for the device's voice.
  var subtitle: String {
    source == .gateway && !gatewayUnavailable ? NativeStrings.VoiceSetup.subtitleGateway : NativeStrings.VoiceSetup.subtitle
  }

  /// Which provider the gateway speaks with, in a sentence.
  var gatewayProviderLine: String {
    gateway?.providerName.map { NativeStrings.VoiceSetup.gatewayProvider($0) }
      ?? NativeStrings.VoiceSetup.gatewayProviderUnknown
  }

  /// A voice can be chosen for the gateway (it takes one with a request, and has a list).
  var canChooseGatewayVoice: Bool { gateway?.canChooseVoice == true }

  /// The voices to choose from: the listed ones, and the one chosen when it is not among them (the list
  /// is still loading, could not be read, or the voice is not in it yet), so what is chosen always shows.
  var gatewayVoices: [GatewayVoice] {
    GatewayVoiceLogic.keeping(settings.gatewayVoice, in: listedGatewayVoices)
  }

  /// The voices the gateway lists, as far as the screen shows them. A provider that lists its voices by
  /// language (Edge) shows those of the device's language, or all of them where none is, and always the
  /// one chosen; ElevenLabs' are not tied to a language and all show.
  var listedGatewayVoices: [GatewayVoice] {
    let all = gateway?.selectableVoices ?? []

    guard gateway?.config?.isElevenLabs != true, all.contains(where: { $0.language != nil }) else {
      return all
    }

    let code = VoiceSetupLogic.languageCode(deviceTag)
    let chosen = settings.gatewayVoice
    let same = all.filter { voice in
      voice.id == chosen || voice.language.map(VoiceSetupLogic.languageCode) == code
    }

    return same.contains(where: { $0.id != chosen }) ? same : all
  }

  var loadingGatewayVoices: Bool {
    gateway?.loadingVoices == true
      || (gateway?.voicesLoaded == false && listedGatewayVoices.isEmpty && gateway?.config?.isElevenLabs == true
        && gateway?.voicesError == nil)
  }

  /// Why the gateway's voice list is empty, when it says it could not read it (and is not being asked again).
  var gatewayVoicesError: GatewayVoicesError? { loadingGatewayVoices ? nil : gateway?.voicesError }

  /// Ask the gateway for its voice list again.
  func retryGatewayVoices() async {
    await gateway?.retryVoices()
  }

  /// A play button's tap: the sample of `voice`, or silence if it is the one playing. The sentence the
  /// device was saying stops first, and the selection is left as it is.
  func togglePreview(_ voice: GatewayVoice) {
    speaker.stop()
    generation += 1
    previewing = false
    previewer?.toggle(voice)
  }

  /// Choose a gateway voice (nil is the gateway's own), and say the sample in it.
  func selectGatewayVoice(_ id: String?) {
    settings.setGatewayVoice(id)
    preview()
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

  /// One entry per language: the voices of all its regions show under it.
  var languages: [VoiceLanguageChoice] { VoiceSetupLogic.languageChoices(voices: voices, deviceTag: deviceTag) }

  var languageName: String {
    language.map { VoiceLanguageChoice.name(of: VoiceSetupLogic.languageCode($0)) } ?? NativeStrings.VoiceSetup.automatic
  }

  /// Whether `tag`'s language is the one shown (a menu entry's tag stands for its whole language).
  func isShowing(_ tag: String) -> Bool {
    language.map { VoiceSetupLogic.languageCode($0) == VoiceSetupLogic.languageCode(tag) } ?? false
  }

  /// The voices come from several regions of the language: each dot says which.
  var showsRegions: Bool { VoiceSetupLogic.spansRegions(shown) }

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

    if let language, VoiceSetupLogic.languageCode(voice.language) == VoiceSetupLogic.languageCode(language) {
      if showsRegions, let region = VoiceSetupLogic.regionName(of: voice.language) {
        return "\(voice.name) · \(region)"
      }

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
    previewer?.stop()
    speaker.stop()
    generation += 1

    guard speaker.isAvailable else {
      previewing = false
      return
    }

    let current = generation
    let spoken = source
    let request = ReadRequest(
      id: "preview", text: sample, language: selectedVoice?.language ?? language,
      pitch: VoiceProsody.pitch(expressivity: settings.expressivity, sentence: 0),
      source: spoken.speechSource, gatewayVoice: spoken == .gateway ? settings.gatewayVoice : nil)

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
    previewer?.stop()
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

  init(
    settings: VoiceSettings, speaker: any SpeechSynthesizing, gateway: GatewaySpeechAccess? = nil, firstRun: Bool,
    onDone: @escaping () -> Void
  ) {
    self.settings = settings
    self.firstRun = firstRun
    self.onDone = onDone
    _model = State(initialValue: VoiceSetupModel(settings: settings, speaker: speaker, gateway: gateway))
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
          Text(model.subtitle)
            .font(.subheadline)
            .foregroundStyle(Self.secondary)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("hermie.voiceSetup.subtitle")
        }

        if model.showsSourceRow {
          sourceCard
        }

        if model.source == .gateway {
          gatewayCard
        } else {
          voiceCard

          if model.access != .unsupported {
            personalCard
          }
        }

        paceCard
        orbCard
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
    .task { await model.loadGateway() }
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
              if model.isShowing(choice.tag) {
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
    .accessibilityLabel(
      VoiceSetupLogic.dotLabel(number: number, voice: voice, selected: selected, showRegion: model.showsRegions))
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

      if model.source == .gateway {
        Text(NativeStrings.VoiceSetup.gatewayPaceNote)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.voiceSetup.paceNote")
      }
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
        .accessibilityLabel(NativeStrings.VoiceSetup.source)
        .accessibilityValue(model.source.title)
        .accessibilityIdentifier("hermie.voiceSetup.source")
      }
    }
  }

  // MARK: The gateway's voice

  private var gatewayCard: some View {
    card {
      switch model.gatewayState {
      case .ready:
        Text(model.gatewayProviderLine)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.voiceSetup.gatewayProvider")
      case .unknown:
        HStack(spacing: 10) {
          ProgressView()
          Text(NativeStrings.VoiceSetup.gatewayVoicesLoading)
            .font(.footnote)
            .foregroundStyle(Self.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.voiceSetup.gatewayChecking")
      case .unavailable:
        GatewayUnavailableView(
          color: Self.secondary, tint: Self.accent,
          retry: model.gateway == nil ? nil : { Task { await model.retryGatewayVoices() } },
          identifierPrefix: "hermie.voiceSetup.gateway")
      }

      // Not ready: the choice is still shown, as chosen (the default row, and the voice if one was chosen).
      if model.canChooseGatewayVoice || model.gatewayState != .ready {
        VStack(alignment: .leading, spacing: 0) {
          gatewayRow(title: NativeStrings.VoiceSetup.gatewayDefaultVoice, id: nil)

          if model.loadingGatewayVoices {
            HStack(spacing: 10) {
              ProgressView()
              Text(NativeStrings.VoiceSetup.gatewayVoicesLoading)
                .font(.footnote)
                .foregroundStyle(Self.secondary)
            }
            .padding(.vertical, 10)
            .accessibilityElement(children: .combine)
          } else if let error = model.gatewayVoicesError {
            GatewayVoicesErrorView(
              error: error, color: Self.secondary, tint: Self.accent,
              retry: { Task { await model.retryGatewayVoices() } }, identifierPrefix: "hermie.voiceSetup.gateway")
          } else if model.gatewayState == .ready, model.listedGatewayVoices.isEmpty {
            Text(NativeStrings.VoiceSetup.gatewayVoicesNone)
              .font(.footnote)
              .foregroundStyle(Self.secondary)
              .padding(.vertical, 10)
              .accessibilityIdentifier("hermie.voiceSetup.gatewayNone")
          }

          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(model.gatewayVoices) { voice in
              gatewayRow(title: voice.label, id: voice.id, voice: voice)
            }
          }
        }
      } else {
        Text(NativeStrings.VoiceSetup.gatewayNoChoice)
          .font(.footnote)
          .foregroundStyle(Self.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.voiceSetup.gatewayNoChoice")
      }

      sampleButton
    }
  }

  /// One voice to choose. `voice` is given for a listed voice (not "Default"): its play button, where the
  /// gateway says a sample is free, sits beside the choosing button and never chooses.
  private func gatewayRow(title: String, id: String?, voice: GatewayVoice? = nil) -> some View {
    let selected = settings.gatewayVoice == id

    return VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Button {
          model.selectGatewayVoice(id)
        } label: {
          HStack(spacing: 10) {
            Text(title)
              .font(.body)
              .multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)

            if selected {
              Image(systemName: "checkmark")
                .font(.body.weight(.semibold))
                .accessibilityHidden(true)
            }
          }
          .padding(.vertical, 10)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "\(title), \(NativeStrings.VoiceSetup.selected)" : title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("hermie.voiceSetup.gatewayVoice.\(id ?? "default")")

        if let voice, let previewer = model.previewer, previewer.offers(voice) {
          GatewayVoicePreviewButton(
            voice: voice, previewer: previewer, tint: Self.accent, identifierPrefix: "hermie.voiceSetup.gatewayVoice")
        }
      }

      if let voice, let previewer = model.previewer {
        GatewayVoicePreviewMessage(
          voiceID: voice.id, previewer: previewer, color: Self.secondary, identifierPrefix: "hermie.voiceSetup.gatewayVoice")
          .padding(.bottom, 6)
      }
    }
  }

  private var sampleButton: some View {
    Button {
      if model.previewing {
        model.stop()
      } else {
        model.preview()
      }
    } label: {
      Label(
        model.previewing ? NativeStrings.VoiceSetup.gatewayStopSample : NativeStrings.VoiceSetup.gatewaySample,
        systemImage: model.previewing ? "stop.fill" : "play.fill"
      )
      .font(.subheadline.weight(.semibold))
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(Capsule().fill(Self.accent))
      .foregroundStyle(.white)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("hermie.voiceSetup.gatewaySample")
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
            "Only basic voices are installed for this language. You can download better ones in System Settings › Accessibility › Spoken Content › System Voice › Manage Voices.",
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
    /// Your gateway (the source that is the gateway's text-to-speech)
    static var sourceGateway: String {
      String(
        localized: "native.voiceSetup.sourceGateway", defaultValue: "Your gateway", table: "Native", bundle: .module)
    }
    /// The line under the title when the voice is the gateway's
    static var subtitleGateway: String {
      String(
        localized: "native.voiceSetup.subtitleGateway", defaultValue: "Bots will speak in this voice on calls. Their words are sent to your gateway to be spoken.", table: "Native", bundle: .module)
    }
    /// Which provider the gateway speaks with
    static func gatewayProvider(_ provider: String) -> String {
      String(
        localized: "native.voiceSetup.gatewayProvider",
        defaultValue: "Spoken by \(provider) through your gateway.", table: "Native", bundle: .module)
    }
    /// The gateway does not name its provider
    static var gatewayProviderUnknown: String {
      String(
        localized: "native.voiceSetup.gatewayProviderUnknown", defaultValue: "Spoken in the voice your gateway is set up with.", table: "Native", bundle: .module)
    }
    /// The gateway's own voice
    static var gatewayDefaultVoice: String {
      String(
        localized: "native.voiceSetup.gatewayDefaultVoice", defaultValue: "Gateway default", table: "Native", bundle: .module)
    }
    /// While the gateway's voices are read
    static var gatewayVoicesLoading: String {
      String(
        localized: "native.voiceSetup.gatewayVoicesLoading", defaultValue: "Loading voices…", table: "Native", bundle: .module)
    }
    /// The gateway lists no voices
    static var gatewayVoicesNone: String {
      String(
        localized: "native.voiceSetup.gatewayVoicesNone", defaultValue: "Your gateway lists no voices.", table: "Native", bundle: .module)
    }
    /// A voice cannot be chosen: the gateway takes none with a request
    static var gatewayNoChoice: String {
      String(
        localized: "native.voiceSetup.gatewayNoChoice", defaultValue: "Your gateway speaks in the voice it is set up with. Choosing another voice here needs a newer gateway.", table: "Native", bundle: .module)
    }
    /// The gateway is chosen but cannot speak now: the choice stays, the device speaks until it can
    static var gatewayUnavailable: String {
      String(
        localized: "native.voiceSetup.gatewayUnavailable",
        defaultValue:
          "Your gateway's voice isn't available right now. Your choice is kept; this device speaks until the gateway answers.",
        table: "Native", bundle: .module)
    }
    /// Under the sliders when the voice is the gateway's
    static var gatewayPaceNote: String {
      String(
        localized: "native.voiceSetup.gatewayPaceNote", defaultValue: "Pace and expressivity change the Apple voice, not the gateway's.", table: "Native", bundle: .module)
    }
    /// Plays a sample in the gateway's voice
    static var gatewaySample: String {
      String(
        localized: "native.voiceSetup.gatewaySample", defaultValue: "Play a sample", table: "Native", bundle: .module)
    }
    /// The same button while the sample plays
    static var gatewayStopSample: String {
      String(
        localized: "native.voiceSetup.gatewayStopSample", defaultValue: "Stop the sample", table: "Native", bundle: .module)
    }
    /// A voice's play button: "Play sample of Rachel"
    static func previewPlay(_ name: String) -> String {
      String(
        localized: "native.voiceSetup.previewPlay", defaultValue: "Play sample of \(name)", table: "Native",
        bundle: .module)
    }
    /// The same button while the sample loads or plays
    static var previewStop: String {
      String(localized: "native.voiceSetup.previewStop", defaultValue: "Stop", table: "Native", bundle: .module)
    }
    /// The play button's value while the sample is fetched
    static var previewLoading: String {
      String(
        localized: "native.voiceSetup.previewLoading", defaultValue: "Loading the sample", table: "Native",
        bundle: .module)
    }
    /// The gateway has no sample of the voice
    static var previewNoSample: String {
      String(
        localized: "native.voiceSetup.previewNoSample", defaultValue: "The gateway has no sample of this voice.",
        table: "Native", bundle: .module)
    }
    /// The sample could not be fetched
    static var previewUnreachable: String {
      String(
        localized: "native.voiceSetup.previewUnreachable", defaultValue: "Couldn't get the sample. Try again.",
        table: "Native", bundle: .module)
    }
    /// The sample could not be played
    static var previewUnplayable: String {
      String(
        localized: "native.voiceSetup.previewUnplayable", defaultValue: "Couldn't play the sample.", table: "Native",
        bundle: .module)
    }
    /// A sample was asked for during a voice call
    static var previewCallActive: String {
      String(
        localized: "native.voiceSetup.previewCallActive", defaultValue: "Samples can't play during a voice call.",
        table: "Native", bundle: .module)
    }
    /// The gateway could not read its voice list
    static var voicesUnavailable: String {
      String(
        localized: "native.voiceSetup.voicesUnavailable", defaultValue: "Your gateway can't list its voices right now.",
        table: "Native", bundle: .module)
    }
    /// The gateway is still reading its voice list
    static var voicesStillLoading: String {
      String(
        localized: "native.voiceSetup.voicesStillLoading", defaultValue: "Your gateway is still loading its voices.",
        table: "Native", bundle: .module)
    }
    /// Asks the gateway for its voice list again
    static var voicesRetry: String {
      String(localized: "native.voiceSetup.voicesRetry", defaultValue: "Try again", table: "Native", bundle: .module)
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
