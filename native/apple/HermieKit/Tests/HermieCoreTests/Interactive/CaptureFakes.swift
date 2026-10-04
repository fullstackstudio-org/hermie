import Foundation
import Synchronization

@testable import HermieCore

/// The camera and the microphone as the person left them, counting how often the system was asked.
final class FakeCaptureAuthorization: CaptureAuthorizing {
  struct State: Sendable {
    var camera: CaptureAccess = .notDetermined
    var microphone: CaptureAccess = .notDetermined
    var cameraRequests = 0
    var microphoneRequests = 0
    /// What the person answers when asked.
    var allowCamera = true
    var allowMicrophone = true
  }

  private let state = Mutex(State())

  init(camera: CaptureAccess = .notDetermined, microphone: CaptureAccess = .notDetermined) {
    state.withLock {
      $0.camera = camera
      $0.microphone = microphone
    }
  }

  var snapshot: State { state.withLock { $0 } }

  func set(_ change: (inout State) -> Void) {
    state.withLock { change(&$0) }
  }

  func cameraAccess() -> CaptureAccess { state.withLock { $0.camera } }

  func requestCamera() async -> Bool {
    state.withLock {
      $0.cameraRequests += 1
      $0.camera = $0.allowCamera ? .granted : .denied
      return $0.allowCamera
    }
  }

  func microphoneAccess() -> CaptureAccess { state.withLock { $0.microphone } }

  func requestMicrophone() async -> Bool {
    state.withLock {
      $0.microphoneRequests += 1
      $0.microphone = $0.allowMicrophone ? .granted : .denied
      return $0.allowMicrophone
    }
  }
}

/// A recorder that writes a few bytes when stopped, and says what it is told to.
@MainActor
final class FakeVoiceRecorder: VoiceRecording {
  var onEvent: (@MainActor (VoiceRecorderEvent) -> Void)?
  private(set) var starts: [(url: URL, maxSeconds: Double, maxBytes: Int)] = []
  private(set) var stops = 0
  private(set) var cancels = 0
  /// Starting fails with this.
  var startFailure: VoiceRecorderError?
  /// What the recording holds when it ends.
  var content = Data("AAC".utf8)
  /// How long the finished recording is.
  var seconds = 3.2
  private var url: URL?

  func start(into url: URL, maxSeconds: Double, maxBytes: Int) throws(VoiceRecorderError) {
    if let startFailure {
      throw startFailure
    }

    starts.append((url, maxSeconds, maxBytes))
    self.url = url
  }

  func stop() {
    stops += 1

    if let url {
      try? content.write(to: url)
    }

    onEvent?(.finished(seconds: seconds))
  }

  func cancel() {
    cancels += 1
    onEvent = nil

    if let url {
      try? FileManager.default.removeItem(at: url)
    }

    url = nil
  }

  /// The recorder reports.
  func emit(_ event: VoiceRecorderEvent) {
    onEvent?(event)
  }
}

@MainActor
final class FakeVoicePlayer: VoicePlaying {
  var onEvent: (@MainActor (VoicePlayerEvent) -> Void)?
  private(set) var played: [URL] = []
  private(set) var pauses = 0
  private(set) var stops = 0
  var failure: (any Error)?

  func play(_ url: URL) throws {
    if let failure {
      throw failure
    }

    played.append(url)
  }

  func pause() { pauses += 1 }
  func stop() { stops += 1 }
}

/// A transcriber that says what it is told to, and counts.
@MainActor
final class FakeTranscriber: VoiceTranscribing {
  var available = true
  var authorised = true
  var words: String? = "Tuesday at ten works for me."
  /// Hold the answer until `release()`.
  var holds = false
  private(set) var authorisationRequests = 0
  private(set) var transcribed: [URL] = []
  private var waiting: CheckedContinuation<Void, Never>?
  private var released = false

  func isAvailable(language: String?) -> Bool { available }

  func requestAuthorization() async -> Bool {
    authorisationRequests += 1
    return authorised
  }

  func transcribe(_ file: URL, language: String?) async -> String? {
    transcribed.append(file)

    if holds, !released {
      await withCheckedContinuation { waiting = $0 }
    }

    return words
  }

  /// Let a held transcription go, whether or not it has begun to wait.
  func release() {
    released = true
    waiting?.resume()
    waiting = nil
  }
}

extension VoiceNoteEngines {
  /// Fakes for a sheet's model.
  @MainActor
  static func fakes(
    recorder: FakeVoiceRecorder, player: FakeVoicePlayer, transcriber: FakeTranscriber,
    authorization: FakeCaptureAuthorization
  ) -> VoiceNoteEngines {
    VoiceNoteEngines(
      recorder: { recorder },
      player: { player },
      transcriber: { transcriber },
      authorization: { authorization })
  }
}
