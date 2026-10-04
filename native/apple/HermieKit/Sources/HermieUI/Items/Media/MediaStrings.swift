import Foundation

extension NativeStrings {
  /// The pictures in messages and the gallery they open (`Resources/Native.xcstrings`).
  enum Media {
    /// Not available (under the name of a picture that could not be shown)
    static var unavailable: String {
      String(localized: "native.media.unavailable", table: "Native", bundle: .module)
    }
    /// {current} of {total} (the gallery's title: which picture of how many)
    static func position(current: Int, total: Int) -> String {
      String(
        localized: "native.media.position",
        defaultValue: "\(current) of \(total)",
        table: "Native",
        bundle: .module
      )
    }
    /// {count} more pictures (what VoiceOver says for the last frame of a message with more pictures
    /// than frames)
    static func more(count: Int) -> String {
      String(
        localized: "native.media.more",
        defaultValue: "\(count) more pictures",
        table: "Native",
        bundle: .module
      )
    }
  }
}
