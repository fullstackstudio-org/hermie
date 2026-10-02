import Foundation
import Testing

@testable import HermieCore

@Suite("APNs environment")
struct APNsEnvironmentTests {
  @Test("the decision table", arguments: [
    // entitlement, profile value, profile present, debug build → environment, source
    ("development", nil, true, false, APNsEnvironment.sandbox, APNsEnvironmentDetection.Source.entitlement),
    ("production", "development", true, true, .production, .entitlement),
    (nil, "development", true, false, .sandbox, .profile),
    (nil, "production", true, true, .production, .profile),
    (nil, " Development\n", true, false, .sandbox, .profile),
    (nil, nil, false, true, .production, .noProfile),
    (nil, nil, false, false, .production, .noProfile),
    (nil, nil, true, true, .sandbox, .fallback),
    (nil, nil, true, false, .production, .fallback),
    ("staging", "nonsense", true, false, .production, .fallback)
  ] as [(String?, String?, Bool, Bool, APNsEnvironment, APNsEnvironmentDetection.Source)])
  func resolve(
    entitlement: String?,
    profile: String?,
    present: Bool,
    debug: Bool,
    environment: APNsEnvironment,
    source: APNsEnvironmentDetection.Source
  ) {
    let result = APNsEnvironmentDetection.resolve(
      entitlement: entitlement,
      profileValue: profile,
      profilePresent: present,
      debugBuild: debug
    )

    #expect(result.environment == environment)
    #expect(result.source == source)
  }

  /// A provisioning profile's shape: binary CMS around an XML property list.
  static func profile(entitlements: [String: Any]) throws -> Data {
    let plist = try PropertyListSerialization.data(
      fromPropertyList: ["Name": "Test profile", "Entitlements": entitlements],
      format: .xml,
      options: 0
    )

    return Data([0x30, 0x82, 0x1F, 0x00, 0x06, 0x09]) + plist + Data([0xA0, 0x82, 0x00, 0x3C, 0x00])
  }

  @Test("the entitlement is read out of a profile's envelope")
  func profileParsing() throws {
    let ios = try Self.profile(entitlements: ["aps-environment": "production", "application-identifier": "X.dev.hermie.app"])
    #expect(APNsEnvironmentDetection.profileEntitlement(ios, key: "aps-environment") == "production")

    let mac = try Self.profile(entitlements: ["com.apple.developer.aps-environment": "development"])
    #expect(APNsEnvironmentDetection.profileEntitlement(mac, key: "com.apple.developer.aps-environment") == "development")
    #expect(APNsEnvironmentDetection.profileEntitlement(mac, key: "aps-environment") == nil)

    #expect(APNsEnvironmentDetection.profileEntitlement(Data("garbage".utf8), key: "aps-environment") == nil)
    #expect(APNsEnvironmentDetection.profileEntitlement(Data("<?xml no end".utf8), key: "aps-environment") == nil)
  }

  @Test("a test process has no profile and is not a signed app: production, from the absence of a profile")
  func currentInTests() {
    let result = APNsEnvironmentDetection.current(bundle: Bundle(for: Marker.self))

    #expect(result.source == .noProfile || result.source == .entitlement)
  }

  private final class Marker {}
}
