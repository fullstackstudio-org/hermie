import Foundation
import HermieCore

extension NativeStrings {
  /// Voice mode's call screen.
  enum VoiceMode {
    /// Mute (the microphone button)
    static var mute: String { String(localized: "native.voiceMode.mute", table: "Native", bundle: .module) }
    /// Unmute
    static var unmute: String { String(localized: "native.voiceMode.unmute", table: "Native", bundle: .module) }
    /// Muted (the state, said and shown)
    static var muted: String { String(localized: "native.voiceMode.muted", table: "Native", bundle: .module) }
    /// End (the call)
    static var end: String { String(localized: "native.voiceMode.end", table: "Native", bundle: .module) }
    /// Send now (what has been heard, without waiting for the pause)
    static var sendNow: String { String(localized: "native.voiceMode.sendNow", table: "Native", bundle: .module) }
    /// Send (what waits for confirmation)
    static var send: String { String(localized: "native.voiceMode.send", table: "Native", bundle: .module) }
    /// Edit
    static var edit: String { String(localized: "native.voiceMode.edit", table: "Native", bundle: .module) }
    /// Discard
    static var discard: String { String(localized: "native.voiceMode.discard", table: "Native", bundle: .module) }
    /// Send this? (over the words that wait)
    static var confirmTitle: String {
      String(localized: "native.voiceMode.confirmTitle", table: "Native", bundle: .module)
    }
    /// Starting…
    static var starting: String { String(localized: "native.voiceMode.starting", table: "Native", bundle: .module) }
    /// Paused while a request waits for an answer
    static var pausedRequest: String {
      String(localized: "native.voiceMode.pausedRequest", table: "Native", bundle: .module)
    }
    /// Paused (the app was not in front)
    static var paused: String { String(localized: "native.voiceMode.paused", table: "Native", bundle: .module) }
    /// Interrupted by another app (a call, an alarm)
    static var pausedInterruption: String {
      String(localized: "native.voiceMode.pausedInterruption", table: "Native", bundle: .module)
    }
    /// Resume
    static var resume: String { String(localized: "native.voiceMode.resume", table: "Native", bundle: .module) }
    /// Try again
    static var tryAgain: String { String(localized: "native.voiceMode.tryAgain", table: "Native", bundle: .module) }
    /// Voice settings (the glyph top right)
    static var settings: String { String(localized: "native.voiceMode.settings", table: "Native", bundle: .module) }
    /// The microphone or speech recognition is not allowed.
    static var failedPermission: String {
      String(localized: "native.voiceMode.failedPermission", table: "Native", bundle: .module)
    }
    /// No recogniser for this language on this device.
    static var failedUnavailable: String {
      String(localized: "native.voiceMode.failedUnavailable", table: "Native", bundle: .module)
    }
    /// The audio could not be had.
    static var failedAudio: String {
      String(localized: "native.voiceMode.failedAudio", table: "Native", bundle: .module)
    }
    /// The message could not be sent.
    static var failedNotSent: String {
      String(localized: "native.voiceMode.failedNotSent", table: "Native", bundle: .module)
    }
    /// Listening stopped unexpectedly.
    static var failedOther: String {
      String(localized: "native.voiceMode.failedOther", table: "Native", bundle: .module)
    }
  }
}

/// The short lines voice mode says while a bot works quietly, in the reader's language, by kind
/// (`VoiceFillerPolicy` chooses which).
enum VoiceFillerLines {
  /// How many lines each kind has: the keys below, numbered from 1.
  static let counts: [VoiceFillerKind: Int] = [.generic: 3, .search: 2, .reading: 2, .working: 2]

  static func text(_ filler: VoiceFiller) -> String {
    let count = counts[filler.kind] ?? 1
    let number = (filler.variant % max(1, count)) + 1

    switch (filler.kind, number) {
    case (.search, 1): return String(localized: "native.voiceMode.filler.search1", table: "Native", bundle: .module)
    case (.search, _): return String(localized: "native.voiceMode.filler.search2", table: "Native", bundle: .module)
    case (.reading, 1): return String(localized: "native.voiceMode.filler.reading1", table: "Native", bundle: .module)
    case (.reading, _): return String(localized: "native.voiceMode.filler.reading2", table: "Native", bundle: .module)
    case (.working, 1): return String(localized: "native.voiceMode.filler.working1", table: "Native", bundle: .module)
    case (.working, _): return String(localized: "native.voiceMode.filler.working2", table: "Native", bundle: .module)
    case (.generic, 1): return String(localized: "native.voiceMode.filler.generic1", table: "Native", bundle: .module)
    case (.generic, 2): return String(localized: "native.voiceMode.filler.generic2", table: "Native", bundle: .module)
    case (.generic, _): return String(localized: "native.voiceMode.filler.generic3", table: "Native", bundle: .module)
    }
  }
}
