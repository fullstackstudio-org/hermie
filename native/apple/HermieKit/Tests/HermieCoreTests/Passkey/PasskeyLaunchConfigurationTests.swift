import Foundation
import HermiePasskeyTesting
import HermieStore
import Testing

@testable import HermieCore

/// A bundle in a fresh temporary directory with the given Info.plist, removed when the test ends.
private final class TemporaryBundle {
  let root: URL
  let bundle: Bundle

  init(info: [String: Any]) throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-bundle-\(UUID().uuidString).app")

    let contents = root.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)

    var plist = info
    plist["CFBundleIdentifier"] = "dev.hermie.tests.\(UUID().uuidString)"
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: contents.appendingPathComponent("Info.plist"))

    bundle = try #require(Bundle(url: root))
  }

  deinit {
    try? FileManager.default.removeItem(at: root)
  }
}

@Suite("Passkey configuration at launch")
struct PasskeyLaunchConfigurationTests {
  @Test(
    "the RP is read from Info.plist, lowercased, and only when it is a host name",
    arguments: [
      ("confirm.hermie.dev", "confirm.hermie.dev"),
      ("  Confirm.Hermie.DEV\n", "confirm.hermie.dev"),
      ("confirm.example-fork.org", "confirm.example-fork.org"),
      ("", nil),
      ("   ", nil),
      ("$(HERMIE_PASSKEY_RP_ID)", nil),
      ("localhost", nil),
      ("https://confirm.hermie.dev", nil),
      ("confirm.hermie.dev/path", nil),
      ("confirm.hermie.dev:443", nil),
      ("-bad.hermie.dev", nil),
      ("bad-.hermie.dev", nil),
      ("confirm..hermie.dev", nil),
      ("confirm.hermie.dev.", nil),
      ("ünïcode.dev", nil),
    ] as [(String, String?)]
  )
  func rpFromInfo(value: String, expected: String?) {
    #expect(PasskeyConfiguration.rpID(fromInfo: [PasskeyConfiguration.rpIDInfoKey: value]) == expected)
  }

  @Test("a missing key or a value that is not text is no RP")
  func missingKey() {
    #expect(PasskeyConfiguration.rpID(fromInfo: [:]) == nil)
    #expect(PasskeyConfiguration.rpID(fromInfo: [PasskeyConfiguration.rpIDInfoKey: 42]) == nil)
    #expect(PasskeyConfiguration.rpID(fromInfo: [PasskeyConfiguration.rpIDInfoKey: ["confirm.hermie.dev"]]) == nil)
  }

  @Test("a label longer than 63 characters is no host name")
  func longLabel() {
    let long = String(repeating: "a", count: 64) + ".dev"

    #expect(!PasskeyConfiguration.isHostName(long))
    #expect(PasskeyConfiguration.isHostName(String(repeating: "a", count: 63) + ".dev"))
  }

  @Test("live() reads the bundle the app was built with")
  func liveFromBundle() throws {
    let built = try TemporaryBundle(info: [PasskeyConfiguration.rpIDInfoKey: "confirm.hermie.dev"])
    let configuration = PasskeyConfiguration.live(bundle: built.bundle)

    #expect(configuration.rpID == "confirm.hermie.dev")
    #expect(configuration.kind == .native)
  }

  @Test("a build with an empty RP gets none, and its sessions never advertise passkey")
  func emptyBuild() throws {
    let built = try TemporaryBundle(info: [PasskeyConfiguration.rpIDInfoKey: ""])

    #expect(PasskeyConfiguration.live(bundle: built.bundle).rpID == nil)
  }

  @MainActor
  @Test("the launch's setup wraps the authenticator for the lock and keeps the pins in the database")
  func liveSetup() async throws {
    let store = try SQLiteStore(.inMemory)
    let keyValues = KeyValueStore(store: store)
    let lock = AppLock(settings: keyValues, authenticator: ScriptedAuthenticator(), forcedLock: false)
    let setup = PasskeySetup.live(
      configuration: PasskeyConfiguration(rpID: "confirm.hermie.dev"),
      authenticator: SoftPasskeyAuthenticator(),
      lock: lock,
      keyValues: keyValues
    )

    #expect(setup.authenticator is LockGuardedPasskeyAuthenticator)
    #expect(setup.pins is KeyValuePasskeyPins)
    #expect(setup.configuration.rpID == "confirm.hermie.dev")
  }
}
