import Foundation

// What a voice note needs from the platform, behind seams: the system's recorder, player and recogniser in the
// app, fakes in the tests. Nothing above these touches a microphone, a speaker or a speech service.

/// What a recorder reports while it records and when it ends, on the main actor.
public enum VoiceRecorderEvent: Sendable, Equatable {
  /// How loud it is now, 0 (silence) to 1.
  case level(Double)
  /// How long it has recorded, in seconds.
  case elapsed(Double)
  /// It ended, by `stop()` or by reaching its limit; the file holds `seconds` of audio.
  case finished(seconds: Double)
  /// It could not go on (the input went away, a call took the microphone, the disk is full). Whatever was
  /// written is not kept.
  case failed
}

/// What a recorder cannot do.
public enum VoiceRecorderError: Error, Sendable, Equatable {
  /// There is no microphone, or the system would not open it (a call is up).
  case cannotStart
}

/// Records one voice note to a file: AAC in an MP4 container (`audio/mp4`). At most one recording at a time.
@MainActor
public protocol VoiceRecording: AnyObject {
  /// Told as it records; set before `start`.
  var onEvent: (@MainActor (VoiceRecorderEvent) -> Void)? { get set }
  /// Start recording into `url`. The permission has been granted. It stops by itself at `maxSeconds` or when the
  /// file nears `maxBytes`.
  func start(into url: URL, maxSeconds: Double, maxBytes: Int) throws(VoiceRecorderError)
  /// Stop and keep what was recorded: `.finished` follows.
  func stop()
  /// Stop and throw the recording away. Nothing is reported after it.
  func cancel()
}

/// What a player reports.
public enum VoicePlayerEvent: Sendable, Equatable {
  /// Where it is, in seconds.
  case position(Double)
  /// It played to the end.
  case finished
  /// It could not play.
  case failed
}

/// Plays the recording back for the person to hear before they send it.
@MainActor
public protocol VoicePlaying: AnyObject {
  var onEvent: (@MainActor (VoicePlayerEvent) -> Void)? { get set }
  /// Play `url` from the start, or from where `pause()` left off when it is the same file.
  func play(_ url: URL) throws
  func pause()
  /// Stop and forget the file.
  func stop()
}

/// A transcript of a recording, made ON THIS DEVICE: nothing is sent to a speech service, and where the device has
/// no on-device model for the language there is no transcript (never a fallback to a server).
@MainActor
public protocol VoiceTranscribing: AnyObject {
  /// Whether this device can transcribe `language` (a BCP-47 tag, nil for the device's own) without a server.
  func isAvailable(language: String?) -> Bool
  /// The speech recognition permission, asked once. A refusal only means there is no transcript.
  func requestAuthorization() async -> Bool
  /// The words of the file, or nil when there are none or it could not be transcribed.
  func transcribe(_ file: URL, language: String?) async -> String?
}
