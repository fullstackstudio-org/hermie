import AVFoundation
import Foundation

/**
 The iOS audio session for speaking and for listening. The Mac has none: the app talks to the audio
 hardware directly, so every call here is nothing there.

 Reading aloud plays over what else is playing at a lower volume (`duckOthers`) and gives the audio back
 when it is done; dictation records and gives it back the same way. The two never overlap (the composer
 does not dictate while a reply is read, and reading does not start while it listens), so a plain
 category switch on each start is enough.
 */
enum SpeechAudioSession {
  /// Before something is spoken.
  static func beginPlayback() {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try? session.setActive(true)
    #endif
  }

  /// Before the microphone is opened. Throws where the session cannot be recorded on (a call is up).
  static func beginRecording() throws {
    #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: [])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    #endif
  }

  /// After either: the audio goes back to whatever was playing.
  static func end() {
    #if os(iOS)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }
}
