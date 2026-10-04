import Foundation
import Testing

/// The privacy manifests (`PrivacyInfo.xcprivacy`) of the iOS app, the Mac app and the two extensions: each parses,
/// says Hermie does not track, names no tracking domain, and declares only collected data and required-reason
/// APIs of the kinds the app is known to use. (That the files reach each .app and .appex is checked by the app
/// build; see `native/apple/scripts/test.sh --apps`.)
@Suite("Privacy manifests")
struct PrivacyManifestTests {
  private static let root: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    return url
  }()

  private struct Manifest {
    let name: String
    let path: String
    /// The data types the target may collect: the app's, or the share extension's, or none.
    let collected: Set<String>
    let apis: Set<String>
  }

  private static let appKinds: Set<String> = [
    "PreciseLocation", "CoarseLocation", "Contacts", "AudioData", "OtherUserContent", "PhotosorVideos"
  ]

  private static let manifests = [
    Manifest(name: "iOS app", path: "ios/App", collected: appKinds, apis: ["UserDefaults", "FileTimestamp", "SystemBootTime"]),
    Manifest(
      name: "Mac app", path: "macos/App", collected: appKinds.subtracting(["Contacts"]),
      apis: ["UserDefaults", "FileTimestamp", "SystemBootTime"]),
    Manifest(name: "share extension", path: "apple/Extensions/Share", collected: ["OtherUserContent", "PhotosorVideos"], apis: []),
    Manifest(name: "widgets", path: "apple/Extensions/Widgets", collected: [], apis: [])
  ]

  private func load(_ manifest: Manifest) throws -> [String: Any] {
    let url = Self.root.appendingPathComponent("native/\(manifest.path)/PrivacyInfo.xcprivacy")
    let data = try Data(contentsOf: url)
    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
  }

  @Test("no manifest tracks, and none names a tracking domain")
  func noTracking() throws {
    for manifest in Self.manifests {
      let plist = try load(manifest)
      #expect(plist["NSPrivacyTracking"] as? Bool == false, "\(manifest.name)")
      #expect((plist["NSPrivacyTrackingDomains"] as? [Any])?.isEmpty == true, "\(manifest.name)")
    }
  }

  @Test("what is collected is the declared kind, linked, never for tracking, for the app's function alone")
  func collectedData() throws {
    for manifest in Self.manifests {
      let plist = try load(manifest)
      let entries = try #require(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]], "\(manifest.name)")
      let kinds = entries.compactMap { ($0["NSPrivacyCollectedDataType"] as? String)?.replacingOccurrences(of: "NSPrivacyCollectedDataType", with: "") }

      #expect(Set(kinds) == manifest.collected && kinds.count == Set(kinds).count, "\(manifest.name): \(kinds)")

      for entry in entries {
        #expect(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool == true, "\(manifest.name)")
        #expect(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool == false, "\(manifest.name)")
        #expect(
          entry["NSPrivacyCollectedDataTypePurposes"] as? [String] == ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
          "\(manifest.name)")
      }
    }
  }

  @Test("the required-reason APIs are the ones the target's code calls, each with its approved reason")
  func accessedAPIs() throws {
    let reasons = [
      "UserDefaults": "CA92.1", "FileTimestamp": "C617.1", "SystemBootTime": "35F9.1"
    ]

    for manifest in Self.manifests {
      let plist = try load(manifest)
      let entries = try #require(plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]], "\(manifest.name)")
      var seen: Set<String> = []

      for entry in entries {
        let category = try #require(entry["NSPrivacyAccessedAPIType"] as? String)
        let name = category.replacingOccurrences(of: "NSPrivacyAccessedAPICategory", with: "")
        seen.insert(name)
        #expect(entry["NSPrivacyAccessedAPITypeReasons"] as? [String] == reasons[name].map { [$0] }, "\(manifest.name): \(name)")
      }

      #expect(seen == manifest.apis, "\(manifest.name)")
    }
  }
}
