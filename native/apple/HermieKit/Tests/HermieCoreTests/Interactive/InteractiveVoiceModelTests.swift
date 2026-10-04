import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite("The voice note's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveVoiceModelTests {
  /// The model with fakes for the platform, and the fakes.
  private struct Rig {
    let model: InteractiveVoiceModel
    let recorder = FakeVoiceRecorder()
    let player = FakeVoicePlayer()
    let transcriber = FakeTranscriber()
    let authorization: FakeCaptureAuthorization
    let prompt: InteractivePrompt

    @MainActor
    init(
      microphone: CaptureAccess = .notDetermined, hasMicrophone: Bool = true, id: String = "req_file_voice",
      finisher: (@Sendable (URL, URL) async throws -> Void)? = nil
    ) throws {
      authorization = FakeCaptureAuthorization(microphone: microphone)
      prompt = try DeviceExamples.prompt("input.file", id: id)

      guard case .file(let params) = prompt.body else {
        throw DeviceExamples.ReadFailure(method: "input.file")
      }

      model = InteractiveVoiceModel(
        params: params,
        engines: .fakes(recorder: recorder, player: player, transcriber: transcriber, authorization: authorization),
        hasMicrophone: hasMicrophone,
        clock: { Date(timeIntervalSince1970: 1_791_119_310) },
        // The recording is copied as it is: the fake's bytes are not audio a container could be written from.
        finisher: finisher ?? { source, destination in try FileManager.default.copyItem(at: source, to: destination) })
    }

    /// Record and stop, and wait until the note is on hand.
    @MainActor
    func recordANote() async throws {
      await model.record()
      model.stopRecording()
      try await eventually("the note") { await model.phase == .recorded }
    }
  }

  // MARK: The microphone is not opened before Record

  @Test("nothing is asked of the system, and nothing recorded, until the person presses Record; the prompts come only then")
  func askedOnlyOnRecord() async throws {
    let rig = try Rig()
    #expect(rig.model.phase == .ready && rig.model.canRecord)
    #expect(rig.authorization.snapshot.microphoneRequests == 0)
    #expect(rig.transcriber.authorisationRequests == 0)
    #expect(rig.recorder.starts.isEmpty)

    await rig.model.record()
    #expect(rig.authorization.snapshot.microphoneRequests == 1)
    #expect(rig.transcriber.authorisationRequests == 1, "the recognition prompt comes with the microphone's")
    #expect(rig.recorder.starts.count == 1 && rig.model.phase == .recording)
    #expect(!rig.model.canRecord, "no second recording while one runs")
    #expect(rig.recorder.starts.first?.maxBytes == 26_214_400)
    #expect(rig.recorder.starts.first?.maxSeconds == InteractiveVoiceModel.maxSeconds)
  }

  @Test("a microphone already allowed is used without asking; one refused is said, and the person may try again after Settings")
  func permissions() async throws {
    let allowed = try Rig(microphone: .granted)
    await allowed.model.record()
    #expect(allowed.model.phase == .recording && allowed.authorization.snapshot.microphoneRequests == 0)

    let denied = try Rig(microphone: .denied)
    await denied.model.record()
    #expect(denied.model.phase == .unavailable(.denied) && denied.recorder.starts.isEmpty)
    #expect(denied.model.phase == .unavailable(.denied) && InteractiveVoiceModel.Unavailable.denied.reason == "permission_denied")
    #expect(denied.model.canRecord, "the person can press Record again")

    denied.authorization.set { $0.microphone = .granted }
    await denied.model.record()
    #expect(denied.model.phase == .recording)

    let refusing = try Rig()
    refusing.authorization.set { $0.allowMicrophone = false }
    await refusing.model.record()
    #expect(refusing.model.phase == .unavailable(.denied) && refusing.authorization.snapshot.microphoneRequests == 1)
    #expect(refusing.recorder.starts.isEmpty)

    let restricted = try Rig(microphone: .restricted)
    await restricted.model.record()
    #expect(restricted.model.phase == .unavailable(.denied))
  }

  @Test("a device with no microphone, or one the system will not open, says so: no_microphone")
  func noMicrophone() async throws {
    let none = try Rig(hasMicrophone: false)
    await none.model.record()
    #expect(none.model.phase == .unavailable(.noMicrophone))
    #expect(InteractiveVoiceModel.Unavailable.noMicrophone.reason == "no_microphone")
    #expect(none.authorization.snapshot.microphoneRequests == 0, "no prompt for a microphone that is not there")

    let unopenable = try Rig(microphone: .granted)
    unopenable.recorder.startFailure = .cannotStart
    await unopenable.model.record()
    #expect(unopenable.model.phase == .unavailable(.noMicrophone))
  }

  @Test("a microphone that is busy right now (a call is up) is a temporary notice, not no_microphone, and Record works again")
  func microphoneBusy() async throws {
    let rig = try Rig(microphone: .granted)
    rig.recorder.startFailure = .busy
    await rig.model.record()
    #expect(rig.model.phase == .ready && rig.model.notice == .microphoneBusy)
    #expect(rig.model.phase != .unavailable(.noMicrophone), "the bot is not told there is no microphone")

    rig.recorder.startFailure = nil
    await rig.model.record()
    #expect(rig.model.phase == .recording, "once the call is over it records")
  }

  // MARK: Recording

  @Test("a recording becomes a note: shown with its length, played back, and transcribed on the device")
  func recordAndPlay() async throws {
    let rig = try Rig(microphone: .granted)
    rig.recorder.seconds = 42.5
    await rig.model.record()

    rig.recorder.emit(.level(0.4))
    rig.recorder.emit(.elapsed(1.5))
    #expect(rig.model.elapsed == 1.5 && rig.model.levels == [0.4])
    for level in 0..<100 {
      rig.recorder.emit(.level(Double(level) / 100))
    }
    #expect(rig.model.levels.count == InteractiveVoiceModel.levelCount && rig.model.levels.last == 0.99)

    rig.model.stopRecording()
    try await eventually("the note") { await rig.model.phase == .recorded }

    let note = try #require(rig.model.note)
    #expect(note.name.hasPrefix("Voice note 2026-10-"), "named for when it was made")
    #expect(note.name.hasSuffix(".m4a") && note.mimeType == "audio/mp4")
    #expect(rig.model.duration == 42.5 && !rig.model.wasPicked)
    #expect(rig.model.files.items.count == 1)

    // The transcript was made on the device, from the file that will be sent.
    try await eventually("the transcript") { await rig.model.transcript == .ready("Tuesday at ten works for me.") }
    #expect(rig.transcriber.transcribed == [note.url])
    #expect(rig.model.transcriptToSend == "Tuesday at ten works for me.")

    // Playback of that file.
    rig.model.togglePlayback()
    #expect(rig.model.isPlaying && rig.player.played == [note.url])
    rig.player.onEvent?(.position(12))
    #expect(rig.model.position == 12)
    rig.model.togglePlayback()
    #expect(!rig.model.isPlaying && rig.player.pauses == 1)
    rig.model.togglePlayback()
    rig.player.onEvent?(.finished)
    #expect(!rig.model.isPlaying && rig.model.position == 0)
  }

  @Test("a recording too short to keep is dropped with a word, and one the recorder lost is too")
  func tooShortAndFailed() async throws {
    let rig = try Rig(microphone: .granted)
    rig.recorder.seconds = 0.2
    await rig.model.record()
    rig.model.stopRecording()
    #expect(rig.model.phase == .ready && rig.model.notice == .tooShort && rig.model.note == nil)

    rig.recorder.seconds = 5
    await rig.model.record()
    #expect(rig.model.notice == nil, "a new try forgets the old word")
    rig.recorder.emit(.failed)
    #expect(rig.model.phase == .ready && rig.model.notice == .recordingFailed && rig.model.note == nil)
  }

  @Test("the file is written again before it is a note; when that fails nothing is kept and the person is told")
  func finisherFailure() async throws {
    struct Broken: Error {}
    let rig = try Rig(microphone: .granted, finisher: { _, _ in throw Broken() })
    await rig.model.record()
    rig.model.stopRecording()
    try await eventually("the notice") { await rig.model.notice == .unreadable }
    #expect(rig.model.phase == .ready && rig.model.files.items.isEmpty)
  }

  @Test("the recording the recorder wrote is deleted once the fresh file exists, and the fresh one is what is staged")
  func rawIsDeleted() async throws {
    let rig = try Rig(microphone: .granted)
    await rig.model.record()
    let raw = try #require(rig.recorder.starts.first?.url)
    rig.model.stopRecording()
    try await eventually("the note") { await rig.model.phase == .recorded }
    #expect(!FileManager.default.fileExists(atPath: raw.path), "the raw recording is gone")
    let note = try #require(rig.model.note)
    #expect(FileManager.default.fileExists(atPath: note.url.path) && note.url != raw)
  }

  // MARK: The transcript

  @Test("where the device cannot transcribe there is no transcript and the answer has no text")
  func noTranscript() async throws {
    let rig = try Rig(microphone: .granted)
    rig.transcriber.available = false
    try await rig.recordANote()
    #expect(rig.model.transcript == .unavailable && rig.model.transcriptToSend == nil)
    #expect(rig.transcriber.authorisationRequests == 0 && rig.transcriber.transcribed.isEmpty)

    let uploads = RecordingUploader()
    let answer = try #require(await rig.model.send(through: uploads.uploader))
    guard case .files(_, let text) = answer else { return }
    #expect(text == nil)
    #expect(rig.prompt.reply(to: answer)?.result["text"] == nil)
  }

  @Test("a refused recognition permission only means no transcript; the note still goes")
  func recognitionRefused() async throws {
    let rig = try Rig(microphone: .granted)
    rig.transcriber.authorised = false
    try await rig.recordANote()
    try await eventually("the verdict") { await rig.model.transcript == .unavailable }
    #expect(rig.model.canSend)
  }

  @Test("the person can leave the transcript out, and it is cut to the contract's bound")
  func transcriptChoices() async throws {
    let rig = try Rig(microphone: .granted)
    try await rig.recordANote()
    try await eventually("the transcript") { await rig.model.transcript != .working }

    rig.model.includesTranscript = false
    #expect(rig.model.transcriptToSend == nil)
    rig.model.includesTranscript = true
    #expect(rig.model.transcriptToSend != nil)

    let long = (0..<1_200).map { _ in "word" }.joined(separator: " ")
    #expect(InteractiveVoiceModel.bounded(long).unicodeScalars.count <= 4_000)
    #expect(InteractiveVoiceModel.bounded(long).hasSuffix("word"), "cut at a word")
    #expect(InteractiveVoiceModel.bounded("short") == "short")
    #expect(InteractiveVoiceModel.bounded(String(repeating: "x", count: 5_000)).unicodeScalars.count == 4_000)
  }

  @Test("Send waits for the transcript, and an empty one means no text")
  func sendWaitsForTheTranscript() async throws {
    let rig = try Rig(microphone: .granted)
    rig.transcriber.holds = true
    try await rig.recordANote()
    #expect(rig.model.transcript == .working && !rig.model.canSend)

    rig.transcriber.words = nil
    rig.transcriber.release()
    try await eventually("the verdict") { await rig.model.transcript == .empty }
    #expect(rig.model.canSend && rig.model.transcriptToSend == nil)
  }

  // MARK: Sending

  @Test("Send uploads the note flat into the directory as audio/mp4 and answers with the reference and the transcript")
  func send() async throws {
    let rig = try Rig(microphone: .granted)
    try await rig.recordANote()
    try await eventually("the transcript") { await rig.model.transcript != .working }

    let uploads = RecordingUploader()
    let answer = try #require(await rig.model.send(through: uploads.uploader))

    let call = try #require(uploads.calls.first)
    #expect(uploads.calls.count == 1 && call.mime == "audio/mp4" && call.data == rig.recorder.content)
    #expect(call.name.hasSuffix(".m4a"))

    guard case .files(let files, let text) = answer else {
      Issue.record("not a files answer")
      return
    }

    #expect(files.count == 1 && files[0].mime == "audio/mp4" && files[0].bytes == rig.recorder.content.count)
    #expect(text == "Tuesday at ten works for me.")

    let reply = try #require(rig.prompt.reply(to: answer))
    #expect(reply.result["text"] == "Tuesday at ten works for me.")
    #expect(reply.summary == ["status": "answered", "count": 1, "audio": true])
  }

  @Test("an upload that fails is said and can be tried again; nothing is answered meanwhile")
  func failedUpload() async throws {
    let rig = try Rig(microphone: .granted)
    try await rig.recordANote()
    try await eventually("the transcript") { await rig.model.transcript != .working }

    let uploads = RecordingUploader()
    uploads.failEvery(with: "Could not reach the gateway.")
    #expect(await rig.model.send(through: uploads.uploader) == nil)
    #expect(rig.model.files.phase == .failed && rig.model.canSend)

    uploads.failEvery(with: nil)
    #expect(await rig.model.send(through: uploads.uploader) != nil)
  }

  @Test("Record again throws the note away, and leaving deletes every file and releases the microphone and the speaker")
  func startingOverAndLeaving() async throws {
    let rig = try Rig(microphone: .granted)
    try await rig.recordANote()
    let url = try #require(rig.model.note?.url)

    rig.model.startOver()
    #expect(rig.model.phase == .ready && rig.model.note == nil && rig.model.duration == nil)
    #expect(!FileManager.default.fileExists(atPath: url.path))

    try await rig.recordANote()
    let second = try #require(rig.model.note?.url)
    rig.model.discard()
    #expect(rig.model.note == nil && !FileManager.default.fileExists(atPath: second.path))
    #expect(rig.recorder.cancels >= 2 && rig.player.stops >= 2)
  }

  // MARK: Picking a recording instead

  private func audioFile(_ name: String, in folder: URL) throws -> URL {
    let url = folder.appendingPathComponent(name)
    try Data("not really audio".utf8).write(to: url)
    return url
  }

  @Test("a recording chosen in Files goes as it is, is transcribed, and says it was picked; a file that is not audio is refused")
  func picking() async throws {
    let rig = try Rig()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }

    await rig.model.pick([try audioFile("meeting.m4a", in: folder)])
    #expect(rig.model.phase == .recorded && rig.model.wasPicked)
    #expect(rig.model.note?.name == "meeting.m4a" && rig.model.note?.mimeType == "audio/x-m4a")
    #expect(rig.authorization.snapshot.microphoneRequests == 0, "a picked file needs no microphone")
    try await eventually("the transcript") { await rig.model.transcript != .working }
    #expect(rig.model.transcript == .ready("Tuesday at ten works for me."))

    let uploads = RecordingUploader()
    let answer = try #require(await rig.model.send(through: uploads.uploader))
    #expect(uploads.calls.first?.data == Data("not really audio".utf8), "as it is: no stripping, no rewriting")
    #expect(rig.prompt.reply(to: answer) != nil)

    // A picture is not a recording.
    let other = try Rig()
    await other.model.pick([try audioFile("photo.jpg", in: folder)])
    #expect(other.model.phase == .ready && other.model.note == nil)
    #expect(other.model.files.rejection == .unreadable(name: "photo.jpg"))
  }

  @Test("the contract's picked recording, a .caf, is audio too")
  func pickedCaf() async throws {
    let rig = try Rig(id: "req_file_voice_pick")
    #expect(!rig.model.params.asksForRecording)

    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }

    await rig.model.pick([try audioFile("meeting.caf", in: folder)])
    #expect(rig.model.phase == .recorded && rig.model.note?.mimeType == "audio/x-caf")
  }
}
