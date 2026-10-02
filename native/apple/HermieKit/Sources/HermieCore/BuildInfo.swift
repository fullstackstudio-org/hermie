import Foundation

/// Which build this is, read from the app's Info.plist.
///
/// The three values are written at build time, never typed by hand:
/// `CFBundleShortVersionString` is `MARKETING_VERSION` from
/// `native/apple/Config/Version.xcconfig`, `CFBundleVersion` is the git commit
/// count and `HermieCommit` the short commit hash, both computed by
/// `native/apple/scripts/generate.sh`. A screenshot of the About line therefore
/// names the exact tree it was taken from.
///
/// A missing or empty key never fails: it reads as the same fallback the build
/// uses when git is unavailable, so a test host or a preview still has
/// something to show.
public struct BuildInfo: Sendable, Equatable {
  public static let commitKey = "HermieCommit"

  public var version: String
  public var build: String
  public var commit: String

  public init(version: String, build: String, commit: String) {
    self.version = version
    self.build = build
    self.commit = commit
  }

  public init(infoDictionary: [String: Any]?) {
    func value(_ key: String, _ fallback: String) -> String {
      guard let text = infoDictionary?[key] as? String else { return fallback }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? fallback : trimmed
    }
    self.init(
      version: value("CFBundleShortVersionString", "0.0.0"),
      build: value("CFBundleVersion", "1"),
      commit: value(Self.commitKey, "dev")
    )
  }

  /// The running app's own values.
  public static var main: BuildInfo {
    BuildInfo(infoDictionary: Bundle.main.infoDictionary)
  }

  /// One line for an About screen: `Version 0.2.0 (512) · 1a2b3c4`.
  public var summary: String {
    "Version \(version) (\(build)) · \(commit)"
  }
}
