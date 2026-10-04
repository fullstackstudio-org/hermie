import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// The voice note of an `input.file` request that asks for a recording (`accept: audio`, `capture: audio`,
/// `contract/requests/README.md` §5.1), from the person pressing Record to the upload and the answer.
///
/// - The microphone is not opened, and the system's prompt is not shown, until the person has pressed Record on
///   our sheet (`record()`).
/// - The recording is made on the device, written again into a fresh container with no metadata
///   (`VoiceNoteFile`), shown with its length, and played back before anything is sent. It goes only when the
///   person presses Send (`send(through:)`).
/// - A transcript is made ON THE DEVICE (`VoiceTranscribing`, on-device recognition only) when the device can; it is
///   shown, can be left out, and is sent as `text`. Where the device cannot, the answer has no `text`.
/// - A recording the person picks instead is uploaded as it is (it may carry details of its own, which the sheet
///   says) and is transcribed the same way.
///
/// No microphone, or a refused permission, is said in the sheet; the person may pick a file or tell the bot they
/// cannot (`4041` `no_microphone` / `permission_denied`).
@MainActor
@Observable
public final class InteractiveVoiceModel {
  public enum Phase: Sendable, Equatable {
    /// Nothing asked of the system yet: the sheet offers Record (and picking a file).
    case ready
    /// The system's microphone prompt is up.
    case asking
    case recording
    /// The recording ended and its file is being written.
    case preparing
    /// A note is on hand: recorded or picked, not sent.
    case recorded
    /// The microphone cannot be used.
    case unavailable(Unavailable)
  }

  public enum Unavailable: Sendable, Equatable {
    /// This device has no microphone, or the system would not open it.
    case noMicrophone
    /// The person said no to the microphone (now or earlier).
    case denied

    /// The `cannot_show` reason that tells the bot why.
    public var reason: String {
      switch self {
      case .noMicrophone: CannotShowReason.noMicrophone
      case .denied: CannotShowReason.permissionDenied
      }
    }
  }

  /// What the transcript is, and whether there will be one.
  public enum Transcript: Sendable, Equatable {
    /// This device cannot transcribe on the device: there is none.
    case unavailable
    /// Being made.
    case working
    /// Made.
    case ready(String)
    /// Made, and there was nothing to say (or it failed).
    case empty
  }

  /// A line the sheet shows about what happened to the last recording.
  public enum Notice: Sendable, Equatable {
    /// It ended before it began (under half a second): nothing was kept.
    case tooShort
    /// The recorder failed (a call took the microphone, the input went away).
    case recordingFailed
    /// The file could not be written.
    case unreadable
  }

  public let params: InputFileParams
  public private(set) var phase = Phase.ready
  public private(set) var notice: Notice?
  /// Seconds recorded so far, while recording.
  public private(set) var elapsed = 0.0
  /// The last few levels (0 to 1), oldest first, for a meter.
  public private(set) var levels: [Double] = []
  /// How long the note is, in seconds, once there is one.
  public private(set) var duration: Double?
  public private(set) var transcript = Transcript.unavailable
  /// The transcript goes with the recording (the person can leave it out).
  public var includesTranscript = true
  public private(set) var isPlaying = false
  public private(set) var position = 0.0
  /// The note was picked, not recorded: it goes as it is, and may carry details of its own.
  public private(set) var wasPicked = false

  public let files: InteractiveFileModel

  @ObservationIgnored private let recorder: any VoiceRecording
  @ObservationIgnored private let player: any VoicePlaying
  @ObservationIgnored private let transcriber: any VoiceTranscribing
  @ObservationIgnored private let authorization: any CaptureAuthorizing
  @ObservationIgnored private let hasMicrophone: Bool
  @ObservationIgnored private let language: String?
  @ObservationIgnored private let clock: @Sendable () -> Date
  /// Writes the recording into a fresh container: `VoiceNoteFile.freshCopy`, a seam for the tests.
  @ObservationIgnored private let finisher: @Sendable (URL, URL) async throws -> Void
  @ObservationIgnored private var raw: URL?
  @ObservationIgnored private var working: Task<Void, Never>?
  @ObservationIgnored private var transcribing: Task<Void, Never>?
  /// Bumped by every record, discard and pick: a report for an older note is dropped.
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var speechAllowed = false

  /// The longest note, in seconds.
  public static let maxSeconds = 15.0 * 60
  /// A recording shorter than this is not kept.
  public static let minimumSeconds = 0.5
  /// How many levels `levels` keeps.
  public static let levelCount = 48

  public init(
    params: InputFileParams,
    engines: VoiceNoteEngines = .live,
    language: String? = nil,
    hasMicrophone: Bool = CameraDevices.hasMicrophone,
    clock: @escaping @Sendable () -> Date = { Date() },
    finisher: (@Sendable (URL, URL) async throws -> Void)? = nil
  ) {
    self.params = params
    self.recorder = engines.recorder()
    self.player = engines.player()
    self.transcriber = engines.transcriber()
    self.authorization = engines.authorization()
    self.hasMicrophone = hasMicrophone
    self.language = language
    self.clock = clock
    self.finisher = finisher ?? { source, destination in try await VoiceNoteFile.freshCopy(of: source, to: destination) }
    self.files = InteractiveFileModel(params: params)
  }

  // MARK: - What the sheet reads

  /// The note, once there is one.
  public var note: PickedFile? { files.items.first?.file }

  /// A recording can be started.
  public var canRecord: Bool {
    switch phase {
    case .ready, .unavailable: files.phase == .choosing || files.phase == .failed
    default: false
    }
  }

  /// The note can be sent: there is one, nothing is being written or transcribed, and nothing is on its way.
  public var canSend: Bool {
    guard phase == .recorded, transcript != .working else {
      return false
    }

    return files.phase == .uploaded ? files.canAnswer : files.canUpload
  }

  /// The transcript that goes with the answer: the person's choice, cleaned of the ends, at most 4,000 code points.
  public var transcriptToSend: String? {
    guard includesTranscript, case .ready(let text) = transcript else {
      return nil
    }

    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : Self.bounded(trimmed)
  }

  /// `text` cut to the contract's limit, at the last white space before it when there is one.
  static func bounded(_ text: String) -> String {
    let limit = InteractivePrompt.transcriptLimit

    guard text.unicodeScalars.count > limit else {
      return text
    }

    let cut = ScanValue.prefix(text, scalars: limit)

    if let space = cut.lastIndex(where: { $0.isWhitespace }), cut.distance(from: cut.startIndex, to: space) > limit / 2 {
      return String(cut[..<space]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    return cut
  }

  // MARK: - Recording

  /// The person pressed Record: ask for the microphone when the system has not been asked, then record.
  public func record() async {
    guard canRecord else {
      return
    }

    notice = nil
    discardNote()

    guard hasMicrophone else {
      phase = .unavailable(.noMicrophone)
      return
    }

    // Nothing else can start while a system prompt is up.
    phase = .asking
    let current = generation

    switch authorization.microphoneAccess() {
    case .granted:
      break
    case .denied, .restricted:
      phase = .unavailable(.denied)
      return
    case .notDetermined:
      let granted = await authorization.requestMicrophone()

      guard phase == .asking, current == generation else {
        return
      }

      guard granted else {
        phase = .unavailable(.denied)
        return
      }
    }

    // The recognition permission is asked with the microphone's, as dictation does: refusing it only means there is
    // no transcript. Only where this device could make one.
    speechAllowed = transcriber.isAvailable(language: language) ? await transcriber.requestAuthorization() : false

    guard phase == .asking, current == generation else {
      return
    }

    begin()
  }

  private func begin() {
    do {
      let url = try AttachmentStaging.slot(for: "recording.m4a")
      raw = url
      elapsed = 0
      levels = []
      let current = generation

      recorder.onEvent = { [weak self] event in
        self?.handle(event, generation: current)
      }

      try recorder.start(into: url, maxSeconds: Self.maxSeconds, maxBytes: files.maxBytes)
      phase = .recording
    } catch {
      removeRaw()
      phase = .unavailable(.noMicrophone)
    }
  }

  /// Stop recording and keep what was recorded.
  public func stopRecording() {
    guard phase == .recording else {
      return
    }

    recorder.stop()
  }

  private func handle(_ event: VoiceRecorderEvent, generation reported: Int) {
    guard reported == generation else {
      return
    }

    switch event {
    case .level(let level):
      levels.append(level)

      if levels.count > Self.levelCount {
        levels.removeFirst(levels.count - Self.levelCount)
      }
    case .elapsed(let seconds):
      elapsed = seconds
    case .finished(let seconds):
      finish(seconds: seconds)
    case .failed:
      guard phase == .recording else { return }
      removeRaw()
      phase = .ready
      notice = .recordingFailed
    }
  }

  private func finish(seconds: Double) {
    guard phase == .recording, let source = raw else {
      return
    }

    elapsed = seconds

    guard seconds >= Self.minimumSeconds else {
      removeRaw()
      phase = .ready
      notice = .tooShort
      return
    }

    phase = .preparing
    let current = generation
    let now = clock()
    let finisher = self.finisher

    working = Task { [weak self] in
      let name = InteractiveFileStaging.dated("Voice note", ext: VoiceNoteFile.fileExtension, now: now)
      let written = await Self.writeFresh(from: source, named: name, finisher: finisher)

      guard let written else {
        self?.fail(.unreadable, generation: current)
        return
      }

      self?.take(written, name: name, seconds: seconds, generation: current)
    }
  }

  /// The recording written again into a fresh container in the staging folder, or nil when it could not be (nothing
  /// is left behind then).
  private nonisolated static func writeFresh(
    from source: URL, named name: String, finisher: @Sendable (URL, URL) async throws -> Void
  ) async -> URL? {
    guard let slot = try? AttachmentStaging.slot(for: name) else {
      return nil
    }

    do {
      try await finisher(source, slot)
      return slot
    } catch {
      AttachmentStaging.discard(slot)
      return nil
    }
  }

  private func fail(_ problem: Notice, generation reported: Int) {
    guard reported == generation else {
      return
    }

    removeRaw()
    phase = .ready
    notice = problem
  }

  /// The fresh file is the note.
  private func take(_ file: URL, name: String, seconds: Double, generation reported: Int) {
    guard reported == generation else {
      AttachmentStaging.discard(file)
      return
    }

    removeRaw()

    let picked = PickedFile(
      name: name, mimeType: VoiceNoteFile.mimeType, size: AttachmentStaging.size(of: file) ?? 0, url: file)

    guard files.add(picked) else {
      // Over what the request allows (the rejection says so): nothing is kept.
      phase = .ready
      return
    }

    wasPicked = false
    duration = seconds
    phase = .recorded
    transcribe(file)
  }

  // MARK: - A picked recording

  /// The person chose recordings in Files: the first is the note, as it is. A file that is not audio is refused.
  public func pick(_ urls: [URL]) async {
    guard canRecord, !urls.isEmpty else {
      return
    }

    notice = nil
    discardNote()
    generation += 1
    let current = generation

    await files.importFiles(Array(urls.prefix(1)))

    guard current == generation else {
      return
    }

    guard let item = files.items.first else {
      return
    }

    // Only a recording: `audio/` and a subtype (a file the system cannot name is not one).
    guard InteractivePrompt.isAudioType(item.file.mimeType) else {
      files.discardAll()
      files.noteUnreadable(item.file.name)
      return
    }

    wasPicked = true
    phase = .recorded
    duration = await VoiceNoteFile.duration(of: item.file.url)

    if current == generation {
      transcribe(item.file.url)
    }
  }

  // MARK: - Playback

  public func togglePlayback() {
    if isPlaying {
      player.pause()
      isPlaying = false
      return
    }

    guard let url = note?.url else {
      return
    }

    player.onEvent = { [weak self] event in
      self?.handle(event)
    }

    do {
      try player.play(url)
      isPlaying = true
    } catch {
      isPlaying = false
    }
  }

  private func handle(_ event: VoicePlayerEvent) {
    switch event {
    case .position(let seconds): position = seconds
    case .finished, .failed:
      isPlaying = false
      position = 0
    }
  }

  // MARK: - Transcript

  /// How long the person waits for a transcript before the note can go without one.
  static func patience(for seconds: Double?) -> Duration {
    .seconds(max(10, (seconds ?? 0) * 0.6 + 6))
  }

  private func transcribe(_ file: URL) {
    transcribing?.cancel()

    let language = self.language
    let transcriber = self.transcriber

    guard transcriber.isAvailable(language: language) else {
      transcript = .unavailable
      return
    }

    transcript = .working

    let current = generation
    let patience = Self.patience(for: duration)
    let asked = speechAllowed

    transcribing = Task { [weak self] in
      // A recorded note's permission was asked with the microphone's; a picked file's is asked here (the call
      // answers at once when the person has already decided).
      let allowed = asked ? true : await transcriber.requestAuthorization()

      guard allowed else {
        self?.finishTranscript(nil, generation: current, unavailable: true)
        return
      }

      // The recogniser gets only so long: a note that cannot be transcribed in time goes without a transcript.
      let work = Task { await transcriber.transcribe(file, language: language) }
      let limit = Task {
        try? await Task.sleep(for: patience)
        work.cancel()
      }

      let text = await work.value
      limit.cancel()

      self?.finishTranscript(text, generation: current, unavailable: false)
    }
  }

  private func finishTranscript(_ text: String?, generation reported: Int, unavailable: Bool) {
    guard reported == generation, transcript == .working else {
      return
    }

    if unavailable {
      transcript = .unavailable
    } else if let text, !text.isEmpty {
      transcript = .ready(text)
    } else {
      transcript = .empty
    }
  }

  // MARK: - Sending

  /// Upload the note and say how to answer, or nil when it did not come to that (the person cancelled, or the
  /// upload failed: `files.phase` and `files.failure` say which). A note already on the gateway is not sent twice.
  public func send(through uploader: @escaping InteractiveUploader) async -> InteractiveAnswer? {
    guard canSend else {
      return nil
    }

    player.stop()
    isPlaying = false

    guard let references = await files.upload(through: uploader) else {
      return nil
    }

    return .files(references, text: transcriptToSend)
  }

  /// Stop an upload on its way.
  public func cancelUpload() {
    files.cancel()
  }

  // MARK: - Starting over, going away

  /// Throw the note away and go back to the start (Record again).
  public func startOver() {
    discardNote()
    notice = nil
    phase = .ready
  }

  /// What the note held: stopped, forgotten, deleted. The phase is the caller's.
  private func discardNote() {
    generation += 1
    working?.cancel()
    working = nil
    transcribing?.cancel()
    transcribing = nil
    recorder.cancel()
    player.stop()
    isPlaying = false
    position = 0
    removeRaw()
    files.discardAll()
    duration = nil
    wasPicked = false
    transcript = .unavailable
    elapsed = 0
    levels = []

    if phase == .recorded || phase == .preparing || phase == .recording || phase == .asking {
      phase = .ready
    }
  }

  private func removeRaw() {
    if let raw {
      AttachmentStaging.discard(raw)
    }

    raw = nil
  }

  /// The sheet goes: the microphone and the speaker are released and every file is deleted.
  public func discard() {
    discardNote()
    phase = .ready
  }
}
