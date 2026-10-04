import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// What the reader decided about voice, and what is written.
@Suite(.timeLimit(.minutes(1))) @MainActor struct VoiceSettingsTests {
  private func open() throws -> KeyValueStore {
    KeyValueStore(store: try SQLiteStore(.inMemory))
  }

  @Test func startsOnTheDefaults() async throws {
    let settings = VoiceSettings(keyValues: try open())
    await settings.hydrate()

    #expect(settings.loaded)
    #expect(settings.rate == 1)
    #expect(settings.dictationLanguage == VoiceSettings.automatic)
    #expect(settings.voiceIdentifier == nil)
    #expect(settings.confirmBeforeSending)
    #expect(settings.stopOnBackground)
    #expect(settings.autoReadChats.isEmpty)
  }

  @Test func everyChoiceSurvivesARelaunch() async throws {
    let keyValues = try open()
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    settings.setRate(1.5)
    settings.setDictationLanguage("nl-NL")
    settings.setVoiceIdentifier("com.apple.voice.compact.nl-NL.Xander")
    settings.setConfirmBeforeSending(false)
    settings.setStopOnBackground(false)
    settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")
    await settings.settled()

    let again = VoiceSettings(keyValues: keyValues)
    await again.hydrate()

    #expect(again.rate == 1.5)
    #expect(again.dictationLanguage == "nl-NL")
    #expect(again.voiceIdentifier == "com.apple.voice.compact.nl-NL.Xander")
    #expect(!again.confirmBeforeSending)
    #expect(!again.stopOnBackground)
    #expect(again.autoRead(bot: "hermes", gatewayID: "g1"))
  }

  @Test func voiceModesChoicesSurviveARelaunchAndAreClamped() async throws {
    let keyValues = try open()
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    #expect(settings.voiceModeSilence == 1.2)
    #expect(settings.voiceModeBargeIn)
    #expect(settings.voiceModeCaptions)
    #expect(settings.voiceModeOrb == .clouds)
    #expect(!settings.voiceModeSetUp)
    #expect(settings.expressivity == 0.5)

    settings.setVoiceModeSilence(9)
    settings.setVoiceModeBargeIn(false)
    settings.setVoiceModeCaptions(false)
    settings.setVoiceModeOrb(.light)
    settings.setVoiceModeSetUp(true)
    settings.setExpressivity(-1)
    await settings.settled()

    let again = VoiceSettings(keyValues: keyValues)
    await again.hydrate()

    #expect(again.voiceModeSilence == 3, "clamped to the longest stop")
    #expect(!again.voiceModeBargeIn)
    #expect(!again.voiceModeCaptions)
    #expect(again.voiceModeOrb == .light)
    #expect(again.voiceModeSetUp)
    #expect(again.expressivity == 0)

    again.reset()
    #expect(again.voiceModeSilence == 1.2)
    #expect(again.voiceModeOrb == .clouds)
    #expect(again.voiceModeSetUp, "having been through the setup is not a choice to reset")
  }

  @Test func theBlobKeepsWhatElseWasInIt() async throws {
    let keyValues = try open()
    try await keyValues.setString(#"{"rate":0.75,"somethingTheExpoAppKeeps":"yes"}"#, forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()
    #expect(settings.rate == 0.75)

    settings.setStopOnBackground(false)
    await settings.settled()

    let stored = try await keyValues.value(JSONObject.self, forKey: StoreKeys.voice)
    #expect(stored?["somethingTheExpoAppKeeps"] == "yes")
    #expect(stored?["stopOnBackground"] == false)
  }

  @Test func aStoredRateIsClampedNotThrownAway() async throws {
    let keyValues = try open()
    try await keyValues.setString(#"{"rate":3}"#, forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()
    #expect(settings.rate == 1.5)

    settings.setRate(.nan)
    #expect(settings.rate == 1, "not a number is no rate at all")
    settings.setRate(0.1)
    #expect(settings.rate == 0.5)
  }

  @Test func whatIsNotALanguageIsTheDevicesOwn() async throws {
    let keyValues = try open()
    try await keyValues.setString(#"{"dictationLanguage":"not a tag!"}"#, forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()
    #expect(settings.dictationLanguage == VoiceSettings.automatic)

    settings.setDictationLanguage("zh-Hans-CN")
    #expect(settings.dictationLanguage == "zh-Hans-CN")
    settings.setDictationLanguage("../etc")
    #expect(settings.dictationLanguage == VoiceSettings.automatic)
  }

  @Test func aChoiceMadeBeforeTheReadFinishedWinsOverWhatWasStored() async throws {
    let keyValues = try open()
    try await keyValues.setString(#"{"rate":0.5}"#, forKey: StoreKeys.voice)

    let settings = VoiceSettings(keyValues: keyValues)
    settings.setRate(1.25)
    await settings.hydrate()

    #expect(settings.rate == 1.25)
  }

  @Test func autoReadKeepsOnlyTheOnes() async throws {
    let keyValues = try open()
    let settings = VoiceSettings(keyValues: keyValues)
    await settings.hydrate()

    settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")
    settings.setAutoRead(true, bot: "other", gatewayID: "g1")
    settings.setAutoRead(false, bot: "hermes", gatewayID: "g1")
    await settings.settled()

    let stored = try await keyValues.value(JSONObject.self, forKey: StoreKeys.voice)
    #expect(stored?["autoReadChats"]?.objectValue?.keys.sorted() == ["other@g1"])
  }

  @Test func resetPutsEverythingBack() async throws {
    let settings = VoiceSettings(keyValues: try open())
    await settings.hydrate()
    settings.setRate(1.5)
    settings.setAutoRead(true, bot: "hermes", gatewayID: "g1")

    settings.reset()
    #expect(settings.rate == 1)
    #expect(settings.autoReadChats.isEmpty)
  }
}
