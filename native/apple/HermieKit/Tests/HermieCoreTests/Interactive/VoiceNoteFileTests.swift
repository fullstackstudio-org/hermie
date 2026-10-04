import AVFoundation
import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The file a voice note is uploaded as: a fresh container with no location in it. These use the real AVFoundation on
/// a synthesised recording (no microphone, nothing played).
@Suite("The voice note's file", .timeLimit(.minutes(2)))
struct VoiceNoteFileTests {
  private func folder() throws -> URL {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("voice-note-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
  }

  /// A second of AAC in an MP4 container, as the recorder writes it.
  private func recording(at url: URL, seconds: Double = 1) throws {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
    ]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 1, interleaved: false))
    let frames = AVAudioFrameCount(44_100 * seconds)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames

    for index in 0..<Int(frames) {
      buffer.floatChannelData?[0][index] = Float(sin(Double(index) * 0.05)) * 0.3
    }

    try file.write(from: buffer)
  }

  /// The same recording with a location written into its container, as a phone's camera roll or a recorder app would.
  private func located(from source: URL, to destination: URL) async throws {
    let session = try #require(AVAssetExportSession(asset: AVURLAsset(url: source), presetName: AVAssetExportPresetPassthrough))
    let item = AVMutableMetadataItem()
    item.identifier = .quickTimeMetadataLocationISO6709
    item.value = "+52.3731+004.8922/" as NSString
    item.dataType = "com.apple.metadata.datatype.UTF-8"
    session.metadata = [item]
    try await session.export(to: destination, as: .m4a)
  }

  private func holdsALocation(_ url: URL) throws -> Bool {
    let data = try Data(contentsOf: url)
    return VoiceNoteFile.locationMarkers.contains { data.range(of: $0) != nil }
  }

  @Test("a recording that carries a location is written again without it, and plays the same")
  func locationIsLeftBehind() async throws {
    let folder = try folder()
    defer { try? FileManager.default.removeItem(at: folder) }

    let plain = folder.appendingPathComponent("plain.m4a")
    let tagged = folder.appendingPathComponent("tagged.m4a")
    let fresh = folder.appendingPathComponent("fresh.m4a")
    try recording(at: plain, seconds: 1.5)
    try await located(from: plain, to: tagged)

    // The test would prove nothing if the location were not there to begin with.
    #expect(try holdsALocation(tagged), "the fixture carries a location")
    let metadata = try await AVURLAsset(url: tagged).load(.metadata)
    #expect(metadata.contains { $0.identifier?.rawValue.contains("ISO6709") == true || $0.key as? String == "loci" || $0.keySpace?.rawValue == "uiso" })

    try await VoiceNoteFile.freshCopy(of: tagged, to: fresh)
    #expect(try !holdsALocation(fresh), "no location atom, no location key")

    let after = try await AVURLAsset(url: fresh).load(.metadata)
    #expect(!after.contains { item in
      let id = item.identifier?.rawValue ?? ""
      return id.contains("ISO6709") || id.contains("location") || item.keySpace?.rawValue == "uiso"
    })

    // The sound is the same: the audio was copied, not encoded again.
    let before = try #require(await VoiceNoteFile.duration(of: tagged))
    let seconds = try #require(await VoiceNoteFile.duration(of: fresh))
    #expect(abs(before - seconds) < 0.05 && seconds > 1.4)
    let track = try #require(try await AVURLAsset(url: fresh).loadTracks(withMediaType: .audio).first)
    let formats = try await track.load(.formatDescriptions)
    #expect(formats.first.map { CMFormatDescriptionGetMediaSubType($0) } == kAudioFormatMPEG4AAC)

    // The file is an MP4 container: the bytes of its type.
    let head = try Data(contentsOf: fresh).prefix(12)
    #expect(String(decoding: head.dropFirst(4).prefix(4), as: UTF8.self) == "ftyp")
  }

  @Test("a recording made here, which has no location, is written again all the same and stays whole")
  func plainRecording() async throws {
    let folder = try folder()
    defer { try? FileManager.default.removeItem(at: folder) }

    let plain = folder.appendingPathComponent("plain.m4a")
    let fresh = folder.appendingPathComponent("fresh.m4a")
    try recording(at: plain)
    try await VoiceNoteFile.freshCopy(of: plain, to: fresh)
    #expect(try !holdsALocation(fresh))
    #expect(try #require(await VoiceNoteFile.duration(of: fresh)) > 0.9)
    #expect(FileManager.default.fileExists(atPath: plain.path), "the source is the caller's to delete")
  }

  @Test("a file with no audio in it, or no file at all, is a failure and leaves nothing behind")
  func failures() async throws {
    let folder = try folder()
    defer { try? FileManager.default.removeItem(at: folder) }

    let notAudio = folder.appendingPathComponent("text.m4a")
    try Data("not audio at all".utf8).write(to: notAudio)
    let destination = folder.appendingPathComponent("out.m4a")

    await #expect(throws: VoiceNoteFile.Failure.self) {
      try await VoiceNoteFile.freshCopy(of: notAudio, to: destination)
    }
    #expect(!FileManager.default.fileExists(atPath: destination.path))

    await #expect(throws: VoiceNoteFile.Failure.self) {
      try await VoiceNoteFile.freshCopy(of: folder.appendingPathComponent("missing.m4a"), to: destination)
    }

    #expect(await VoiceNoteFile.duration(of: notAudio) == nil)
    #expect(VoiceNoteFile.mimeType == "audio/mp4" && !VoiceNoteFile.mimeType.contains(";"))
  }

  @Test("through the model: what the recorder wrote, with a location in it, is the clean note that gets staged and sent")
  @MainActor
  func throughTheModel() async throws {
    let folder = try folder()
    defer { try? FileManager.default.removeItem(at: folder) }

    let plain = folder.appendingPathComponent("plain.m4a")
    let tagged = folder.appendingPathComponent("tagged.m4a")
    try recording(at: plain, seconds: 1.2)
    try await located(from: plain, to: tagged)
    #expect(try holdsALocation(tagged))

    let recorder = FakeVoiceRecorder()
    recorder.content = try Data(contentsOf: tagged)
    recorder.seconds = 1.2
    let transcriber = FakeTranscriber()
    transcriber.available = false

    let prompt = try DeviceExamples.prompt("input.file", id: "req_file_voice")
    guard case .file(let params) = prompt.body else { return }

    // The real finisher: nothing is stubbed between the recorder and the staged file.
    let model = InteractiveVoiceModel(
      params: params,
      engines: .fakes(
        recorder: recorder, player: FakeVoicePlayer(), transcriber: transcriber,
        authorization: FakeCaptureAuthorization(microphone: .granted)))

    await model.record()
    model.stopRecording()
    try await eventually("the note") { await model.phase == .recorded }

    let note = try #require(model.note)
    #expect(note.mimeType == "audio/mp4" && note.name.hasSuffix(".m4a"))
    #expect(try !holdsALocation(note.url), "the staged file, the one that is uploaded, has no location")
    #expect(try #require(await VoiceNoteFile.duration(of: note.url)) > 1.1)
    model.discard()
  }
}
