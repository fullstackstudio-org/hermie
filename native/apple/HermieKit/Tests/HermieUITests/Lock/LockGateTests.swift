import HermieCore
import HermieStore
import SwiftUI
import Testing

@testable import HermieUI

@MainActor
private func launch(lock text: String? = nil, authenticator: ScriptedAuthenticator = ScriptedAuthenticator()) async throws
  -> AppLaunch
{
  let launch = AppLaunch(environment: LaunchEnvironment(dataDirectory: nil, authenticator: authenticator))

  if let text {
    try await launch.keyValues.setString(text, forKey: StoreKeys.lock)
  }

  return launch
}

@MainActor
@Suite("Lock gate")
struct LockGateTests {
  @Test("draws nothing until the setting is read, then the plate, then the content once unlocked")
  func faces() async throws {
    let launch = try await launch(lock: #"{"threshold":"5m"}"#)

    #expect(LockGate<EmptyView>.face(for: launch.lock) == .pending)

    await launch.start()
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .plate)

    await launch.lock.unlock(reason: "test")
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .content)
  }

  @Test("with no lock the gate goes straight from nothing to the content, never the plate")
  func noLock() async throws {
    let launch = try await launch()

    #expect(LockGate<EmptyView>.face(for: launch.lock) == .pending)
    await launch.start()
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .content)
  }

  @Test("an unreadable setting shows the plate, not the content")
  func unreadable() async throws {
    let launch = try await launch(lock: "{")

    await launch.start()
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .plate)
  }

  @Test("the cover is drawn whenever a configured lock's window is not in front")
  func coverPolicy() {
    #expect(PrivacyCoverPolicy.covers(phase: .inactive, lockConfigured: true))
    #expect(PrivacyCoverPolicy.covers(phase: .background, lockConfigured: true))
    #expect(!PrivacyCoverPolicy.covers(phase: .active, lockConfigured: true))
    #expect(!PrivacyCoverPolicy.covers(phase: .inactive, lockConfigured: false))
  }

  @Test("the threshold page explains a refusal, and an unknown setting")
  func footer() async throws {
    let open = try await launch()

    await open.start()

    #expect(LockThresholdPage.footer(refusal: nil, lock: open.lock) == Strings.App.Settings.Lock.hint)
    #expect(LockThresholdPage.footer(refusal: .refused, lock: open.lock) == Strings.App.Settings.Lock.refused)
    #expect(LockThresholdPage.footer(refusal: .noEnrolment(.none), lock: open.lock) == Strings.App.Settings.Lock.noEnrolment)
    #expect(
      LockThresholdPage.footer(refusal: .noEnrolment(.unavailable), lock: open.lock)
        == Strings.App.Settings.Lock.unavailable
    )

    let unknown = try await launch(lock: "{")

    await unknown.start()
    #expect(LockThresholdPage.footer(refusal: nil, lock: unknown.lock) == NativeStrings.Lock.settingUnknown)
  }

  @Test("the plate, the cover and Settings render")
  func renders() async throws {
    let launch = try await launch(lock: #"{"threshold":"1m"}"#)

    await launch.start()

    for view in [
      AnyView(LockPlate(lock: launch.lock)),
      AnyView(PrivacyCoverView()),
      AnyView(SettingsView(onAddGateway: {}).environment(launch))
    ] {
      let renderer = ImageRenderer(content: view.frame(width: 390, height: 600))

      #expect(renderer.cgImage != nil)
    }
  }

  @Test("every native string has English, Dutch and German, and the accessors resolve")
  func nativeStrings() throws {
    let bundle = HermieStringsLookup.bundle
    var keys: [String: Set<String>] = [:]

    for language in ["en", "nl", "de"] {
      let path = try #require(bundle.path(forResource: language, ofType: "lproj"))
      let table = try #require(Bundle(path: path)?.path(forResource: "Native", ofType: "strings"))
      let entries = try #require(NSDictionary(contentsOfFile: table) as? [String: String])

      keys[language] = Set(entries.keys)
    }

    #expect(keys["en"]?.isEmpty == false)
    #expect(keys["en"] == keys["nl"])
    #expect(keys["en"] == keys["de"])
    #expect(NativeStrings.later != "native.later")
    #expect(NativeStrings.Notice.gatewayNotConfigured != "native.notice.gatewayNotConfigured")
  }
}
