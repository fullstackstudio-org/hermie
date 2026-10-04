import HermieCore
import SwiftUI

/// What the page asks the device: which languages it can dictate in, where each is recognised, and which
/// voices it can read in. One of each engine, made when the page opens and kept for as long as it is open.
@MainActor
final class VoiceProbe {
  let recogniser: any DictationEngine
  let synthesiser: any SpeechSynthesizing

  init(engines: VoiceEngines = .live) {
    recogniser = engines.dictation()
    synthesiser = engines.speech()
  }

  var canDictate: Bool { recogniser.isAvailable }
  var canSpeak: Bool { synthesiser.isAvailable }
}

/// A language as the pickers list it: the tag the recogniser takes, and its name in the reader's language.
struct VoiceLanguageChoice: Equatable, Identifiable {
  var tag: String
  var name: String

  var id: String { tag }

  /// `nl-NL` as "Dutch (Netherlands)", in the language the app is in.
  static func name(of tag: String, locale: Locale = .current) -> String {
    locale.localizedString(forIdentifier: tag) ?? tag
  }

  /// The tags the recogniser takes, named and sorted by name, each once.
  static func choices(_ tags: [String], locale: Locale = .current) -> [VoiceLanguageChoice] {
    Set(tags)
      .map { VoiceLanguageChoice(tag: $0, name: name(of: $0, locale: locale)) }
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }
}

extension VoiceSettings {
  /// A rate stop's name (Slowest … Fastest): the stops are `rateSteps`, in that order.
  static func rateLabel(_ rate: Double) -> String {
    switch rateSteps.firstIndex(of: rate) {
    case 0: Strings.Chat.Voice.RateOptions.slowest
    case 1: Strings.Chat.Voice.RateOptions.slow
    case 3: Strings.Chat.Voice.RateOptions.fast
    case 4: Strings.Chat.Voice.RateOptions.fastest
    default: Strings.Chat.Voice.RateOptions.normal
    }
  }
}

/**
 Settings › Voice (Expo's `features/settings/categories/Voice.tsx`): how Hermie reads a reply out, and how
 it hears you. Per chat, whether a chat reads each finished reply is in that chat's options.

 Each half is drawn only where the device has it: reading needs a synthesiser, dictation a recogniser.
 The dictation footer says that the language chosen is recognised on this device, or that the device has no
 model for it: dictation never falls back to a speech service (ADR-0022).
 */
struct VoiceSettingsPage: View {
  @Environment(AppLaunch.self) private var launch

  @State private var probe = VoiceProbe()

  var body: some View {
    let settings = launch.voice

    Form {
      if probe.canSpeak {
        Section {
          Picker(
            Strings.Chat.Voice.rate,
            selection: Binding(get: { settings.rate }, set: { settings.setRate($0) })
          ) {
            ForEach(VoiceSettings.rateSteps, id: \.self) { step in
              Text(VoiceSettings.rateLabel(step)).tag(step)
            }
          }
          .accessibilityIdentifier("hermie.settings.voice.rate")

          NavigationLink {
            VoicePickerPage(probe: probe)
          } label: {
            LabeledContent(NativeStrings.Voice.voice) {
              Text(Self.voiceName(settings.voiceIdentifier, in: probe.synthesiser.voices()))
            }
          }
          .accessibilityIdentifier("hermie.settings.voice.voice")

          Toggle(Strings.Chat.Voice.stopOnBackground, isOn: Binding(
            get: { settings.stopOnBackground }, set: { settings.setStopOnBackground($0) }))
            .accessibilityIdentifier("hermie.settings.voice.stopOnBackground")
        } header: {
          Text(NativeStrings.Voice.reading)
        } footer: {
          SettingsNote(NativeStrings.Voice.readingFooter)
        }
      }

      if probe.canDictate {
        Section {
          NavigationLink {
            DictationLanguagePage(probe: probe)
          } label: {
            LabeledContent(Strings.Chat.Voice.dictationLanguage) {
              Text(Self.languageName(settings.dictationLanguage))
            }
          }
          .accessibilityIdentifier("hermie.settings.voice.language")
        } header: {
          Text(NativeStrings.Voice.dictation)
        } footer: {
          SettingsNote(Self.dictationFooter(probe: probe, language: settings.dictationLanguage))
            .accessibilityIdentifier("hermie.settings.voice.footer")
        }
      }

      if !probe.canSpeak, !probe.canDictate {
        Section {
          Text(NativeStrings.Voice.unavailable)
        } footer: {
          SettingsNote(SettingsCategory.voice.blurb)
        }
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.settings.voice")
  }

  /// "Device language", or the language's name.
  static func languageName(_ setting: String) -> String {
    setting == VoiceSettings.automatic ? Strings.Chat.Voice.dictationAuto : VoiceLanguageChoice.name(of: setting)
  }

  /// The chosen voice's name, or "Automatic".
  static func voiceName(_ identifier: String?, in voices: [SpeechVoice]) -> String {
    identifier.flatMap { id in voices.first { $0.id == id }?.name } ?? NativeStrings.Voice.automatic
  }

  /// Whether the language in force can be dictated here, and that dictated words wait in the field to
  /// be sent: the footer under the language row.
  static func dictationFooter(probe: VoiceProbe, language: String) -> String {
    let tag = language == VoiceSettings.automatic ? nil : language
    let name = tag.map { VoiceLanguageChoice.name(of: $0) } ?? Self.deviceLanguageName
    let location: String

    switch probe.recogniser.processing(language: tag) {
    case .onDevice: location = NativeStrings.Voice.Processing.onDevice(name)
    case .unavailable: location = NativeStrings.Voice.Processing.unavailable(name)
    }

    return location + " " + NativeStrings.Voice.dictationNote
  }

  /// The device's own language, in its own name for it.
  static var deviceLanguageName: String {
    Locale.current.localizedString(forIdentifier: Locale.current.identifier) ?? Locale.current.identifier
  }
}

/// Settings › Voice › Dictation language: the device's own, or one the recogniser takes.
struct DictationLanguagePage: View {
  let probe: VoiceProbe

  @Environment(AppLaunch.self) private var launch
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let settings = launch.voice
    let choices = VoiceLanguageChoice.choices(probe.recogniser.supportedLanguages())

    Form {
      Section {
        row(Strings.Chat.Voice.dictationAuto, tag: VoiceSettings.automatic, chosen: settings.dictationLanguage)
      }

      Section {
        ForEach(choices) { choice in
          row(choice.name, tag: choice.tag, chosen: settings.dictationLanguage)
        }
      } footer: {
        SettingsNote(VoiceSettingsPage.dictationFooter(probe: probe, language: settings.dictationLanguage))
      }
    }
    .formStyle(.grouped)
    .navigationTitle(Strings.Chat.Voice.dictationLanguage)
    .accessibilityIdentifier("hermie.settings.voice.languages")
  }

  private func row(_ title: String, tag: String, chosen: String) -> some View {
    let selected = tag == chosen

    return Button {
      launch.voice.setDictationLanguage(tag)
    } label: {
      HStack {
        Text(title)
          .foregroundStyle(.primary)
        Spacer()
        if selected {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("hermie.settings.voice.language.\(tag)")
  }
}

/// Settings › Voice › Voice: automatic (the voice for the reply's own language) or one of the device's
/// voices, by language. A chosen voice is used for replies in its language; any other reply gets the
/// system's voice for its own.
struct VoicePickerPage: View {
  let probe: VoiceProbe

  @Environment(AppLaunch.self) private var launch

  var body: some View {
    let settings = launch.voice
    let voices = probe.synthesiser.voices()
    let languages = Dictionary(grouping: voices, by: \.language)
      .map { VoiceLanguageChoice(tag: $0.key, name: VoiceLanguageChoice.name(of: $0.key)) }
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

    Form {
      Section {
        row(NativeStrings.Voice.automatic, id: nil, chosen: settings.voiceIdentifier)
      } footer: {
        SettingsNote(NativeStrings.Voice.voiceFooter)
      }

      ForEach(languages) { language in
        Section(language.name) {
          ForEach(voices.filter { $0.language == language.tag }) { voice in
            row(voice.name, id: voice.id, chosen: settings.voiceIdentifier)
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.Voice.voice)
    .accessibilityIdentifier("hermie.settings.voice.voices")
  }

  private func row(_ title: String, id: String?, chosen: String?) -> some View {
    let selected = id == chosen

    return Button {
      launch.voice.setVoiceIdentifier(id)
    } label: {
      HStack {
        Text(title)
          .foregroundStyle(.primary)
        Spacer()
        if selected {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

extension NativeStrings {
  enum Voice {
    /// Reading aloud (the header of the reading half of Settings › Voice)
    static var reading: String { String(localized: "native.voice.reading", table: "Native", bundle: .module) }
    /// Dictation (the header of the dictation half)
    static var dictation: String { String(localized: "native.voice.dictation", table: "Native", bundle: .module) }
    /// Voice (the voice replies are read in)
    static var voice: String { String(localized: "native.voice.voice", table: "Native", bundle: .module) }
    /// Automatic (the voice for the reply's own language)
    static var automatic: String { String(localized: "native.voice.automatic", table: "Native", bundle: .module) }
    /// What the voice and the speed apply to, and that reading is done on the device.
    static var readingFooter: String {
      String(localized: "native.voice.readingFooter", table: "Native", bundle: .module)
    }
    /// What choosing a voice does for replies in other languages.
    static var voiceFooter: String {
      String(localized: "native.voice.voiceFooter", table: "Native", bundle: .module)
    }
    /// Dictated words go into the field to be checked; nothing is sent until the reader sends it.
    static var dictationNote: String {
      String(localized: "native.voice.dictationNote", table: "Native", bundle: .module)
    }
    /// Neither half is available on this device.
    static var unavailable: String {
      String(localized: "native.voice.unavailable", table: "Native", bundle: .module)
    }

    /// Where the chosen language is recognised.
    enum Processing {
      /// Dictation in {language} runs on this device. What you say does not leave it.
      static func onDevice(_ language: String) -> String {
        String(
          localized: "native.voice.processing.onDevice",
          defaultValue: "Dictation in \(language) runs on this device. What you say does not leave it.",
          table: "Native", bundle: .module)
      }
      /// Dictation is not available in {language} on this device.
      static func unavailable(_ language: String) -> String {
        String(
          localized: "native.voice.processing.unavailable",
          defaultValue: "Dictation is not available in \(language) on this device.",
          table: "Native", bundle: .module)
      }
    }
  }
}
