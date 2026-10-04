import Foundation
import HermieProtocol
import HermieStore
import Observation

/**
 What the reader has decided about voice (`features/voice/voice-settings.ts` in the Expo app).

 Device-wide, and deliberately not carried through `ui_meta`: a speaking rate and a dictation language
 are facts about this device (its speaker, its keyboard, whether it has a microphone at all), and
 taking them to a second device would take the wrong answer with them. The one that could argue for
 syncing, reading replies aloud, does not win either: a phone in a car and a Mac in an office want
 different answers for the same chat. That one is per chat AND per gateway here (`autoRead`).

 Kept in the `hermie.voice` blob, whose field names are the Expo app's. Reads are per field and
 forgiving (a stored rate is clamped, not thrown away); a value that is not a language is the
 device's own. Every change is written, in order, one write after the other.
 */
@MainActor
@Observable
public final class VoiceSettings {
  /// The five stops on the rate control: the speech engine's own normal is 1. A slider would promise
  /// a precision no engine has.
  public static let rateSteps: [Double] = [0.5, 0.75, 1, 1.25, 1.5]
  public static let defaultRate = 1.0
  /// "The device's own language", as the dictation language setting stores it.
  public static let automatic = "auto"
  /// The stops on voice mode's pause control, in seconds.
  public static let silenceSteps: [Double] = [0.8, 1.2, 2, 3]
  public static let defaultSilence = 1.2
  public static let defaultExpressivity = 0.5

  /// Speaking rate, 1 being the platform's own normal.
  public private(set) var rate = VoiceSettings.defaultRate
  /// The language dictation listens for: `automatic`, or a BCP-47 tag the recogniser takes. Separate
  /// from the voice a reply is read in: the language somebody speaks to their bots in and the one
  /// their bots answer in are routinely different, and the reply's is guessed per message.
  public private(set) var dictationLanguage = VoiceSettings.automatic
  /// The identifier of the voice replies are read in when it fits the reply's language; nil lets the
  /// system choose by the language of the reply.
  public private(set) var voiceIdentifier: String?
  /// Voice mode shows what it heard, with Send, Edit and Discard, before it sends it. Dictation does
  /// not read it: dictation never sends by itself.
  public private(set) var confirmBeforeSending = true
  /// Stop reading when the app goes to the background.
  public private(set) var stopOnBackground = true
  /// Voice mode: how long a pause ends what the reader is saying, in seconds (`silenceSteps`).
  public private(set) var voiceModeSilence = VoiceSettings.defaultSilence
  /// Voice mode: speaking while a reply is read cuts it off and listens (where the device can tell
  /// the reader's voice from its own speaker's).
  public private(set) var voiceModeBargeIn = true
  /// Voice mode: the words being heard and said, small under the orb.
  public private(set) var voiceModeCaptions = true
  /// Voice mode: the orb the call screen draws.
  public private(set) var voiceModeOrb = VoiceOrbStyle.clouds
  /// Voice mode's setup screen has been through once (it comes first, the first time).
  public private(set) var voiceModeSetUp = false
  /// How much the voice's pitch moves, 0 (flat) to 1: the setup screen's Expressivity.
  public private(set) var expressivity = VoiceSettings.defaultExpressivity
  /// The chats that read each finished reply without being asked: `<bot>@<gateway id>`.
  public private(set) var autoReadChats: Set<String> = []
  public private(set) var loaded = false

  @ObservationIgnored private let keyValues: KeyValueStore?
  /// What the blob held besides these fields (the Expo app keeps its own in it), written back as found.
  @ObservationIgnored private var rest: JSONObject = [:]
  @ObservationIgnored private var chosenBeforeLoad = false
  @ObservationIgnored private var writing: Task<Void, Never>?

  /// - Parameter keyValues: where the choices are kept; nil keeps them in memory (tests, previews).
  public init(keyValues: KeyValueStore? = nil) {
    self.keyValues = keyValues
  }

  // MARK: Reading

  /// Read what the device kept. Idempotent; the launch calls it before the first chat can open. A
  /// choice made before it finished wins over what was stored.
  public func hydrate() async {
    guard !loaded else {
      return
    }

    let stored = try? await keyValues?.value(JSONObject.self, forKey: StoreKeys.voice)

    if let stored, !chosenBeforeLoad {
      apply(stored)
    }

    loaded = true
    chosenBeforeLoad = false
  }

  private func apply(_ blob: JSONObject) {
    var rest = blob

    for field in Field.all {
      rest.removeValue(forKey: field)
    }

    self.rest = rest
    rate = Self.clamped(rate: blob[Field.rate]?.doubleValue) ?? Self.defaultRate
    dictationLanguage = Self.language(blob[Field.dictationLanguage]?.stringValue) ?? Self.automatic
    voiceIdentifier = blob[Field.voice]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    confirmBeforeSending = blob[Field.confirm]?.boolValue != false
    stopOnBackground = blob[Field.stopOnBackground]?.boolValue != false
    voiceModeSilence = Self.clamped(silence: blob[Field.silence]?.doubleValue) ?? Self.defaultSilence
    voiceModeBargeIn = blob[Field.bargeIn]?.boolValue != false
    voiceModeCaptions = blob[Field.captions]?.boolValue != false
    voiceModeOrb = blob[Field.orb]?.stringValue.flatMap(VoiceOrbStyle.init(rawValue:)) ?? .clouds
    voiceModeSetUp = blob[Field.setUp]?.boolValue == true
    expressivity = Self.clamped(expressivity: blob[Field.expressivity]?.doubleValue) ?? Self.defaultExpressivity

    let chats = (blob[Field.autoRead]?.objectValue ?? [:]).filter { $0.value.boolValue == true }
    autoReadChats = Set(chats.keys)
  }

  /// A rate between the slowest and the fastest stop. Clamped, not rejected: a value from an older
  /// build is a value somebody meant. Nil for what is not a number.
  public static func clamped(rate: Double?) -> Double? {
    guard let rate, rate.isFinite else {
      return nil
    }

    return min(rateSteps[rateSteps.count - 1], max(rateSteps[0], rate))
  }

  /// A pause between the shortest and the longest stop; nil for what is not a number.
  public static func clamped(silence: Double?) -> Double? {
    guard let silence, silence.isFinite else {
      return nil
    }

    return min(silenceSteps[silenceSteps.count - 1], max(silenceSteps[0], silence))
  }

  /// Expressivity between 0 and 1; nil for what is not a number.
  public static func clamped(expressivity: Double?) -> Double? {
    guard let expressivity, expressivity.isFinite else {
      return nil
    }

    return min(1, max(0, expressivity))
  }

  /// `automatic`, or something shaped like a BCP-47 tag (`nl`, `nl-NL`, `zh-Hans-CN`). Nil otherwise.
  public static func language(_ value: String?) -> String? {
    guard let value else {
      return nil
    }

    if value == automatic {
      return automatic
    }

    let shape = #"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$"#
    return value.range(of: shape, options: .regularExpression) != nil ? value : nil
  }

  // MARK: Choices

  public func setRate(_ value: Double) {
    change { $0.rate = Self.clamped(rate: value) ?? Self.defaultRate }
  }

  public func setDictationLanguage(_ value: String) {
    change { $0.dictationLanguage = Self.language(value) ?? Self.automatic }
  }

  public func setVoiceIdentifier(_ value: String?) {
    change { $0.voiceIdentifier = (value?.isEmpty ?? true) ? nil : value }
  }

  public func setConfirmBeforeSending(_ value: Bool) {
    change { $0.confirmBeforeSending = value }
  }

  public func setStopOnBackground(_ value: Bool) {
    change { $0.stopOnBackground = value }
  }

  public func setVoiceModeSilence(_ value: Double) {
    change { $0.voiceModeSilence = Self.clamped(silence: value) ?? Self.defaultSilence }
  }

  public func setVoiceModeBargeIn(_ value: Bool) {
    change { $0.voiceModeBargeIn = value }
  }

  public func setVoiceModeCaptions(_ value: Bool) {
    change { $0.voiceModeCaptions = value }
  }

  public func setVoiceModeOrb(_ value: VoiceOrbStyle) {
    change { $0.voiceModeOrb = value }
  }

  public func setVoiceModeSetUp(_ value: Bool) {
    change { $0.voiceModeSetUp = value }
  }

  public func setExpressivity(_ value: Double) {
    change { $0.expressivity = Self.clamped(expressivity: value) ?? Self.defaultExpressivity }
  }

  /// The key a chat is kept under in `autoReadChats`.
  public static func chatKey(bot: String, gatewayID: String) -> String {
    GatewayNamespace(gatewayID).key(bot)
  }

  public func autoRead(bot: String, gatewayID: String) -> Bool {
    autoReadChats.contains(Self.chatKey(bot: bot, gatewayID: gatewayID))
  }

  public func setAutoRead(_ on: Bool, bot: String, gatewayID: String) {
    let key = Self.chatKey(bot: bot, gatewayID: gatewayID)

    change {
      // Only the ones are kept: off is the default, and a set with an entry for every chat the reader
      // ever opened would grow for nothing.
      if on {
        $0.autoReadChats.insert(key)
      } else {
        $0.autoReadChats.remove(key)
      }
    }
  }

  /// Put everything back to the defaults.
  public func reset() {
    change {
      $0.rate = Self.defaultRate
      $0.dictationLanguage = Self.automatic
      $0.voiceIdentifier = nil
      $0.confirmBeforeSending = true
      $0.stopOnBackground = true
      $0.voiceModeSilence = Self.defaultSilence
      $0.voiceModeBargeIn = true
      $0.voiceModeCaptions = true
      $0.voiceModeOrb = .clouds
      $0.expressivity = Self.defaultExpressivity
      $0.autoReadChats = []
    }
  }

  // MARK: Writing

  private enum Field {
    static let rate = "rate"
    static let dictationLanguage = "dictationLanguage"
    static let voice = "voiceIdentifier"
    static let confirm = "confirmBeforeSending"
    static let stopOnBackground = "stopOnBackground"
    static let autoRead = "autoReadChats"
    static let silence = "voiceModeSilence"
    static let bargeIn = "voiceModeBargeIn"
    static let captions = "voiceModeCaptions"
    static let orb = "voiceModeOrb"
    static let setUp = "voiceModeSetUp"
    static let expressivity = "expressivity"
    static let all = [
      rate, dictationLanguage, voice, confirm, stopOnBackground, autoRead, silence, bargeIn, captions, orb, setUp,
      expressivity
    ]
  }

  private func change(_ edit: (VoiceSettings) -> Void) {
    let before = fingerprint
    edit(self)

    guard fingerprint != before else {
      return
    }

    if !loaded {
      chosenBeforeLoad = true
    }

    persist()
  }

  private var fingerprint: [String] {
    [
      String(rate), dictationLanguage, voiceIdentifier ?? "", String(confirmBeforeSending),
      String(stopOnBackground), autoReadChats.sorted().joined(separator: "\n"), String(voiceModeSilence),
      String(voiceModeBargeIn), String(voiceModeCaptions), voiceModeOrb.rawValue, String(voiceModeSetUp),
      String(expressivity)
    ]
  }

  private var blob: JSONObject {
    var blob = rest
    blob[Field.rate] = .number(rate)
    blob[Field.dictationLanguage] = .string(dictationLanguage)

    if let voiceIdentifier {
      blob[Field.voice] = .string(voiceIdentifier)
    }

    blob[Field.confirm] = .bool(confirmBeforeSending)
    blob[Field.stopOnBackground] = .bool(stopOnBackground)
    blob[Field.silence] = .number(voiceModeSilence)
    blob[Field.bargeIn] = .bool(voiceModeBargeIn)
    blob[Field.captions] = .bool(voiceModeCaptions)
    blob[Field.orb] = .string(voiceModeOrb.rawValue)
    blob[Field.setUp] = .bool(voiceModeSetUp)
    blob[Field.expressivity] = .number(expressivity)
    blob[Field.autoRead] = .object(JSONObject(uniqueKeysWithValues: autoReadChats.map { ($0, JSONValue.bool(true)) }))
    return blob
  }

  private func persist() {
    guard let keyValues else {
      return
    }

    let value = blob
    let before = writing

    writing = Task {
      await before?.value
      try? await keyValues.set(value, forKey: StoreKeys.voice)
    }
  }

  /// Wait for every write started so far (tests; the app never needs to).
  public func settled() async {
    await writing?.value
  }
}

/// The orb voice mode's call screen draws: a sphere of drifting clouds, or a glowing core of light
/// with rings around it. Both say the same things (listening, thinking, speaking, muted).
public enum VoiceOrbStyle: String, Sendable, CaseIterable {
  case clouds
  case light
}
