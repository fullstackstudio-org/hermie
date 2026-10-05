import Foundation
import HermieCore
import Observation
import SwiftUI
import Testing

@testable import HermieUI

#if os(macOS)
  import AppKit
#endif

// The Vault page's parts: the route from the chat's menu, the words in three languages, and the Add sheet's
// rule that its secret fields are emptied when the app goes to the background and when the sheet goes. (The
// sheets are hosted in an invisible test window, never shown, never driven by UI automation.)

private let marker = "marker-secret-91c2"

/// A gateway that answers nothing a test here waits for.
private struct QuietVault: VaultBackend {
  func list(profile: String) async throws -> [VaultItem] { [] }
  func sources(profile: String) async throws -> [VaultSource] { [] }
  func add(profile: String, _ request: VaultAddRequest) async throws -> String { "" }
  func remove(profile: String, id: String) async throws -> Bool { false }
  func unlock(profile: String, source: String, password: SecretValue) async throws {}
  func lock(profile: String, source: String?) async throws {}
  func setSourceEnabled(profile: String, source: String, enabled: Bool) async throws {}
}

@MainActor
@Suite("Vault: route and words")
struct VaultViewTests {
  @Test func theChatMenuOpensTheVaultOnceOverTheChat() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: "g0011223344556677", bot: "alice")

    router.showVault(chat)
    router.showVault(chat)

    #expect(router.selectedChat == chat)
    #expect(router.detailPath == [.vault(chat)])
  }

  @Test func eachFailureHasItsOwnSentenceAndAnAddRefusalAsksForTheSecretAgain() {
    let loads = [VaultWords.load(.unsupported), VaultWords.load(.offline), VaultWords.load(.refused)]

    #expect(Set(loads).count == 3)
    #expect(VaultWords.load(.failed("disk full")).contains("disk full"))
    #expect(VaultWords.add(.failed("bad origin")).contains("bad origin"))
    #expect(VaultWords.add(.failed("bad origin")) != NativeStrings.Vault.addFailedNoReason)
    #expect(VaultWords.unlock(.failed("")) == NativeStrings.Vault.unlockFailedNoReason)
    #expect(VaultWords.action(.failed("")) == NativeStrings.Vault.actionFailedNoReason)
  }

  @Test func everyFieldHasALabelOfItsOwn() {
    for kind in VaultKind.allCases {
      for field in VaultSecretField.fields(for: kind) {
        #expect(NativeStrings.Vault.fieldName(field.key) != field.key, "\(field.key)")
      }
    }
  }

  @Test func theBotIsNamedWhereTheVaultIsDescribed() {
    #expect(NativeStrings.Vault.about("Researcher").contains("Researcher"))
    #expect(NativeStrings.Vault.receiver("Researcher").contains("Researcher"))
    #expect(NativeStrings.Vault.addTitle("Researcher").contains("Researcher"))
  }

  @Test(arguments: [
    "native.vault.title", "native.vault.about", "native.vault.empty", "native.vault.loading",
    "native.vault.unsupported", "native.vault.offline", "native.vault.refused", "native.vault.failed",
    "native.vault.actionFailed", "native.vault.actionFailedNoReason", "native.vault.kind", "native.vault.kind.login",
    "native.vault.kind.payment", "native.vault.kind.address", "native.vault.inManager", "native.vault.withOTP",
    "native.vault.add", "native.vault.addTitle", "native.vault.label", "native.vault.labelPrompt",
    "native.vault.site", "native.vault.identifierType", "native.vault.identifier.email",
    "native.vault.identifier.username", "native.vault.identifier.phone", "native.vault.field.password",
    "native.vault.field.otp", "native.vault.field.cardNumber", "native.vault.field.cardholder",
    "native.vault.field.expMonth", "native.vault.field.expYear", "native.vault.field.cvc",
    "native.vault.field.billingPostal", "native.vault.field.line1", "native.vault.field.line2",
    "native.vault.field.city", "native.vault.field.state", "native.vault.field.country", "native.vault.receiver",
    "native.vault.save", "native.vault.saving", "native.vault.addFailed", "native.vault.addFailedNoReason",
    "native.vault.remove", "native.vault.removeTitle", "native.vault.removeMessage", "native.vault.sources",
    "native.vault.sourcesNote", "native.vault.locked", "native.vault.unlocked", "native.vault.notInstalled",
    "native.vault.lock", "native.vault.unlock", "native.vault.use", "native.vault.unlockTitle",
    "native.vault.masterPassword", "native.vault.unlockReceiver", "native.vault.unlockFailed",
    "native.vault.unlockFailedNoReason", "native.vault.unlocking"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test(arguments: ["native.vault.items", "native.vault.field.postalCode"])
  func theSameInDutch(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl"])
  }

  @Test func theTwoBotPlaceholdersAreInEveryLanguage() throws {
    for (language, text) in try nativeTexts("native.vault.about") {
      #expect(text.contains("%1$@") && text.contains("%2$@"), "\(language)")
    }
  }
}

#if os(macOS)
  /// The Add sheet's form with the sheet's rules, hosted with a scene phase a test sets.
  @MainActor @Suite("Vault: the Add sheet's fields", .serialized)
  struct VaultAddSheetRulesTests {
    @MainActor @Observable final class Scene {
      var phase: ScenePhase = .active
      var shown = true
    }

    struct Host: View {
      let scene: Scene
      let model: VaultModel
      let form: VaultAddForm

      var body: some View {
        if scene.shown {
          VaultAddFormView(model: model, form: form, botName: "Researcher", save: {})
            .vaultSecretRules(phase: scene.phase, leftForeground: form.leftForeground, gone: form.clear)
            .frame(width: 460, height: 640)
        }
      }
    }

    private func host(_ scene: Scene, _ form: VaultAddForm) -> NSWindow {
      let view = NSHostingView(
        rootView: Host(scene: scene, model: VaultModel(bot: "researcher", backend: QuietVault()), form: form))
      view.frame = NSRect(x: 0, y: 0, width: 460, height: 640)
      let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = view
      window.orderInForTest()
      return window
    }

    private func filled() -> VaultAddForm {
      let form = VaultAddForm()
      form.label = "Work"
      form.site = "example.com"
      form.identifier = "me@example.com"
      form.setSecret("password", marker)
      form.setSecret("otp_secret", marker)
      return form
    }

    /// Wait for a state SwiftUI reaches on its own; a cap only turns a hang into a failure.
    private func settles(_ condition: () -> Bool) async -> Bool {
      let deadline = ContinuousClock.now + .seconds(30)

      while ContinuousClock.now < deadline {
        if condition() {
          return true
        }

        try? await Task.sleep(for: .milliseconds(20))
      }

      return condition()
    }

    @Test func goingToTheBackgroundEmptiesTheSecretFieldsButNotTheRest() async {
      let scene = Scene()
      let form = filled()
      let window = host(scene, form)
      defer { window.close() }

      // Not in front for a moment (the system's password manager asking for Face ID): nothing is thrown away.
      scene.phase = .inactive
      try? await Task.sleep(for: .milliseconds(200))
      #expect(form.secret("password").revealed == marker)

      scene.phase = .background
      #expect(await settles { form.secretsEmpty })
      #expect(form.label == "Work" && form.identifier == "me@example.com")
    }

    @Test func theSheetGoingEmptiesEverything() async {
      let scene = Scene()
      let form = filled()
      let window = host(scene, form)
      defer { window.close() }

      try? await Task.sleep(for: .milliseconds(100))
      #expect(!form.secretsEmpty)

      scene.shown = false
      #expect(await settles { form.secretsEmpty && form.label.isEmpty && form.identifier.isEmpty })
    }
  }
#endif
