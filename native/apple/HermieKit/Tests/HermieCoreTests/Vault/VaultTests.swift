import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

// A bot's vault: what goes on the wire for each call (always with the bot's profile), that a listing never
// brings a secret into the app, and that a secret typed into the Add or Unlock form is sent once and kept
// nowhere, whatever the gateway answers. Every secret here is a harmless marker.

private let bot = "researcher"
private let marker = "marker-secret-7f3a"

/// Whether `value` holds `marker` anywhere it can be reached by reflection, including inside a `SecretValue`
/// or a `VaultAddRequest` (whose mirrors are redacted on purpose, so they are opened here). A `VaultBackend` is
/// skipped: here it is the test's own stub, which records what reached "the gateway".
///
/// What reflection cannot reach is out of this check: SwiftUI's own copy of a field's text, and the copy a
/// task holds while a call is on its way (the tests that look during the call check the form instead).
private func holds(_ marker: String, in value: Any, depth: Int = 0) -> Bool {
  guard depth < 16, !(value is any VaultBackend) else {
    return false
  }

  if let text = value as? String {
    return text.contains(marker)
  }

  if let secret = value as? SecretValue {
    return secret.revealed.contains(marker)
  }

  if let request = value as? VaultAddRequest {
    return request.secret.values.contains { $0.revealed.contains(marker) }
  }

  return Mirror(reflecting: value).children.contains { holds(marker, in: $0.value, depth: depth + 1) }
}

/// The gateway's side of the vault calls, scripted, recording what reached it.
final class StubVault: VaultBackend, Sendable {
  private struct State {
    var items: [VaultItem] = []
    var sources: [VaultSource] = []
    var added: [VaultAddRequest] = []
    var unlocked: [(source: String, password: String)] = []
    var removed: [String] = []
    var locked: [String?] = []
    var switched: [(String, Bool)] = []
    var lists = 0
    var addError: (any Error)?
    var unlockError: (any Error)?
    var removeAnswer = true
    var actionError: (any Error)?
    var listError: (any Error)?
  }

  private let state = Mutex(State())
  /// Runs inside `add`/`unlock` before they answer: a test's look at the app while the secret is on its way.
  let during: (@Sendable () async -> Void)?

  init(during: (@Sendable () async -> Void)? = nil) {
    self.during = during
  }

  var added: [VaultAddRequest] { state.withLock { $0.added } }
  var unlocked: [(source: String, password: String)] { state.withLock { $0.unlocked } }
  var removed: [String] { state.withLock { $0.removed } }
  var locked: [String?] { state.withLock { $0.locked } }
  var switched: [(String, Bool)] { state.withLock { $0.switched } }
  var lists: Int { state.withLock { $0.lists } }

  func set(items: [VaultItem]) { state.withLock { $0.items = items } }
  func set(sources: [VaultSource]) { state.withLock { $0.sources = sources } }
  func failAdd(_ error: (any Error)?) { state.withLock { $0.addError = error } }
  func failUnlock(_ error: (any Error)?) { state.withLock { $0.unlockError = error } }
  func failActions(_ error: (any Error)?) { state.withLock { $0.actionError = error } }
  func failList(_ error: (any Error)?) { state.withLock { $0.listError = error } }
  func answerRemove(_ removed: Bool) { state.withLock { $0.removeAnswer = removed } }

  func list(profile: String) async throws -> [VaultItem] {
    try state.withLock { state in
      state.lists += 1
      if let error = state.listError { throw error }
      return state.items
    }
  }

  func sources(profile: String) async throws -> [VaultSource] {
    state.withLock { $0.sources }
  }

  func add(profile: String, _ request: VaultAddRequest) async throws -> String {
    state.withLock { $0.added.append(request) }
    await during?()

    if let error = state.withLock({ $0.addError }) {
      throw VaultFailure.classify(error, scrubbing: request.secretTexts)
    }

    return "vault_1"
  }

  func remove(profile: String, id: String) async throws -> Bool {
    try state.withLock { state in
      state.removed.append(id)
      if let error = state.actionError { throw error }
      return state.removeAnswer
    }
  }

  func unlock(profile: String, source: String, password: SecretValue) async throws {
    state.withLock { $0.unlocked.append((source, password.revealed)) }
    await during?()

    if let error = state.withLock({ $0.unlockError }) {
      throw VaultFailure.classify(error, scrubbing: [password.revealed])
    }
  }

  func lock(profile: String, source: String?) async throws {
    try state.withLock { state in
      state.locked.append(source)
      if let error = state.actionError { throw error }
    }
  }

  func setSourceEnabled(profile: String, source: String, enabled: Bool) async throws {
    try state.withLock { state in
      state.switched.append((source, enabled))
      if let error = state.actionError { throw error }
    }
  }
}

private func manager(unlocked: Bool = false, enabled: Bool = true) -> VaultSource {
  VaultSource(
    name: "bitwarden", displayName: "Bitwarden", enabled: enabled, needsUnlock: true, unlocked: unlocked,
    installed: true)
}

private func refusal(_ message: String, code: Int = 5095) -> GatewayRPCError {
  GatewayRPCError(.rejected, message, code: code)
}

// MARK: - The wire

@Suite("Vault on the wire") struct VaultWireTests {
  private func service() -> (VaultService, ScriptedLink) {
    let link = ScriptedLink()
    link.respond(to: "vault.list", with: .object(["items": .array([])]))
    link.respond(to: "vault.sources", with: .object(["sources": .array([])]))
    link.respond(to: "vault.add", with: .object(["id": .string("vault_abc")]))
    link.respond(to: "vault.remove", with: .object(["removed": .bool(true)]))
    link.respond(to: "vault.unlock", with: .object(["name": .string("bitwarden"), "unlocked": .bool(true)]))
    link.respond(to: "vault.lock", with: .object(["locked": .bool(true)]))
    link.respond(to: "vault.source.set", with: .object(["name": .string("bitwarden"), "enabled": .bool(false)]))
    return (VaultService(link: link), link)
  }

  @Test func listAndSourcesNameTheBotsProfileAndNothingElse() async throws {
    let (service, link) = service()

    _ = try await service.list(profile: bot)
    _ = try await service.sources(profile: bot)

    #expect(link.calls.map(\.method) == ["vault.list", "vault.sources"])
    #expect(link.calls.map(\.params) == [.object(["profile": .string(bot)]), .object(["profile": .string(bot)])])
  }

  @Test func aLoginIsAddedWithItsIdentifierInsideTheSecretAndTheBotsProfile() async throws {
    let (service, link) = service()
    let request = VaultAddRequest(
      kind: .login, label: "Work", origin: "https://example.com", identifierType: .username, identifier: "me",
      secret: ["password": SecretValue(marker), "otp_secret": SecretValue()])

    let id = try await service.add(profile: bot, request)

    #expect(id == "vault_abc")
    #expect(link.calls(VaultService.Method.add).count == 1)
    #expect(
      link.calls.first?.params
        == .object([
          "profile": .string(bot),
          "kind": .string("login"),
          "label": .string("Work"),
          "origin": .string("https://example.com"),
          "secret": .object([
            "password": .string(marker),
            "identifier_type": .string("username"),
            "identifier": .string("me")
          ])
        ]))
  }

  @Test func aCardIsAddedWithItsOwnFieldsAndNoIdentifier() async throws {
    let (service, link) = service()
    let request = VaultAddRequest(
      kind: .payment, label: "Card", origin: nil, identifierType: .email, identifier: "ignored",
      secret: ["card_number": SecretValue(marker), "cvc": SecretValue("m-1")])

    _ = try await service.add(profile: bot, request)

    #expect(
      link.calls.first?.params
        == .object([
          "profile": .string(bot),
          "kind": .string("payment"),
          "label": .string("Card"),
          "secret": .object(["card_number": .string(marker), "cvc": .string("m-1")])
        ]))
  }

  @Test func removeUnlockLockAndTheSwitchEachNameTheBotsProfile() async throws {
    let (service, link) = service()

    #expect(try await service.remove(profile: bot, id: "vault_1"))
    try await service.unlock(profile: bot, source: "bitwarden", password: SecretValue(marker))
    try await service.lock(profile: bot, source: "bitwarden")
    try await service.lock(profile: bot, source: nil)
    try await service.setSourceEnabled(profile: bot, source: "bitwarden", enabled: false)

    #expect(
      link.calls.map(\.method) == ["vault.remove", "vault.unlock", "vault.lock", "vault.lock", "vault.source.set"])
    #expect(
      link.calls.map(\.params) == [
        .object(["profile": .string(bot), "id": .string("vault_1")]),
        .object(["profile": .string(bot), "name": .string("bitwarden"), "password": .string(marker)]),
        .object(["profile": .string(bot), "name": .string("bitwarden")]),
        .object(["profile": .string(bot)]),
        .object(["profile": .string(bot), "name": .string("bitwarden"), "enabled": .bool(false)])
      ])
    // The secret went out exactly once, in the unlock.
    #expect(link.calls.filter { holds(marker, in: $0.params) }.map(\.method) == ["vault.unlock"])
  }

  @Test func aRefusalIsSortedAndItsWordsAreScrubbedOfWhatWasSent() async {
    let link = ScriptedLink()
    link.refuse("vault.add") { _ in refusal("could not store \(marker) for you") }
    link.refuse("vault.unlock") { _ in refusal("bad password \(marker)") }
    link.refuse("vault.list") { _ in refusal("unknown method: vault.list", code: -32601) }
    link.refuse("vault.lock") { _ in refusal("agents may not lock", code: 4033) }
    let service = VaultService(link: link)

    await #expect(throws: VaultFailure.failed("could not store [REDACTED] for you")) {
      _ = try await service.add(
        profile: bot,
        VaultAddRequest(kind: .login, label: "x", origin: "https://x.example", secret: ["password": SecretValue(marker)]))
    }
    await #expect(throws: VaultFailure.failed("bad password [REDACTED]")) {
      try await service.unlock(profile: bot, source: "bitwarden", password: SecretValue(marker))
    }
    await #expect(throws: VaultFailure.unsupported) { _ = try await service.list(profile: bot) }
    await #expect(throws: VaultFailure.refused) { try await service.lock(profile: bot, source: nil) }
  }

  @Test func noConnectionIsOffline() async {
    let link = ScriptedLink()
    await link.shutdown()

    await #expect(throws: VaultFailure.offline) { _ = try await VaultService(link: link).list(profile: bot) }
  }
}

// MARK: - What a listing carries

@Suite("A vault listing") struct VaultListingTests {
  @Test func aRowKeepsItsMetadataAndNothingElseEvenWhenTheGatewaySentMore() {
    let result: JSONValue = .object([
      "items": .array([
        .object([
          "id": .string("vault_1"), "kind": .string("login"), "label": .string("Work"),
          "origin": .string("https://example.com"), "identifier": .string("me@example.com"),
          "identifier_type": .string("email"), "has_otp": .bool(true), "backend": .string("local"),
          // A gateway that put a secret in a row by mistake.
          "secret": .object(["password": .string(marker)]), "password": .string(marker),
          "card_number": .string(marker)
        ]),
        .object(["kind": .string("login"), "label": .string("no id")])
      ])
    ])

    let items = VaultItem.parseList(result)

    #expect(items.count == 1)
    #expect(items.first == VaultItem(
      id: "vault_1", kind: "login", label: "Work", origin: "https://example.com", identifier: "me@example.com",
      identifierType: "email", hasOTP: true, backend: "local"))
    #expect(!holds(marker, in: items))
    #expect(!String(reflecting: items).contains(marker))
  }

  @Test @MainActor func aLoadedModelHoldsNoSecretFromTheList() async {
    let link = ScriptedLink()
    link.respond(
      to: "vault.list",
      with: .object([
        "items": .array([
          .object([
            "id": .string("vault_1"), "kind": .string("login"), "label": .string("Work"),
            "backend": .string("local"), "secret": .object(["password": .string(marker)])
          ])
        ])
      ]))
    link.respond(to: "vault.sources", with: .object(["sources": .array([])]))
    let model = VaultModel(bot: bot, backend: VaultService(link: link))

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.items.map(\.id) == ["vault_1"])
    #expect(!holds(marker, in: model.items))
    #expect(!holds(marker, in: model))
  }

  @Test func sourcesAreRead() {
    let sources = VaultSource.parseList(
      .object([
        "sources": .array([
          .object([
            "name": .string("local"), "display_name": .string("Hermes vault"), "enabled": .bool(true),
            "needs_unlock": .bool(false), "unlocked": .bool(true), "installed": .bool(true)
          ]),
          .object([
            "name": .string("bitwarden"), "display_name": .string("Bitwarden"), "enabled": .bool(true),
            "needs_unlock": .bool(true), "unlocked": .bool(false), "installed": .bool(true)
          ])
        ])
      ]))

    #expect(sources.map(\.name) == ["local", "bitwarden"])
    #expect(sources[1] == manager())
  }

  @Test func aBareSiteGetsAScheme() {
    #expect(VaultOrigin.normalized(" example.com ") == "https://example.com")
    #expect(VaultOrigin.normalized("http://intranet:8080") == "http://intranet:8080")
    #expect(VaultOrigin.normalized("  ").isEmpty)
  }

  @Test func aRequestDescribesItselfWithoutItsSecret() {
    let request = VaultAddRequest(kind: .login, label: "Work", origin: nil, secret: ["password": SecretValue(marker)])

    #expect(!String(describing: request).contains(marker))
    #expect(!String(reflecting: request).contains(marker))
    var dumped = ""
    dump(request, to: &dumped)
    #expect(!dumped.contains(marker))
  }
}

// MARK: - Adding

@Suite("Adding to a vault") @MainActor struct VaultAddTests {
  private func filled(_ form: VaultAddForm) {
    form.kind = .login
    form.label = "Work"
    form.site = "example.com"
    form.identifierType = .email
    form.identifier = "me@example.com"
    form.setSecret("password", marker)
  }

  @Test func saveSendsTheSecretOnceAndTheFormIsEmptyBeforeTheCallStarts() async {
    let form = VaultAddForm()
    let seen = Mutex<Bool?>(nil)
    let backend = StubVault {
      let empty = await MainActor.run { form.secretsEmpty }
      seen.withLock { $0 = empty }
    }
    let model = VaultModel(bot: bot, backend: backend)
    filled(form)

    #expect(await form.submit(to: model))

    #expect(seen.withLock { $0 } == true, "the secret was out of the form while it was on its way")
    #expect(backend.added.count == 1)
    #expect(backend.added.first?.secret["password"]?.revealed == marker)
    #expect(backend.added.first?.origin == "https://example.com")
    #expect(backend.added.first?.identifier == "me@example.com")
    // Stored: the whole form is empty, and the list was read again.
    #expect(form.secretsEmpty && form.label.isEmpty && form.site.isEmpty && form.identifier.isEmpty)
    #expect(backend.lists == 1)
    #expect(!holds(marker, in: model))
    #expect(!holds(marker, in: form))
  }

  @Test func aRefusedAddKeepsNoSecretAnywhereAndAsksForItAgain() async {
    let backend = StubVault()
    backend.failAdd(refusal("store failed near \(marker)"))
    let model = VaultModel(bot: bot, backend: backend)
    let form = VaultAddForm()
    filled(form)

    #expect(!(await form.submit(to: model)))

    #expect(backend.added.count == 1, "sent once, never again by itself")
    #expect(form.secretsEmpty, "the secret is not put back for a retry")
    #expect(form.label == "Work" && form.identifier == "me@example.com", "what is not secret stays")
    #expect(model.addFailure == .failed("store failed near [REDACTED]"))
    #expect(!holds(marker, in: model))
    #expect(!holds(marker, in: form))
    #expect(!form.isComplete, "Save is off until the secret is typed again")
  }

  @Test func anOfflineAddIsAFailureToo() async {
    let backend = StubVault()
    backend.failAdd(GatewayRPCError(.notConnected, "gateway not connected"))
    let model = VaultModel(bot: bot, backend: backend)
    let form = VaultAddForm()
    filled(form)

    #expect(!(await form.submit(to: model)))
    #expect(model.addFailure == .offline)
    #expect(form.secretsEmpty)
  }

  @Test func anIncompleteFormSendsNothing() async {
    let backend = StubVault()
    let model = VaultModel(bot: bot, backend: backend)
    let form = VaultAddForm()
    form.label = "Work"
    form.site = "example.com"
    form.setSecret("password", marker)

    #expect(!form.isComplete, "a login needs its identifier")
    #expect(!(await form.submit(to: model)))
    #expect(backend.added.isEmpty)
    #expect(form.secret("password").revealed == marker, "nothing was taken")

    form.kind = .payment
    #expect(form.secretsEmpty, "another kind has other fields")
    form.setSecret("card_number", "4242")
    form.setSecret("exp_month", "01")
    form.setSecret("exp_year", "2030")
    #expect(!form.isComplete)
    form.setSecret("cvc", "m-1")
    #expect(form.isComplete)
  }

  @Test func backgroundEmptiesTheSecretAndDismissEmptiesEverything() {
    let form = VaultAddForm()
    filled(form)
    form.setSecret("otp_secret", marker)
    #expect(holds(marker, in: form), "the check reaches a secret the form holds")

    form.leftForeground()

    #expect(form.secretsEmpty)
    #expect(!holds(marker, in: form))
    #expect(form.label == "Work" && form.site == "example.com" && form.identifier == "me@example.com")

    filled(form)
    form.clear()

    #expect(form.secretsEmpty && form.label.isEmpty && form.site.isEmpty && form.identifier.isEmpty)
    #expect(!holds(marker, in: form))
  }

  @Test func aCardTakesOnlyItsOwnFieldsTrimmed() {
    let form = VaultAddForm()
    form.kind = .payment
    form.label = "Card"
    form.site = "shop.example"
    form.setSecret("card_number", " 4242 ")
    form.setSecret("exp_month", "01")
    form.setSecret("exp_year", "2030")
    form.setSecret("cvc", "123")

    let request = form.take()

    #expect(request?.kind == .payment)
    #expect(request?.identifier == nil && request?.identifierType == nil)
    #expect(request.map { Set($0.secret.keys) } == ["card_number", "exp_month", "exp_year", "cvc"])
    #expect(request?.secret["card_number"]?.revealed == "4242")
    #expect(form.secretsEmpty)
  }
}

// MARK: - Removing

@Suite("Removing from a vault") @MainActor struct VaultRemoveTests {
  private let item = VaultItem(id: "vault_1", kind: "login", label: "Work")

  @Test func askingSendsNothingAndCancellingClearsTheQuestion() async {
    let backend = StubVault()
    backend.set(items: [item])
    let model = VaultModel(bot: bot, backend: backend)
    await model.load()

    model.askRemoval(item)
    #expect(model.pendingRemoval == item)
    #expect(backend.removed.isEmpty)

    model.cancelRemoval()
    #expect(model.pendingRemoval == nil)
    #expect(backend.removed.isEmpty)
  }

  /// SwiftUI dismisses a confirmation dialog (its `isPresented` setter, with `false`) before it runs the
  /// button's action, so the question is gone by the time the yes arrives: the yes carries its item.
  @Test func theYesRemovesTheItemAfterTheDialogDismissedItself() async {
    let backend = StubVault()
    backend.set(items: [item])
    let model = VaultModel(bot: bot, backend: backend)
    await model.load()

    model.askRemoval(item)
    model.cancelRemoval()
    backend.set(items: [])
    let removed = await Task { await model.confirmRemoval(item) }.value

    #expect(removed)
    #expect(backend.removed == ["vault_1"])
    #expect(model.pendingRemoval == nil)
    #expect(model.items.isEmpty, "the list was read again")
    #expect(model.removing.isEmpty)
  }

  @Test func aPasswordManagersItemIsNeitherAskedAboutNorRemoved() async {
    let backend = StubVault()
    let model = VaultModel(bot: bot, backend: backend)
    let managed = VaultItem(id: "bw_1", kind: "login", label: "Shop", backend: "bitwarden")

    model.askRemoval(managed)
    #expect(model.pendingRemoval == nil)
    #expect(!(await model.confirmRemoval(managed)))
    #expect(backend.removed.isEmpty)
  }

  @Test func aRefusedOrMissedRemoveIsSaid() async {
    let backend = StubVault()
    backend.set(items: [item])
    backend.answerRemove(false)
    let model = VaultModel(bot: bot, backend: backend)
    await model.load()

    #expect(!(await model.confirmRemoval(item)))
    #expect(model.actionFailure == .failed(""))

    backend.failActions(refusal("vault locked"))
    #expect(!(await model.confirmRemoval(item)))
    #expect(model.actionFailure == .failed("vault locked"))
  }
}

// MARK: - Locking and unlocking

@Suite("A vault's password managers") @MainActor struct VaultLockTests {
  @Test func unlockSendsThePasswordOnceAndTheFormIsEmptyBeforeTheCallStarts() async {
    let form = VaultUnlockForm(source: manager())
    let seen = Mutex<Bool?>(nil)
    let backend = StubVault {
      let empty = await MainActor.run { form.password.isEmpty }
      seen.withLock { $0 = empty }
    }
    backend.set(sources: [manager()])
    let model = VaultModel(bot: bot, backend: backend)
    form.password = SecretValue(marker)

    backend.set(sources: [manager(unlocked: true)])
    #expect(await form.submit(to: model))

    #expect(seen.withLock { $0 } == true)
    #expect(backend.unlocked.map(\.source) == ["bitwarden"])
    #expect(backend.unlocked.map(\.password) == [marker])
    #expect(model.sources.first?.unlocked == true, "the sources were read again")
    #expect(!holds(marker, in: model))
    #expect(!holds(marker, in: form))
  }

  @Test func aRefusedUnlockKeepsNoPassword() async {
    let backend = StubVault()
    backend.failUnlock(refusal("Invalid master password: \(marker)"))
    let model = VaultModel(bot: bot, backend: backend)
    let form = VaultUnlockForm(source: manager())
    form.password = SecretValue(marker)

    #expect(!(await form.submit(to: model)))

    #expect(backend.unlocked.count == 1)
    #expect(form.password.isEmpty)
    #expect(model.unlockFailure == .failed("Invalid master password: [REDACTED]"))
    #expect(model.unlocking == nil)
    #expect(!holds(marker, in: model))
  }

  @Test func anEmptyPasswordSendsNothing() async {
    let backend = StubVault()
    let model = VaultModel(bot: bot, backend: backend)

    #expect(!(await VaultUnlockForm(source: manager()).submit(to: model)))
    #expect(!(await model.unlock("bitwarden", password: SecretValue())))
    #expect(backend.unlocked.isEmpty)
  }

  @Test func lockAndTheSwitchAreSentAndThePageIsReadAgain() async {
    let backend = StubVault()
    backend.set(sources: [manager(unlocked: true)])
    let model = VaultModel(bot: bot, backend: backend)
    await model.load()

    backend.set(sources: [manager(unlocked: false)])
    #expect(await model.lock("bitwarden"))
    #expect(backend.locked == ["bitwarden"])
    #expect(model.sources.first?.unlocked == false)

    backend.set(sources: [manager(enabled: false)])
    #expect(await model.setEnabled("bitwarden", false))
    #expect(backend.switched.map(\.0) == ["bitwarden"])
    #expect(backend.switched.map(\.1) == [false])
    #expect(model.managers.first?.enabled == false)

    backend.failActions(refusal("no", code: 4033))
    #expect(!(await model.lock("bitwarden")))
    #expect(model.actionFailure == .refused)
    #expect(model.busySources.isEmpty)
  }

  @Test func onlyManagersOnTheHostOrSwitchedOnAreShown() async {
    let backend = StubVault()
    backend.set(sources: [
      VaultSource(name: "local", displayName: "Hermes vault", enabled: true, needsUnlock: false, unlocked: true, installed: true),
      manager(),
      VaultSource(name: "onepassword", displayName: "1Password", enabled: false, needsUnlock: true, unlocked: false, installed: false)
    ])
    let model = VaultModel(bot: bot, backend: backend)
    await model.load()

    #expect(model.managers.map(\.name) == ["bitwarden"])
  }

  @Test func aFailedFirstReadIsAFailureAndALaterOneKeepsTheList() async {
    let backend = StubVault()
    backend.failList(refusal("unknown method: vault.list", code: -32601))
    let model = VaultModel(bot: bot, backend: backend)

    await model.load()
    #expect(model.phase == .failed(.unsupported))

    backend.failList(nil)
    backend.set(items: [VaultItem(id: "vault_1", kind: "login", label: "Work")])
    await model.load()
    #expect(model.phase == .loaded)

    backend.failList(GatewayRPCError(.timeout, "late"))
    await model.load()
    #expect(model.phase == .loaded)
    #expect(model.items.count == 1)
  }
}

// MARK: - No answer in time

@Suite("A vault call without an answer in time") @MainActor struct VaultTimeoutTests {
  @Test func aTimeoutIsNotOfflineOnTheWire() async {
    let link = ScriptedLink()
    link.refuse("vault.add") { _ in GatewayRPCError(.timeout, "request timed out after 30s: vault.add") }

    await #expect(throws: VaultFailure.timedOut) {
      _ = try await VaultService(link: link).add(
        profile: bot,
        VaultAddRequest(kind: .login, label: "x", origin: "https://x.example", secret: ["password": SecretValue(marker)]))
    }
  }

  @Test func anAddThatTimedOutMayHaveBeenStoredSoTheListIsReadAgain() async {
    let backend = StubVault()
    backend.failAdd(GatewayRPCError(.timeout, "request timed out after 30s: vault.add"))
    backend.set(items: [VaultItem(id: "vault_1", kind: "login", label: "Work")])
    let model = VaultModel(bot: bot, backend: backend)
    let form = VaultAddForm()
    form.label = "Work"
    form.site = "example.com"
    form.identifier = "me"
    form.setSecret("password", marker)

    #expect(!(await form.submit(to: model)))

    #expect(model.addFailure == .timedOut)
    #expect(backend.lists == 1)
    #expect(model.items.map(\.label) == ["Work"])
    #expect(form.secretsEmpty)
    #expect(!holds(marker, in: model))
  }

  @Test func anUnlockThatTimedOutReadsTheSourcesAgain() async {
    let backend = StubVault()
    backend.failUnlock(GatewayRPCError(.timeout, "request timed out after 30s: vault.unlock"))
    backend.set(sources: [manager(unlocked: true)])
    let model = VaultModel(bot: bot, backend: backend)

    #expect(!(await model.unlock("bitwarden", password: SecretValue(marker))))

    #expect(model.unlockFailure == .timedOut)
    #expect(model.sources.first?.unlocked == true)
  }
}

// MARK: - Limits on what a gateway answers

@Suite("A vault listing's limits") struct VaultListLimitTests {
  private func row(_ id: String, label: String = "x") -> JSONValue {
    .object(["id": .string(id), "kind": .string("login"), "label": .string(label), "backend": .string("local")])
  }

  @Test func aListingIsCappedAndKeepsTheFirstOfEachIdAndNoOverlongOne() {
    var rows = (0..<600).map { row("vault_\($0)") }
    rows.insert(row("vault_0", label: "duplicate"), at: 1)
    rows.insert(row(String(repeating: "x", count: VaultItem.idLimit + 1)), at: 2)

    let items = VaultItem.parseList(.object(["items": .array(rows)]))

    #expect(items.count == VaultItem.listLimit)
    #expect(Set(items.map(\.id)).count == items.count)
    #expect(items.first?.label == "x")
    #expect(items.allSatisfy { $0.id.count <= VaultItem.idLimit })
  }

  @Test func sourcesAreCappedAndUnique() {
    let rows = (0..<80).map { JSONValue.object(["name": .string("m\($0 % 60)")]) }

    let sources = VaultSource.parseList(.object(["sources": .array(rows)]))

    #expect(sources.count == VaultSource.listLimit)
    #expect(Set(sources.map(\.name)).count == sources.count)
  }
}

// MARK: - The count on the bot settings

@Suite("A vault's count") @MainActor struct VaultCountTests {
  @Test func aRecentCountIsShownWithoutReadingTheVaultAgain() async {
    final class Clock { var now = ContinuousClock.now }
    let clock = Clock()
    let counts = VaultCounts(now: { clock.now })
    let backend = StubVault()
    backend.set(items: [VaultItem(id: "vault_1", kind: "login", label: "Work")])
    let key = VaultCounts.key(gateway: "g1", bot: bot)

    let first = VaultModel(bot: bot, backend: backend, countKey: key, counts: counts)
    #expect(first.count == nil)
    await first.loadCountIfStale()
    #expect(first.count == 1)
    #expect(backend.lists == 1)

    // The settings opened again within the minute: the count is there, the vault is not listed.
    let again = VaultModel(bot: bot, backend: backend, countKey: key, counts: counts)
    await again.loadCountIfStale()
    #expect(again.count == 1)
    #expect(backend.lists == 1)

    // Another bot, another count.
    let other = VaultModel(
      bot: "writer", backend: backend, countKey: VaultCounts.key(gateway: "g1", bot: "writer"), counts: counts)
    #expect(other.count == nil)

    // Past the minute it is read again.
    clock.now = clock.now.advanced(by: VaultCounts.freshFor + .seconds(1))
    let later = VaultModel(bot: bot, backend: backend, countKey: key, counts: counts)
    #expect(later.count == nil)
    await later.loadCountIfStale()
    #expect(backend.lists == 2)
  }

  @Test func whatThePageDoesIsInTheCount() async {
    let counts = VaultCounts()
    let backend = StubVault()
    let model = VaultModel(bot: bot, backend: backend, countKey: "k", counts: counts)
    await model.load()
    #expect(model.count == 0)

    backend.set(items: [VaultItem(id: "vault_1", kind: "login", label: "Work")])
    #expect(await model.add(VaultAddRequest(kind: .login, label: "Work", origin: "https://x.example", secret: [:])))

    #expect(model.count == 1)
    #expect(counts.count(for: "k") == 1)
  }
}
