import AVFoundation
import Foundation
import Testing

@testable import HermieCore

/// Turning the gateway's audio into PCM buffers: the stream's raw int16, and a file's bytes. No audio is played.
@Suite(.timeLimit(.minutes(1))) struct GatewayAudioDecodingTests {
  @Test func rawPcmBecomesFloatSamplesAtTheStreamsRate() throws {
    guard var stream = GatewayAudioDecoding.PCM16Stream(sampleRate: 24_000, channels: 1) else {
      Issue.record("A 24 kHz mono stream should be accepted.")
      return
    }

    var bytes = Data()

    for sample: Int16 in [0, 16_384, -16_384, 32_767] {
      var little = sample.littleEndian
      withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
    }

    let made = stream.append(bytes)
    let buffer = try #require(made)
    let samples = try #require(buffer.floatChannelData?[0])

    #expect(buffer.format.sampleRate == 24_000)
    #expect(buffer.format.channelCount == 1)
    #expect(buffer.frameLength == 4)
    #expect(samples[0] == 0)
    #expect(abs(samples[1] - 0.5) < 0.0001)
    #expect(abs(samples[2] + 0.5) < 0.0001)
    #expect(samples[3] > 0.999)
  }

  @Test func aFrameThatSplitsASampleCarriesItsOddByteToTheNext() throws {
    guard var stream = GatewayAudioDecoding.PCM16Stream(sampleRate: 16_000, channels: 1) else {
      Issue.record("A 16 kHz mono stream should be accepted.")
      return
    }

    let bytes = AudioFixtures.pcm(frames: 3)

    #expect(stream.append(bytes.prefix(1)) == nil, "half a sample is nothing yet")
    #expect(stream.append(bytes.dropFirst(1).prefix(4))?.frameLength == 2)
    #expect(stream.append(bytes.dropFirst(5))?.frameLength == 1)
  }

  @Test func twoChannelsAreMixedToOne() throws {
    guard var stream = GatewayAudioDecoding.PCM16Stream(sampleRate: 16_000, channels: 2) else {
      Issue.record("A 16 kHz stereo stream should be accepted.")
      return
    }

    var bytes = Data()

    for sample: Int16 in [16_384, -16_384, 16_384, 16_384] {
      var little = sample.littleEndian
      withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
    }

    let made = stream.append(bytes)
    let buffer = try #require(made)
    let samples = try #require(buffer.floatChannelData?[0])

    #expect(buffer.frameLength == 2)
    #expect(abs(samples[0]) < 0.0001)
    #expect(abs(samples[1] - 0.5) < 0.0001)
  }

  @Test func aRateOrChannelCountNoGatewaySendsIsRefused() {
    #expect(GatewayAudioDecoding.PCM16Stream(sampleRate: 0, channels: 1) == nil)
    #expect(GatewayAudioDecoding.PCM16Stream(sampleRate: 1_000_000, channels: 1) == nil)
    #expect(GatewayAudioDecoding.PCM16Stream(sampleRate: 24_000, channels: 6) == nil)
  }

  @Test func aWavFileIsDecodedToBuffersWithEveryFrameInIt() throws {
    let buffers = try GatewayAudioDecoding.decode(AudioFixtures.clip(frames: 40_000))

    #expect(buffers.count == 3, "about a second a buffer: 16 kHz, 40,000 frames")
    #expect(buffers.map { Int($0.frameLength) }.reduce(0, +) == 40_000)
    #expect(buffers[0].format.sampleRate == 16_000)
  }

  @Test func theFileIsNotLeftBehind() throws {
    // A folder of its own: other tests decode into the shared temporary directory at the same time.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-decode-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }

    _ = try GatewayAudioDecoding.decode(AudioFixtures.clip(), directory: folder)

    #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty)
  }

  @Test func bytesThatAreNotAudioAreUnreadable() {
    #expect(throws: GatewayAudioDecoding.DecodeError.unreadable) {
      try GatewayAudioDecoding.decode(GatewayAudioClip(data: Data("OggS but not really".utf8), mimeType: "audio/ogg"))
    }
    #expect(throws: GatewayAudioDecoding.DecodeError.empty) {
      try GatewayAudioDecoding.decode(GatewayAudioClip(data: Data(), mimeType: "audio/mpeg"))
    }
  }

  @Test func theFileExtensionFollowsTheMimeType() {
    #expect(GatewayAudioDecoding.fileExtension(for: "audio/mpeg") == "mp3")
    #expect(GatewayAudioDecoding.fileExtension(for: "audio/wav; charset=x") == "wav")
    #expect(GatewayAudioDecoding.fileExtension(for: "audio/x-m4a") == "m4a")
    #expect(GatewayAudioDecoding.fileExtension(for: "audio/OGG") == "ogg")
    #expect(GatewayAudioDecoding.fileExtension(for: "") == "mp3")
  }
}
