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

  /// Speaking rate, 1 being the platform's own normal.
  public private(set) var rate = VoiceSettings.defaultRate
  /// The language dictation listens for: `automatic`, or a BCP-47 tag the recogniser takes. Separate
  /// from the voice a reply is read in: the language somebody speaks to their bots in and the one
  /// their bots answer in are routinely different, and the reply's is guessed per message.
  public private(set) var dictationLanguage = VoiceSettings.automatic
  /// The identifier of the voice replies are read in when it fits the reply's language; nil lets the
  /// system choose by the language of the reply.
  public private(set) var voiceIdentifier: String?
  /// Show what voice mode heard for a moment before it sends it. Stored with the others so a voice
  /// mode finds it; nothing in dictation reads it, because dictation never sends by itself.
  public private(set) var confirmBeforeSending = true
  /// Stop reading when the app goes to the background.
  public private(set) var stopOnBackground = true
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
    static let all = [rate, dictationLanguage, voice, confirm, stopOnBackground, autoRead]
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
      String(stopOnBackground), autoReadChats.sorted().joined(separator: "\n")
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
