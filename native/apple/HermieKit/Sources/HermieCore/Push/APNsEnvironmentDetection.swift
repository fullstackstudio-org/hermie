import Foundation

#if os(macOS)
  import Security
#endif

/**
 Which APNs endpoint this build's tokens belong to, read at run time from what the build was signed
 with, so the relay sends each token to the endpoint that issued it.

 The source is the `aps-environment` entitlement as signing set it (the entitlements file says
 `development`; distribution signing replaces it with the profile's value):

 - **macOS**: the running code's own entitlement (`SecTaskCopyValueForEntitlement`), then the
   embedded `Contents/embedded.provisionprofile`.
 - **iOS and iPadOS**: the embedded `embedded.mobileprovision`. App Store and TestFlight builds
   carry none, and they are always production.

 The decision itself is `resolve(…)`, a pure function with a deterministic fallback: a value that
 says `development` is sandbox, one that says `production` is production; with no readable value,
 no profile at all means a store build (production), and a profile that could not be read falls back
 to the build configuration (debug: sandbox, release: production).
 */
public enum APNsEnvironmentDetection {
  /// Where the answer came from, for the developer row.
  public enum Source: String, Sendable, Equatable {
    case entitlement
    case profile
    case noProfile
    case fallback
    /// The iOS Simulator: no profile is embedded, and its tokens are always sandbox ones.
    case simulator
  }

  /// The entitlement key, as a profile and the code signature name it on each platform.
  public static var entitlementKey: String {
    #if os(macOS)
      "com.apple.developer.aps-environment"
    #else
      "aps-environment"
    #endif
  }

  public static func resolve(
    entitlement: String?,
    profileValue: String?,
    profilePresent: Bool,
    debugBuild: Bool
  ) -> (environment: APNsEnvironment, source: Source) {
    if let value = environment(of: entitlement) {
      return (value, .entitlement)
    }

    if let value = environment(of: profileValue) {
      return (value, .profile)
    }

    if !profilePresent {
      return (.production, .noProfile)
    }

    return (debugBuild ? .sandbox : .production, .fallback)
  }

  /// `development` → sandbox, `production` → production, anything else → nil.
  static func environment(of value: String?) -> APNsEnvironment? {
    switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "development": .sandbox
    case "production": .production
    default: nil
    }
  }

  /// This process's answer.
  public static func current(bundle: Bundle = .main) -> (environment: APNsEnvironment, source: Source) {
    #if targetEnvironment(simulator)
      // Read as "no profile" this would be production, and every sandbox token the Simulator hands
      // out would be refused by APNs and re-registered daily.
      return (.sandbox, .simulator)
    #else
      return detected(bundle: bundle)
    #endif
  }

  private static func detected(bundle: Bundle) -> (environment: APNsEnvironment, source: Source) {
    let profile = profileData(bundle: bundle)

    #if DEBUG
      let debug = true
    #else
      let debug = false
    #endif

    return resolve(
      entitlement: signedEntitlement(),
      profileValue: profile.flatMap { profileEntitlement($0, key: entitlementKey) },
      profilePresent: profile != nil,
      debugBuild: debug
    )
  }

  /**
   The value of one entitlement in a provisioning profile: a CMS envelope around an XML property
   list. The plist is cut out by its markers and parsed; the signature is not checked, since the
   system already verified the profile before the app could launch.
   */
  public static func profileEntitlement(_ data: Data, key: String) -> String? {
    guard let start = data.range(of: Data("<?xml".utf8)),
      let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
    else {
      return nil
    }

    let plist = data[start.lowerBound..<end.upperBound]

    guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
      let entitlements = root["Entitlements"] as? [String: Any]
    else {
      return nil
    }

    return entitlements[key] as? String
  }

  private static func profileData(bundle: Bundle) -> Data? {
    #if os(macOS)
      let url = bundle.bundleURL.appendingPathComponent("Contents/embedded.provisionprofile")
    #else
      guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision") else {
        return nil
      }
    #endif

    return try? Data(contentsOf: url)
  }

  private static func signedEntitlement() -> String? {
    #if os(macOS)
      guard let task = SecTaskCreateFromSelf(nil),
        let value = SecTaskCopyValueForEntitlement(task, entitlementKey as CFString, nil)
      else {
        return nil
      }

      return value as? String
    #else
      // The code signature's entitlements cannot be read from inside an iOS app; the profile is the source.
      return nil
    #endif
  }
}
