import Foundation
import HermieShared
import Testing

/// A Debug build is another app to the system (`dev.hermie.app.dev`): its own preferences, sandbox
/// container, App Group and keychain groups, so a dev or test run never touches an installed
/// Hermie. Release keeps the Expo build's `dev.hermie.app`, which the TestFlight archive signs
/// with (`scripts/archive.sh` archives `-configuration Release`).
@Suite struct BundleIdentityTests {
  typealias Files = PasskeyBuildSettingsTests

  @Test("Release is dev.hermie.app, Debug is dev.hermie.app.dev, and the bundle id follows")
  func rootPerConfiguration() throws {
    let lines = try Files.text("apple/Config/Shared.xcconfig").split(separator: "\n").map {
      $0.trimmingCharacters(in: .whitespaces)
    }

    #expect(lines.contains("HERMIE_BUNDLE_ID = dev.hermie.app"))
    #expect(lines.contains("HERMIE_BUNDLE_ID[config=Debug] = dev.hermie.app.dev"))
    #expect(lines.contains("PRODUCT_BUNDLE_IDENTIFIER = $(HERMIE_BUNDLE_ID)"))
    #expect(try Files.text("apple/scripts/archive.sh").contains("-configuration Release"))
  }

  @Test("the app and both extensions take their bundle ids from the root")
  func targetIdentifiers() throws {
    let spec = try Files.text("apple/xcodegen/base.yml")

    #expect(spec.contains("PRODUCT_BUNDLE_IDENTIFIER: $(HERMIE_BUNDLE_ID)\n"))
    #expect(spec.contains("PRODUCT_BUNDLE_IDENTIFIER: $(HERMIE_BUNDLE_ID).widgets\n"))
    #expect(spec.contains("PRODUCT_BUNDLE_IDENTIFIER: $(HERMIE_BUNDLE_ID).share\n"))
    #expect(!spec.contains("PRODUCT_BUNDLE_IDENTIFIER: dev.hermie.app"))
  }

  @Test("no entitlements file names a literal group")
  func entitlementsFollowTheRoot() throws {
    let files = Files.extensionEntitlements() + ["ios", "macos"].flatMap {
      ["\($0)/App/Hermie.entitlements", "\($0)/App/Hermie-NoPasskey.entitlements"]
    }

    for file in files {
      let plist = try Files.plist(file)

      if let groups = plist["com.apple.security.application-groups"] as? [String] {
        #expect(groups == ["group.$(HERMIE_BUNDLE_ID)"], "\(file)")
      }

      for group in plist["keychain-access-groups"] as? [String] ?? [] {
        #expect(group.hasPrefix("$(AppIdentifierPrefix)$(HERMIE_BUNDLE_ID)"), "\(file)")
      }
    }
  }

  @Test("every binary's Info.plist carries the App Group it is entitled to")
  func infoPlistsCarryTheGroup() throws {
    for file in ["ios/App/Info.plist", "macos/App/Info.plist", "apple/Extensions/Widgets/Info.plist",
      "apple/Extensions/Share/Info.plist"]
    {
      #expect(try Files.plist(file)[SharedContainer.appGroupInfoKey] as? String == "group.$(HERMIE_BUNDLE_ID)", "\(file)")
    }

    for app in ["ios", "macos"] {
      let info = try Files.plist("\(app)/App/Info.plist")
      #expect(info["HermieKeychainGroup"] as? String == "$(AppIdentifierPrefix)$(HERMIE_BUNDLE_ID)")
      #expect(info["HermieShareKeychainGroup"] as? String == "$(AppIdentifierPrefix)$(HERMIE_BUNDLE_ID).share")
    }
  }

  @Test("a bundle without the key, or with an unexpanded one, reads the release group")
  func appGroupFallback() {
    #expect(SharedContainer.appGroup(in: Bundle(for: Marker.self)) == SharedContainer.releaseAppGroup)
    #expect(SharedContainer.releaseAppGroup == "group.dev.hermie.app")
  }

  private final class Marker {}
}
