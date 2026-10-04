import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// What the gateway's speech routes say, read into what the app uses. The gateway's `voice-config` is the
/// desktop's client-direct config: a direct provider's answer carries its API KEY, which must not survive
/// the reading.
@Suite(.timeLimit(.minutes(1))) struct GatewayVoiceConfigTests {
  private func body(_ json: String) throws -> JSONValue {
    try JSONValue(parsing: json)
  }

  @Test func aRelayedProviderIsNamedByItsReason() throws {
    let config = GatewayVoiceConfig.parse(
      try body(#"{"ok":true,"stt":{"mode":"relay","reason":"local provider"},"tts":{"mode":"relay","reason":"provider 'edge' has no client wire"}}"#))

    #expect(config.ttsAvailable)
    #expect(config.provider == "edge")
    #expect(config.providerName == "Edge")
    #expect(config.defaultVoice == nil)
    #expect(!config.voiceSelection)
    #expect(!config.choosesFromList)
  }

  @Test func aDirectProviderIsNamedAndItsVoiceIsTheDefault() throws {
    let config = GatewayVoiceConfig.parse(
      try body(
        #"{"ok":true,"tts":{"mode":"direct","wire":"elevenlabs-tts","provider":"elevenlabs","base_url":"https://api.elevenlabs.io/v1","api_key":"xi-secret-key","model":"m","voice":"voice-rachel","speed":null}}"#
      ))

    #expect(config.provider == "elevenlabs")
    #expect(config.providerName == "ElevenLabs")
    #expect(config.isElevenLabs)
    #expect(config.defaultVoice == "voice-rachel")
  }

  @Test func theApiKeyIsNeverKept() throws {
    let config = GatewayVoiceConfig.parse(
      try body(#"{"ok":true,"tts":{"mode":"direct","provider":"openai","api_key":"sk-leak-me","base_url":"https://api.openai.com/v1","voice":"alloy"}}"#))
    let described = [String(describing: config), String(reflecting: config), "\(config)"].joined(separator: " ")

    #expect(!described.contains("sk-leak-me"))
    #expect(!described.contains("api.openai.com"), "nor the address a key is meant for")
  }

  @Test func aGatewayThatSaysNothingOfTtsCannotSpeak() throws {
    #expect(GatewayVoiceConfig.parse(try body(#"{"ok":true,"stt":{"mode":"relay"}}"#)) == .unavailable)
    #expect(GatewayVoiceConfig.parse(nil) == .unavailable)
    #expect(GatewayVoiceConfig.parse(try body("[1,2]")) == .unavailable)
    #expect(!GatewayVoiceConfig.unavailable.ttsAvailable)
  }

  @Test func clientDirectSwitchedOffStillSpeaksThroughTheRelayWithoutNamingAProvider() throws {
    let config = GatewayVoiceConfig.parse(
      try body(#"{"ok":true,"tts":{"mode":"relay","reason":"voice.client_direct disabled"}}"#))

    #expect(config.ttsAvailable)
    #expect(config.provider == nil)
    #expect(config.providerName == nil)
  }

  @Test func aVoiceIsChosenFromAListOnlyWhenTheGatewayTakesOneWithARequest() throws {
    let shipped = GatewayVoiceConfig.parse(
      try body(#"{"tts":{"mode":"direct","provider":"elevenlabs","voice":"v"}}"#))
    let newer = GatewayVoiceConfig.parse(
      try body(#"{"tts":{"mode":"direct","provider":"elevenlabs","voice":"v","voice_selection":true}}"#))
    let edge = GatewayVoiceConfig.parse(
      try body(
        #"{"tts":{"mode":"relay","reason":"provider 'edge' has no client wire","voice_selection":true,"voices":[{"id":"nl-NL-ColetteNeural","name":"Colette","language":"nl-NL"},{"name":"no id"}]}}"#
      ))
    let edgeWithoutList = GatewayVoiceConfig.parse(
      try body(#"{"tts":{"mode":"relay","reason":"provider 'edge' has no client wire","voice_selection":true}}"#))

    #expect(!shipped.choosesFromList, "a gateway that takes no voice offers none to pick")
    #expect(newer.choosesFromList)
    #expect(edge.choosesFromList)
    #expect(edge.voices == [GatewayVoice(id: "nl-NL-ColetteNeural", name: "Colette", language: "nl-NL")])
    #expect(!edgeWithoutList.choosesFromList, "Edge with no list is the gateway's default")
  }

  @Test func relayedProviderNamesAreReadOutOfReasons() {
    #expect(GatewayVoiceConfig.relayedProvider(in: "provider 'minimax' has no client wire") == "minimax")
    #expect(GatewayVoiceConfig.relayedProvider(in: "command/plugin provider") == nil)
    #expect(GatewayVoiceConfig.relayedProvider(in: "provider '' x") == nil)
    #expect(GatewayVoiceConfig.displayName(of: "someengine") == "Someengine")
  }

  // MARK: The voice list

  @Test func elevenLabsVoicesAreReadWithTheirLabelsClonedOnesIncluded() throws {
    let voices = GatewayVoice.elevenLabsList(
      try body(
        #"{"available":true,"voices":[{"voice_id":"v1","name":"Rachel","label":"Rachel (premade)"},{"voice_id":"v2","name":"Mine","label":"Mine (cloned)"},{"name":"no id"},{"voice_id":"  "}]}"#
      ))

    #expect(voices.map(\.id) == ["v1", "v2"])
    #expect(voices.map(\.label) == ["Rachel (premade)", "Mine (cloned)"])
    #expect(voices[1].name == "Mine")
  }

  @Test func noElevenLabsKeyIsNoVoices() throws {
    #expect(GatewayVoice.elevenLabsList(try body(#"{"available":false,"voices":[],"error":"unauthorized"}"#)).isEmpty)
    #expect(GatewayVoice.elevenLabsList(nil).isEmpty)
  }

  // MARK: One sentence's audio

  @Test func aSpokenSentenceIsADataUrlOfAFile() throws {
    let bytes = Data([1, 2, 3, 4])
    let clip = GatewayAudioClip.parse(
      try body(#"{"ok":true,"data_url":"data:audio/mpeg;base64,\#(bytes.base64EncodedString())","mime_type":"audio/mpeg"}"#))

    #expect(clip == GatewayAudioClip(data: bytes, mimeType: "audio/mpeg"))
  }

  @Test func theMimeTypeComesFromTheUrlWhenTheBodyHasNone() throws {
    let clip = GatewayAudioClip.parse(try body(#"{"data_url":"data:audio/wav;base64,AQID"}"#))

    #expect(clip?.mimeType == "audio/wav")
  }

  @Test func answersThatAreNotAudioAreNotClips() throws {
    #expect(GatewayAudioClip.parse(nil) == nil)
    #expect(GatewayAudioClip.parse(try body(#"{"ok":true}"#)) == nil)
    #expect(GatewayAudioClip.parse(try body(#"{"data_url":"https://example.com/a.mp3"}"#)) == nil)
    #expect(GatewayAudioClip.parse(try body(#"{"data_url":"data:audio/mpeg;base64,"}"#)) == nil)
    #expect(GatewayAudioClip.parse(try body(#"{"data_url":"data:audio/mpeg,plain"}"#)) == nil)
  }

  // MARK: The stream's frames and the request

  @Test func theStreamsTextFramesAreStartEndAndFallback() {
    #expect(LiveGatewaySpeech.event(from: #"{"type":"start","sample_rate":24000,"channels":1}"#) == .start(sampleRate: 24_000, channels: 1))
    #expect(LiveGatewaySpeech.event(from: #"{"type":"end"}"#) == .end)
    #expect(LiveGatewaySpeech.event(from: #"{"type":"fallback"}"#) == .fallback)
    #expect(LiveGatewaySpeech.event(from: #"{"type":"start","sample_rate":0}"#) == nil)
    #expect(LiveGatewaySpeech.event(from: #"{"type":"something new"}"#) == nil)
    #expect(LiveGatewaySpeech.event(from: "not json") == nil)
  }

  @Test func theProfileIsEncodedOnTheQuery() {
    #expect(LiveGatewaySpeech.query(nil) == "")
    #expect(LiveGatewaySpeech.query("") == "")
    #expect(LiveGatewaySpeech.query("researcher") == "?profile=researcher")
    #expect(LiveGatewaySpeech.query("a b&c=d") == "?profile=a%20b%26c%3Dd")
  }
}
