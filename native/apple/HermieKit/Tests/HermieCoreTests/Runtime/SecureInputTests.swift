import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
/// A value nobody else in the test writes, so finding it anywhere is a leak.
private let typed = "pw-7f3a-never-anywhere"

/// A session over the scripted link with the researcher's chat open on
/// `Fixture.runtime`, and its secure input center.
@MainActor
struct SecureHarness {
  let harness: SessionHarness
  var link: ScriptedLink { harness.link }
  var clock: ManualClock { harness.clock }
  var session: GatewaySession { harness.session }
  var center: SecureInputCenter { harness.session.secureInput }

  init(cache: (any ChatCaching)? = nil, keyValues: KeyValueStore? = nil) {
    harness = SessionHarness(cache: cache, keyValues: keyValues)
  }

  func open() async throws {
    try await harness.start()
    try await harness.open()
    try await harness.frame()
  }

  /// Raise a request and wait until the center has it open.
  @discardableResult
  func raiseOpen(
    _ id: String,
    _ method: String = "secret",
    params: JSONObject = ["env_var": "API_KEY", "prompt": "Paste the key"],
    session: String = Fixture.runtime,
    replayed: Bool = false
  ) async throws -> SecurePrompt {
    var params = params
    params["session_id"] = .string(session)
    link.raise(id: id, method: method, params: params, replayed: replayed)
    let center = self.center
    try await eventually("\(id) to open") { await center.isOpen(id) }
    return try #require(center.prompts.first { $0.id == id })
  }

  func answers(_ id: String) -> [JSONObject] {
    link.answers.filter { $0.id == id }.map(\.result)
  }
}

@Suite("Secure input: routing, answering, ending") @MainActor
struct SecureInputTests {
  // MARK: Routing

  @Test("a prompt goes to the chat whose runtime session it names, and never into the transcript")
  func routesBySession() async throws {
    let h = SecureHarness()
    try await h.open()
    let before = try #require(await h.session.store.state(of: bot))

    let prompt = try await h.raiseOpen("srq-1")
    #expect(prompt.chatKey == bot)
    #expect(prompt.kind == .secret(envVar: "API_KEY", prompt: "Paste the key"))
    #expect(prompt.deadline == h.clock.now + .seconds(300))
    #expect(h.center.needsInput(bot))
    #expect(!h.center.needsInput("someone-else"))

    try await h.harness.frame()
    let after = try #require(await h.session.store.state(of: bot))
    #expect(after.order == before.order, "the transcript did not change")
    #expect(after.byRequestID.isEmpty)
    #expect(h.link.declines.isEmpty, "the store left it alone")
    #expect(h.link.answers.isEmpty)
  }

  @Test("each kind reads its params, and the gateway's timeout per kind")
  func readsEveryKind() async throws {
    let h = SecureHarness()
    try await h.open()

    let sudo = try await h.raiseOpen("s", "sudo", params: ["command": "apt install x"])
    #expect(sudo.kind == .sudo(command: "apt install x"))
    #expect(sudo.deadline == h.clock.now + .seconds(120))
    let unlock = try await h.raiseOpen("u", "vault.unlock_prompt", params: ["backend": "b", "display_name": "Vault"])
    #expect(unlock.kind == .vaultUnlock(name: "Vault"))
    #expect(unlock.deadline == h.clock.now + .seconds(120))
    let code = try await h.raiseOpen("c", "vault.code", params: ["site": "example.com", "hint": "From the app"])
    #expect(code.kind == .vaultCode(site: "example.com", hint: "From the app"))
    #expect(code.deadline == h.clock.now + .seconds(180))
    let login = try await h.raiseOpen("l", "vault.save_login", params: ["origin": "https://example.com", "site": ""])
    #expect(login.kind == .vaultSaveLogin(site: "https://example.com", origin: "https://example.com"))
    #expect(login.deadline == h.clock.now + .seconds(180))
    #expect(h.center.prompts(for: bot).map(\.id) == ["s", "u", "c", "l"])
  }

  @Test("the request's texts are cleaned and bounded for display")
  func cleansTexts() {
    let spoof = "Paste\u{202E}gnp.exe\u{0007} the key\n\n\n\nnow\tplease"
    #expect(SecurePrompt.displayText(spoof, limit: 100) == "Pastegnp.exe the key\nnow please")
    let long = String(repeating: "a", count: 700)
    #expect(SecurePrompt.displayText(long, limit: SecurePrompt.textLimit).count == SecurePrompt.textLimit + 1)
    #expect(SecurePrompt.displayText(nil, limit: 10).isEmpty)
  }

  @Test("a prompt for a session no chat holds yet waits, and opens when a resume binds it")
  func parksUntilBound() async throws {
    let h = SecureHarness()
    try await h.harness.start()

    h.link.raise(id: "early", method: "sudo", params: ["session_id": .string(Fixture.runtime)])
    try await eventually("the store to see it") { await h.session.store.ingestedFrames >= 1 }
    #expect(h.center.prompts.isEmpty)

    try await h.harness.open()
    try await h.harness.frame()
    let center = h.center
    try await eventually("the parked prompt to open") { await center.isOpen("early") }
    #expect(center.prompts.first?.chatKey == bot)
    #expect(h.link.declines.isEmpty)
  }

  @Test("one still unclaimed when the park limit passes is declined -32601, and the lot is bounded")
  func parkingIsBounded() async throws {
    let h = SecureHarness()
    try await h.open()

    for index in 0..<16 {
      h.link.raise(id: "far-\(index)", method: "secret", params: ["session_id": "rt-other", "env_var": "K", "prompt": "p"])
    }
    h.link.raise(id: "one-too-many", method: "secret", params: ["session_id": "rt-other", "env_var": "K", "prompt": "p"])
    let link = h.link
    try await eventually("the extra one to be declined") { link.declines.contains { $0.id == "one-too-many" } }
    #expect(h.link.declines.count == 1)
    #expect(h.link.declines.first?.code == -32601)

    await h.clock.advance(by: .seconds(15))
    try await eventually("the parked ones to be declined") { link.declines.count == 17 }
    #expect(h.link.answers.isEmpty, "never answered with a value")
    #expect(h.center.prompts.isEmpty)
  }

  @Test("a request with no session is declined at once")
  func declinesWithoutSession() async throws {
    let h = SecureHarness()
    try await h.open()

    let link = h.link
    link.raise(id: "nosession", method: "sudo", params: [:])
    try await eventually("the refusal") { link.declines.contains { $0.id == "nosession" } }
    #expect(h.center.prompts.isEmpty)
  }

  @Test("a request this app cannot show is declined -32601 and leaves a notice on its chat")
  func unsupportedLeavesANotice() async throws {
    let h = SecureHarness()
    try await h.open()

    h.link.raise(id: "tr-1", method: "terminal.read", params: ["session_id": .string(Fixture.runtime)])
    let center = h.center
    try await eventually("the notice") { await center.notices[bot] != nil }
    #expect(center.notices[bot]?.notice == .unsupported(method: "terminal.read"))
    #expect(h.link.declines.first { $0.id == "tr-1" }?.message == "not supported by this client: terminal.read")
    #expect(h.link.answers.isEmpty, "never an empty value")
    #expect(center.prompts.isEmpty)

    let model = SecureInputModel(session: h.session, bot: bot)
    #expect(model.notice?.requestID == "tr-1")
    model.dismissNotice()
    #expect(model.notice == nil)
  }

  // MARK: Answering

  @Test("Send answers with the value, byte for byte, once")
  func sendsTheValue() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-v")
    let model = SecureInputModel(session: h.session, bot: bot)
    #expect(model.nextToPresent == "srq-v")
    model.present("srq-v")

    // Two taps at once: one answer.
    async let first = model.send(SecretValue(typed))
    async let second = model.send(SecretValue(typed))
    let results = await [first, second]
    #expect(results.filter { $0 }.count == 1)
    #expect(h.answers("srq-v") == [["value": .string(typed)]])
    #expect(!h.center.isOpen("srq-v"))
    #expect(model.presentedID == nil, "the sheet closes once it went out")
    #expect(h.center.lastAnswered?.requestID == "srq-v")

    // Nothing more goes out for it, whatever is tapped.
    #expect(await h.center.send("srq-v", value: SecretValue(typed)) == false)
    #expect(await h.center.skip("srq-v") == false)
    #expect(h.answers("srq-v").count == 1)
  }

  @Test("Skip answers ''; nothing typed cannot be sent")
  func skipAnswersEmpty() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-s", "sudo", params: ["command": "ls"])
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-s")

    #expect(!model.canSend(SecretValue("")))
    #expect(await model.send(SecretValue("")) == false)
    #expect(await model.skip())
    #expect(h.answers("srq-s") == [["value": ""]])
  }

  @Test("a one-time code drops spaces and dashes; a login is the JSON the gateway reads")
  func answersCodesAndLogins() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("code", "vault.code", params: ["site": "example.com"])
    try await h.raiseOpen("login", "vault.save_login", params: ["origin": "https://example.com", "site": "example.com"])
    let model = SecureInputModel(session: h.session, bot: bot)

    model.present("code")
    #expect(await model.send(SecretValue("123 45-6")))
    #expect(h.answers("code") == [["value": "123456"]])

    model.present("login")
    #expect(!model.canSend(SecretValue(typed), identifier: "  "), "a login needs a name")
    #expect(!model.canSend(SecretValue(""), identifier: "me"), "and a password")
    #expect(await model.send(SecretValue("p\"w"), identifier: " me@example.com "))
    #expect(h.answers("login") == [["value": #"{"identifier":"me@example.com","password":"p\"w"}"#]])
  }

  @Test("an answer that did not go out fails, and goes out over the re-delivered copy")
  func retriesOverTheRedeliveredCopy() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-r")
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-r")

    h.link.setSocketOpen(false)
    #expect(await model.send(SecretValue(typed)) == false)
    #expect(model.hasFailed)
    #expect(h.center.isOpen("srq-r"))

    // The reconnect re-delivers it; the retry sends the value still in the field.
    h.link.setSocketOpen(true)
    h.link.raise(id: "srq-r", method: "secret", params: ["session_id": .string(Fixture.runtime)], replayed: true)
    try await eventually("the copy to arrive") { await h.session.store.ingestedFrames >= h.link.emittedFrames }
    try await Task.sleep(for: .milliseconds(20))
    #expect(await model.send(SecretValue(typed)))
    #expect(h.answers("srq-r") == [["value": .string(typed)]])
  }

  // MARK: Expiry and withdrawal

  @Test("at the gateway's deadline the prompt closes as expired and nothing is sent, typed or not")
  func expires() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-e", "sudo", params: ["command": "ls"])
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-e")
    #expect(model.secondsLeft == 120)

    await h.clock.advance(by: .seconds(60))
    #expect(model.secondsLeft == 60, "the countdown runs whether or not the sheet is up")
    await h.clock.advance(by: .seconds(60))
    #expect(!h.center.isOpen("srq-e"))
    #expect(model.presentedOutcome == .expired, "the sheet says so")
    #expect(model.notice == nil, "not twice")

    // A value typed after the expiry is never sent.
    #expect(await model.send(SecretValue(typed)) == false)
    #expect(await model.skip() == false)
    #expect(h.link.answers.isEmpty)
    model.dismiss()
    #expect(h.center.notices[bot] == nil)
  }

  @Test("one that expired before it was shown leaves the notice instead of a sheet")
  func expiresWhileHeld() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-held", "vault.code")
    let model = SecureInputModel(session: h.session, bot: bot)

    await h.clock.advance(by: .seconds(180))
    #expect(model.nextToPresent == nil)
    #expect(model.notice?.notice == .expired)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a re-delivered prompt shows no countdown: its deadline is not known")
  func replayedHasNoDeadline() async throws {
    let h = SecureHarness()
    try await h.open()
    let prompt = try await h.raiseOpen("srq-old", replayed: true)
    #expect(prompt.deadline == nil)
    #expect(h.center.secondsLeft("srq-old") == nil)
  }

  @Test("request.cancel closes only its prompt: timeout as expired, anything else as withdrawn")
  func withdrawn() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("a")
    try await h.raiseOpen("b", "sudo")
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("a")

    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "a", "method": "secret", "reason": "interrupted"])
    let center = h.center
    try await eventually("a to close") { await !center.isOpen("a") }
    #expect(center.isOpen("b"))
    #expect(model.presentedOutcome == .withdrawn)

    model.dismiss()
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "b", "method": "sudo", "reason": "timeout"])
    try await eventually("b to close") { await !center.isOpen("b") }
    #expect(model.notice?.notice == .expired)
    #expect(h.link.answers.isEmpty)

    // A cancel that overtook its request: the request is ignored when it comes.
    h.link.emit("request.cancel", session: Fixture.runtime, payload: ["id": "c", "method": "secret", "reason": "timeout"])
    try await eventually("the cancel to be heard") { await h.session.store.ingestedFrames >= h.link.emittedFrames }
    try await Task.sleep(for: .milliseconds(20))
    h.link.raise(id: "c", method: "secret", params: ["session_id": .string(Fixture.runtime)])
    try await Task.sleep(for: .milliseconds(50))
    #expect(!center.isOpen("c"))
  }

  // MARK: The chat lets go

  @Test("when the chat no longer holds the session, the prompt is answered '' exactly once")
  func rebindAnswersEmptyOnce() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-rb")

    // Another client took the session over: the chat lets go of the runtime id.
    h.link.emit("session.reclaimed", session: Fixture.runtime, payload: [:])
    try await h.harness.frame()
    let center = h.center
    try await eventually("the prompt to be let go") { await !center.isOpen("srq-rb") }
    let link = h.link
    try await eventually("the answer") { link.answers.contains { $0.id == "srq-rb" } }
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(20))
    #expect(h.answers("srq-rb") == [["value": ""]])
    #expect(center.notices[bot]?.notice == .withdrawn, "the chat says so")
  }

  @Test("when the bot's chat is forgotten, its prompt is answered ''")
  func forgetAnswersEmpty() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("srq-f")

    await h.session.store.forget(bot)
    try await h.harness.frame()
    h.session.secureInput.storeChanged()
    let link = h.link
    try await eventually("the answer") { link.answers.contains { $0.id == "srq-f" } }
    #expect(h.answers("srq-f") == [["value": ""]])
  }

  @Test("shutdown answers every open prompt '' once and declines the waiting ones")
  func shutdownAnswersEmpty() async throws {
    let h = SecureHarness()
    try await h.open()
    try await h.raiseOpen("x1")
    try await h.raiseOpen("x2", "vault.unlock_prompt", params: ["backend": "b", "display_name": "B"])
    h.link.raise(id: "x3", method: "sudo", params: ["session_id": "rt-elsewhere"])
    try await eventually("x3 to be taken in") { await h.session.store.ingestedFrames >= h.link.emittedFrames }
    try await Task.sleep(for: .milliseconds(20))

    await h.session.shutdown()
    #expect(h.answers("x1") == [["value": ""]])
    #expect(h.answers("x2") == [["value": ""]])
    #expect(h.link.declines.map(\.id) == ["x3"])
    #expect(h.center.prompts.isEmpty)
    #expect(h.center.liveTaskCount == 0)
    await h.center.shutdown()
    #expect(h.link.answers.count == 2, "once")
  }

  // MARK: Nothing kept

  @Test("the value is in no description, dump or store")
  func leavesNoTrace() async throws {
    let database = try SQLiteStore(.inMemory)
    let cache = SQLiteChatCache(store: database, gatewayId: "g1")
    let keyValues = KeyValueStore(store: database)
    let h = SecureHarness(cache: cache, keyValues: keyValues)
    try await h.open()
    try await h.raiseOpen("srq-t", "vault.save_login", params: ["origin": "https://example.com", "site": "example.com"])
    let model = SecureInputModel(session: h.session, bot: bot)
    model.present("srq-t")

    let value = SecretValue(typed)
    var texts = [String(describing: value), String(reflecting: value), "\(value)"]
    var dumped = ""
    dump(value, to: &dumped)
    texts.append(dumped)

    #expect(await model.send(value, identifier: "me"))
    #expect(h.answers("srq-t").first?["value"]?.stringValue?.contains(typed) == true, "it did go out")

    for subject in [model as Any, h.center, h.center.prompts, model.presentedPrompt as Any, h.link.lifecycle] {
      var text = ""
      dump(subject, to: &text)
      texts.append(text)
      texts.append(String(describing: subject))
    }

    for text in texts {
      #expect(!text.contains(typed))
    }

    await h.session.store.persistAll()
    try await h.harness.frame()
    await h.session.shutdown()

    let leaked = try await database.read { db -> [String] in
      let tables = try db.query("SELECT name FROM sqlite_master WHERE type = 'table'").compactMap { $0["name"].text }
      var hits: [String] = []

      for table in tables {
        for row in try db.query("SELECT * FROM \"\(table)\"") {
          for value in row.values {
            switch value {
            case .text(let text) where text.contains(typed): hits.append(table)
            case .blob(let data) where String(decoding: data, as: UTF8.self).contains(typed): hits.append(table)
            default: break
            }
          }
        }
      }

      return hits
    }
    #expect(leaked.isEmpty, "found in \(leaked)")
  }
}
