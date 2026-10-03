import Foundation
import Testing

/// The build half of passkeys (plan CP-9): both apps carry the `webcredentials` associated domain
/// from `HERMIE_PASSKEY_RP_ID`, both read it back from Info.plist, an empty RP signs without it, and
/// no extension ever declares it.
@Suite struct PasskeyBuildSettingsTests {
  static let associatedDomains = "com.apple.developer.associated-domains"
  static let apps = ["ios", "macos"]

  /// `native/`.
  static var native: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // Passkey
      .deletingLastPathComponent()  // HermieCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // HermieKit
      .deletingLastPathComponent()  // apple
      .deletingLastPathComponent()
  }

  static func plist(_ relative: String) throws -> [String: Any] {
    let data = try Data(contentsOf: native.appendingPathComponent(relative))
    let value = try PropertyListSerialization.propertyList(from: data, format: nil)

    return try #require(value as? [String: Any], "\(relative) is a dictionary")
  }

  static func text(_ relative: String) throws -> String {
    try String(contentsOf: native.appendingPathComponent(relative), encoding: .utf8)
  }

  /// Every `.entitlements` file of the Apple targets but the two apps' own.
  static func extensionEntitlements() -> [String] {
    let root = native.standardizedFileURL.path + "/"
    var found: [String] = []

    for folder in ["apple", "ios", "macos"] {
      let enumerator = FileManager.default.enumerator(
        at: native.appendingPathComponent(folder), includingPropertiesForKeys: nil)

      while let url = enumerator?.nextObject() as? URL {
        if [".build", "HermieKit"].contains(url.lastPathComponent) || url.pathExtension == "xcodeproj" {
          enumerator?.skipDescendants()
          continue
        }

        guard url.pathExtension == "entitlements" else {
          continue
        }

        let relative = String(url.standardizedFileURL.path.dropFirst(root.count))

        if !relative.hasPrefix("ios/App/"), !relative.hasPrefix("macos/App/") {
          found.append(relative)
        }
      }
    }

    return found.sorted()
  }

  @Test("the shared configuration names the documented RP")
  func rpSetting() throws {
    let lines = try Self.text("apple/Config/Shared.xcconfig").split(separator: "\n").map {
      $0.trimmingCharacters(in: .whitespaces)
    }

    #expect(lines.contains("HERMIE_PASSKEY_RP_ID = confirm.hermie.dev"))
    #expect(lines.contains("HERMIE_ENTITLEMENTS_SUFFIX_ = -NoPasskey"))
    #expect(lines.contains("HERMIE_ENTITLEMENTS_SUFFIX = $(HERMIE_ENTITLEMENTS_SUFFIX_$(HERMIE_PASSKEY_RP_ID))"))
  }

  @Test("both apps declare the webcredentials domain from the setting", arguments: apps)
  func appsDeclareIt(app: String) throws {
    let entitlements = try Self.plist("\(app)/App/Hermie.entitlements")

    #expect(entitlements[Self.associatedDomains] as? [String] == ["webcredentials:$(HERMIE_PASSKEY_RP_ID)"])
  }

  @Test("both apps read the RP from Info.plist", arguments: apps)
  func infoPlistKey(app: String) throws {
    let info = try Self.plist("\(app)/App/Info.plist")

    #expect(info["HermiePasskeyRPID"] as? String == "$(HERMIE_PASSKEY_RP_ID)")
  }

  @Test("an empty RP signs with the same entitlements less the associated domain", arguments: apps)
  func noPasskeyVariant(app: String) throws {
    var full = try Self.plist("\(app)/App/Hermie.entitlements")
    let variant = try Self.plist("\(app)/App/Hermie-NoPasskey.entitlements")

    #expect(variant[Self.associatedDomains] == nil)
    full[Self.associatedDomains] = nil
    #expect(NSDictionary(dictionary: full).isEqual(to: variant))
  }

  @Test("each app target picks its entitlements file by the RP setting", arguments: apps)
  func projectPicksTheFile(app: String) throws {
    let spec = try Self.text("\(app)/project.yml")

    #expect(spec.contains("CODE_SIGN_ENTITLEMENTS: App/Hermie$(HERMIE_ENTITLEMENTS_SUFFIX).entitlements"))
    #expect(spec.contains("- Hermie-NoPasskey.entitlements"), "kept out of the target's sources")
  }

  @Test("no extension declares an associated domain")
  func extensionsDoNot() throws {
    let files = Self.extensionEntitlements()

    #expect(files.count >= 4, "found the widgets' and the share extension's files: \(files)")

    for file in files {
      let entitlements = try Self.plist(file)
      #expect(entitlements[Self.associatedDomains] == nil, "\(file)")
    }
  }
}
