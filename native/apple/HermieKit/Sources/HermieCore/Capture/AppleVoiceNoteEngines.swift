import AVFoundation
import Foundation
import Speech

/// The audio session for a voice note: iOS only (the Mac talks to the hardware directly).
enum VoiceNoteAudioSession {
  /// Before the microphone is opened. Throws where the session cannot record (a call is up).
  static func beginRecording() throws {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .default, options: [])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    #endif
  }

  /// Before the recording is played back.
  static func beginPlayback() {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .default, options: [])
      try? session.setActive(true)
    #endif
  }

  /// After either: the audio goes back to whatever was playing.
  static func end() {
    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }
}

/// `AVAudioRecorder`: AAC in an MP4 container at 64 kbit/s, mono, 44.1 kHz. A voice note is speech; this is small
/// (about 8 KB a second) and clear.
@MainActor
public final class AppleVoiceRecorder: NSObject, VoiceRecording, @preconcurrency AVAudioRecorderDelegate {
  public var onEvent: (@MainActor (VoiceRecorderEvent) -> Void)?

  private var recorder: AVAudioRecorder?
  private var meter: Task<Void, Never>?
  /// Bumped by every start and cancel: a report from an older recording is dropped.
  private var session = 0
  private var seconds = 0.0
  private var stopped = false

  /// How often the level and the clock are read.
  private static let interval: Duration = .milliseconds(100)

  public override init() {
    super.init()
  }

  public func start(into url: URL, maxSeconds: Double, maxBytes: Int) throws(VoiceRecorderError) {
    cancel()
    session += 1
    stopped = false
    seconds = 0

    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: 44_100,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 64_000,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
    ]

    do {
      try VoiceNoteAudioSession.beginRecording()

      let recorder = try AVAudioRecorder(url: url, settings: settings)
      recorder.delegate = self
      recorder.isMeteringEnabled = true

      guard recorder.prepareToRecord(), recorder.record() else {
        VoiceNoteAudioSession.end()
        throw VoiceRecorderError.cannotStart
      }

      self.recorder = recorder
    } catch {
      VoiceNoteAudioSession.end()
      throw .cannotStart
    }

    let current = session
    meter = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.interval)

        guard !Task.isCancelled else {
          return
        }

        self?.tick(session: current, maxSeconds: maxSeconds, maxBytes: maxBytes)
      }
    }
  }

  private func tick(session reported: Int, maxSeconds: Double, maxBytes: Int) {
    guard reported == session, let recorder, recorder.isRecording else {
      return
    }

    seconds = recorder.currentTime
    recorder.updateMeters()
    // -50 dB and below is quiet, 0 dB is as loud as it gets.
    let level = min(1, max(0, (Double(recorder.averagePower(forChannel: 0)) + 50) / 50))
    onEvent?(.level(level))
    onEvent?(.elapsed(seconds))

    // A note stops at its time limit, and before the file outgrows what the request allows.
    let size = (try? recorder.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0

    if seconds >= maxSeconds || Double(size) >= Double(maxBytes) * 0.95 {
      stop()
    }
  }

  public func stop() {
    guard let recorder, !stopped else {
      return
    }

    stopped = true
    seconds = max(seconds, recorder.currentTime)
    recorder.stop()
  }

  public func cancel() {
    session += 1
    meter?.cancel()
    meter = nil
    onEvent = nil

    if let recorder {
      recorder.delegate = nil
      recorder.stop()
      recorder.deleteRecording()
      VoiceNoteAudioSession.end()
    }

    recorder = nil
    stopped = false
  }

  // MARK: AVAudioRecorderDelegate

  public func audioRecorderDidFinishRecording(_ finished: AVAudioRecorder, successfully flag: Bool) {
    guard finished === recorder else {
      return
    }

    meter?.cancel()
    meter = nil
    recorder = nil
    VoiceNoteAudioSession.end()
    onEvent?(flag ? .finished(seconds: seconds) : .failed)
  }

  public func audioRecorderEncodeErrorDidOccur(_ finished: AVAudioRecorder, error: (any Error)?) {
    guard finished === recorder else {
      return
    }

    meter?.cancel()
    meter = nil
    recorder = nil
    VoiceNoteAudioSession.end()
    onEvent?(.failed)
  }
}

/// `AVAudioPlayer`, for the recording to be heard before it is sent.
@MainActor
public final class AppleVoicePlayer: NSObject, VoicePlaying, AVAudioPlayerDelegate {
  public var onEvent: (@MainActor (VoicePlayerEvent) -> Void)?

  private var player: AVAudioPlayer?
  private var file: URL?
  private var clock: Task<Void, Never>?

  public override init() {
    super.init()
  }

  public func play(_ url: URL) throws {
    if file != url || player == nil {
      stop()
      let player = try AVAudioPlayer(contentsOf: url)
      player.delegate = self
      guard player.prepareToPlay() else {
        throw VoiceRecorderError.cannotStart
      }

      self.player = player
      file = url
    }

    VoiceNoteAudioSession.beginPlayback()

    guard player?.play() == true else {
      throw VoiceRecorderError.cannotStart
    }

    clock?.cancel()
    clock = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(100))

        if let self, let player = self.player, player.isPlaying {
          self.onEvent?(.position(player.currentTime))
        }
      }
    }
  }

  public func pause() {
    player?.pause()
    clock?.cancel()
    clock = nil
  }

  public func stop() {
    clock?.cancel()
    clock = nil
    player?.delegate = nil
    player?.stop()
    player = nil
    file = nil
    VoiceNoteAudioSession.end()
  }

  public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    clock?.cancel()
    clock = nil
    // The next play starts from the beginning.
    player.currentTime = 0
    onEvent?(flag ? .finished : .failed)
  }

  public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
    onEvent?(.failed)
  }
}

/// `SFSpeechRecognizer` over a file, with `requiresOnDeviceRecognition`: the audio never reaches Apple's speech
/// service (ADR-0022), and a language with no model on the device gets no transcript rather than a server's.
@MainActor
public final class AppleAudioFileTranscriber: VoiceTranscribing {
  public init() {}

  public func isAvailable(language: String?) -> Bool {
    guard let recogniser = AppleSpeechRecognizer.recogniser(for: language) else {
      return false
    }

    return recogniser.isAvailable && recogniser.supportsOnDeviceRecognition
  }

  public func requestAuthorization() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return true
    case .notDetermined: return await Self.authorised()
    default: return false
    }
  }

  private nonisolated static func authorised() async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
  }

  public func transcribe(_ file: URL, language: String?) async -> String? {
    guard SFSpeechRecognizer.authorizationStatus() == .authorized, isAvailable(language: language),
      let recogniser = AppleSpeechRecognizer.recogniser(for: language)
    else {
      return nil
    }

    let request = SFSpeechURLRecognitionRequest(url: file)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true

    let holder = TaskHolder()

    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
        let once = Once(continuation)
        holder.task = recogniser.recognitionTask(with: request) { result, error in
          if let result, result.isFinal {
            let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            once.resume(text.isEmpty ? nil : text)
          } else if error != nil {
            once.resume(nil)
          }
        }
      }
    } onCancel: {
      holder.task?.cancel()
    }
  }

  /// The recognition task, so cancelling the caller cancels it.
  private final class TaskHolder: @unchecked Sendable {
    var task: SFSpeechRecognitionTask?
  }

  /// A continuation resumed once, whichever way the recogniser reports.
  private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String?, Never>?

    init(_ continuation: CheckedContinuation<String?, Never>) {
      self.continuation = continuation
    }

    func resume(_ value: String?) {
      lock.lock()
      let held = continuation
      continuation = nil
      lock.unlock()
      held?.resume(returning: value)
    }
  }
}

/// Where a chat screen gets the recorder, the player and the transcriber of a voice note: the platform's in the
/// app, fakes in the tests. One of each per sheet.
public struct VoiceNoteEngines: Sendable {
  public var recorder: @MainActor @Sendable () -> any VoiceRecording
  public var player: @MainActor @Sendable () -> any VoicePlaying
  public var transcriber: @MainActor @Sendable () -> any VoiceTranscribing
  public var authorization: @Sendable () -> any CaptureAuthorizing

  public init(
    recorder: @escaping @MainActor @Sendable () -> any VoiceRecording,
    player: @escaping @MainActor @Sendable () -> any VoicePlaying,
    transcriber: @escaping @MainActor @Sendable () -> any VoiceTranscribing,
    authorization: @escaping @Sendable () -> any CaptureAuthorizing
  ) {
    self.recorder = recorder
    self.player = player
    self.transcriber = transcriber
    self.authorization = authorization
  }

  /// `AVAudioRecorder`, `AVAudioPlayer`, on-device `SFSpeechRecognizer` and the system's permission prompts.
  public static let live = VoiceNoteEngines(
    recorder: { AppleVoiceRecorder() },
    player: { AppleVoicePlayer() },
    transcriber: { AppleAudioFileTranscriber() },
    authorization: { SystemCaptureAuthorization() }
  )
}
