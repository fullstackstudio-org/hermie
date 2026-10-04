import Foundation

extension NativeStrings {
  /// The files a bot shares: their cards, players and viewers (`Resources/Native.xcstrings`).
  enum Outbox {
    /// No longer available (under a file the gateway has removed)
    static var gone: String { String(localized: "native.outbox.gone", table: "Native", bundle: .module) }
    /// Couldn't load (under a file that could not be fetched)
    static var failed: String { String(localized: "native.outbox.failed", table: "Native", bundle: .module) }
    /// Try again
    static var retry: String { String(localized: "native.outbox.retry", table: "Native", bundle: .module) }
    /// Tap to try again (VoiceOver hint of a picture that could not be loaded)
    static var retryHint: String { String(localized: "native.outbox.retryHint", table: "Native", bundle: .module) }
    /// Too large to open here
    static var tooLarge: String { String(localized: "native.outbox.tooLarge", table: "Native", bundle: .module) }
    /// Save
    static var save: String { String(localized: "native.outbox.save", table: "Native", bundle: .module) }
    /// Couldn't save the file
    static var saveFailed: String { String(localized: "native.outbox.saveFailed", table: "Native", bundle: .module) }
    /// Saves a copy of the file
    static var saveHint: String { String(localized: "native.outbox.saveHint", table: "Native", bundle: .module) }
    /// Share
    static var share: String { String(localized: "native.outbox.share", table: "Native", bundle: .module) }
    /// Close
    static var close: String { String(localized: "native.outbox.close", table: "Native", bundle: .module) }
    /// Downloading
    static var downloading: String { String(localized: "native.outbox.downloading", table: "Native", bundle: .module) }
    /// Downloading, {percent} percent
    static func downloading(percent: Int) -> String {
      String(
        localized: "native.outbox.downloadingPercent",
        defaultValue: "Downloading, \(percent) percent",
        table: "Native",
        bundle: .module
      )
    }
    /// Play
    static var play: String { String(localized: "native.outbox.play", table: "Native", bundle: .module) }
    /// Pause
    static var pause: String { String(localized: "native.outbox.pause", table: "Native", bundle: .module) }
    /// Position (the scrubber of a sound)
    static var position: String { String(localized: "native.outbox.position", table: "Native", bundle: .module) }
    /// Audio, {name}
    static func audio(name: String) -> String {
      String(localized: "native.outbox.audioLabel", defaultValue: "Audio, \(name)", table: "Native", bundle: .module)
    }
    /// Video, {name}
    static func video(name: String) -> String {
      String(localized: "native.outbox.videoLabel", defaultValue: "Video, \(name)", table: "Native", bundle: .module)
    }
    /// PDF document, {name}
    static func pdf(name: String) -> String {
      String(localized: "native.outbox.pdfLabel", defaultValue: "PDF document, \(name)", table: "Native", bundle: .module)
    }
    /// File, {name}
    static func file(name: String) -> String {
      String(localized: "native.outbox.fileLabel", defaultValue: "File, \(name)", table: "Native", bundle: .module)
    }
    /// {count} pages
    static func pages(_ count: Int) -> String {
      String(localized: "native.outbox.pages", defaultValue: "\(count) pages", table: "Native", bundle: .module)
    }
    /// Plays the video full screen
    static var openVideoHint: String {
      String(localized: "native.outbox.openVideoHint", table: "Native", bundle: .module)
    }
    /// Opens the document
    static var openPdfHint: String { String(localized: "native.outbox.openPdfHint", table: "Native", bundle: .module) }
  }
}
