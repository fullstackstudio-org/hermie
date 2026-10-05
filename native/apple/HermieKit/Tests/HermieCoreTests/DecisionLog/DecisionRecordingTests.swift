import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// Values nobody else in these tests writes: finding one anywhere in the log is a leak.
private enum Marker {
  static let secret = "pw-7f3a-never-anywhere"
  static let login = "login-7f3a-never-anywhere"
  static let scan = "scan-7f3a-never-anywhere"
  static let form = "form-7f3a-never-anywhere"
  static let draft = "draft-7f3a-never-anywhere"
  static let comment = "comment-7f3a-never-anywhere"
  static let envVar = "ENV_7F3A_NEVER_ANYWHERE"
  static let prompt = "prompt-7f3a-never-anywhere"
  static let secondLine = "second-line-7f3a-never-anywhere"
  static let title = "title-7f3a-never-anywhere"
  static let question = "question-7f3a-never-anywhere"
  static let answer = "answer-7f3a-never-anywhere"
  static let linkHost = "auth-7f3a-never-anywhere.example.invalid"
  static let detail = "detail-7f3a-never-anywhere"

  static let all = [
    secret, login, scan, form, draft, comment, envVar, prompt, secondLine, title, question, answer, linkHost, detail
  ]
}

/// Every place a request is answered writes one entry, when its answer went out, and none of them can carry
/// what the person typed, what the device gave or what the request said.
@Suite("Decision log: every kind of request", .timeLimit(.minutes(1))) @MainActor
struct DecisionRecordingTests {
  /// What the log holds, as one text, checked for every marker.
  private func assertNoLeak(_ log: DecisionLog, sourceLocation: SourceLocation = #_sourceLocation) async {
    let dump = await log.dump()
    let exported = String(decoding: DecisionExport.data(await log.entries(), as: .csv), as: UTF8.self)
    let json = String(decoding: DecisionExport.data(await log.entries(), as: .json), as: UTF8.self)

    for marker in Marker.all {
      #expect(!dump.contains(marker), "\(marker) is in the stored rows", sourceLocation: sourceLocation)
      #expect(!exported.contains(marker), "\(marker) is in the CSV", sourceLocation: sourceLocation)
      #expect(!json.contains(marker), "\(marker) is in the JSON", sourceLocation: sourceLocation)
    }
  }

  @Test("the leak check does see a marker, wherever it would be")
  func theLeakCheckWorks() async throws {
    for entry in [
      DecisionFixture.entry("a", summary: "x \(Marker.secret)"),
      DecisionFixture.entry("b", bot: "bot-\(Marker.login)")
    ] {
      let log = try DecisionFixture.log()

      await log.record(entry)
      await withKnownIssue {
        await assertNoLeak(log)
      }
    }
  }

  // MARK: Approvals

  /// The chat open on the scripted link, an approval card for the requests model to answer.
  @MainActor private struct Approvals {
    let harness: SessionHarness
    let requests: RequestsModel
    var link: ScriptedLink { harness.link }

    static func opened(_ log: DecisionLog) async throws -> Approvals {
      let harness = SessionHarness(decisions: log)

      try await harness.start()
      harness.link.respond(to: RPC.ApprovalReceived.name, with: ["acknowledged": true])
      harness.link.respond(to: RPC.ApprovalRespond.name, with: ["ok": true])

      let requests = RequestsModel(chat: harness.session.chat(bot))

      try await harness.open()
      try await harness.frame()

      return Approvals(harness: harness, requests: requests)
    }

    func raise(
      id: String = "srq-1", queueID: String = "appr-1", command: String = "rm -rf ./build",
      tool: String? = nil, choices: JSONValue = ["once", "session", "always", "deny"]
    ) async throws {
      var params: JSONObject = [
        "session_id": .string(Fixture.runtime), "request_id": .string(queueID), "command": .string(command),
        "choices": choices
      ]

      params["tool_name"] = tool.map(JSONValue.string)
      link.raise(id: id, method: "approval", params: params)
      link.respond(to: RPC.ApprovalPending.name, with: ["approvals": [["request_id": .string(queueID)]]])
      try await harness.frame()
    }
  }

  @Test(
    "an approval is logged with what was chosen, how, for which bot and session, and its command's first line",
    arguments: [
      ("once", DecisionOutcome.approved), ("session", .approvedSession), ("always", .approvedAlways),
      ("deny", .denied)
    ])
  func approval(choice: String, outcome: DecisionOutcome) async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    try await h.raise(command: "rm -rf ./build\n\(Marker.secondLine)")
    await h.requests.answerApproval("srq-1", choice: choice)

    let entries = await log.entries()
    let entry = try #require(entries.first)

    #expect(entries.count == 1)
    #expect(entry.kind == .approval)
    #expect(entry.outcome == outcome)
    #expect(entry.method == .tap)
    #expect(entry.bot == bot)
    #expect(entry.session == Fixture.runtime)
    #expect(entry.gatewayID == "g1")
    #expect(entry.at == Date(timeIntervalSince1970: 1_790_000_000))
    #expect(entry.summary == "rm -rf ./build", "the first line only")
    await assertNoLeak(log)
    await h.harness.session.shutdown()
  }

  @Test("the Return key and a retry are logged the way the choice was made")
  func approvalMethods() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    try await h.raise()
    await h.requests.answerApproval("srq-1", choice: "once", via: .keyboard)
    #expect(await log.entries().map(\.method) == [.keyboard])

    try await h.raise(id: "srq-2", queueID: "appr-2")
    h.link.setSocketOpen(false)
    await h.requests.answerApproval("srq-2", choice: "deny", via: .keyboard)
    #expect(await log.count() == 1, "an answer that did not go out is not a decision")

    h.link.setSocketOpen(true)
    h.link.raise(
      id: "srq-2", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-2", "command": "rm -rf ./build"],
      replayed: true)
    try await h.harness.frame()
    await h.requests.retry("srq-2")

    let entries = await log.entries()

    #expect(entries.count == 2)
    #expect(entries.first?.outcome == .denied && entries.first?.method == .keyboard)
    await h.harness.session.shutdown()
  }

  @Test("an approval that was not answered leaves no entry: a choice it did not offer, a request the gateway dropped")
  func approvalNotAnswered() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    try await h.raise(choices: ["once", "deny"])
    await h.requests.answerApproval("srq-1", choice: "always")
    #expect(await log.count() == 0)

    h.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": []])
    await h.requests.answerApproval("srq-1", choice: "once")
    #expect(await log.count() == 0, "the gateway no longer waits for it")
    await h.harness.session.shutdown()
  }

  @Test("a command that looks like it carries a secret is logged by its kind only")
  func sensitiveApproval() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    try await h.raise(command: "export API_TOKEN=\(Marker.secret)")
    await h.requests.answerApproval("srq-1", choice: "once")

    let entry = try #require(await log.entries().first)

    #expect(entry.kind == .approval && entry.outcome == .approved)
    #expect(entry.summary == nil)
    await assertNoLeak(log)
    await h.harness.session.shutdown()
  }

  @Test("an approval of a tool that deals with secrets is logged by its kind only")
  func sensitiveTool() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    try await h.raise(command: "ls", tool: "vault_get")
    await h.requests.answerApproval("srq-1", choice: "once")
    #expect(await log.entries().first?.summary == nil)
    await h.harness.session.shutdown()
  }

  @Test("a notification's Allow and Deny are logged as notification actions, with a card and without")
  func notificationActions() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    // With the chat's card: answered on its live reply, the card is marked.
    try await h.raise(command: "make deploy")
    try await h.harness.session.pushRespond(
      PushApprovalAnswer(gatewayId: "g1", bot: bot, sessionId: Fixture.runtime, requestId: "appr-1", choice: "once"))

    // Without one: `approval.respond` against the queue entry.
    try await h.harness.session.pushRespond(
      PushApprovalAnswer(gatewayId: "g1", bot: bot, sessionId: Fixture.runtime, requestId: "appr-elsewhere", choice: "deny"))

    let entries = await log.entries()

    #expect(entries.count == 2)
    #expect(entries.allSatisfy { $0.method == .notification && $0.kind == .approval && $0.bot == bot })

    let byOutcome = Dictionary(uniqueKeysWithValues: entries.map { ($0.outcome, $0) })

    #expect(byOutcome[.approved]?.summary == "make deploy")
    #expect(byOutcome[.denied]?.summary == nil, "no card, so no command to quote")
    #expect(byOutcome[.denied]?.session == Fixture.runtime)
    await h.harness.session.shutdown()
  }

  // MARK: Questions

  @Test("an answered question is logged, and neither the question nor the answer is kept")
  func clarify() async throws {
    let log = try DecisionFixture.log()
    let h = try await Approvals.opened(log)

    h.link.raise(
      id: "srq-2", method: "clarify",
      params: [
        "session_id": .string(Fixture.runtime), "question": .string(Marker.question), "choices": ["main", "next"]
      ])
    try await h.harness.frame()

    let clarify = try #require(h.requests.openRequests.first?.asClarify)
    let qid = try #require(clarify.questions.first?.qid)

    await h.requests.answerClarify("srq-2", answers: [qid: Marker.answer])

    let entries = await log.entries()

    #expect(entries.count == 1)
    #expect(entries.first?.kind == .clarify && entries.first?.outcome == .answered)
    #expect(entries.first?.method == .tap && entries.first?.bot == bot && entries.first?.summary == nil)
    await assertNoLeak(log)
    await h.harness.session.shutdown()
  }

  // MARK: Confirmations

  private func confirmation(_ log: DecisionLog) async -> PasskeyModelTests.Fixture {
    let f = await PasskeyModelTests.fixture()

    f.model.decisions = DecisionRecorder(log: log, gatewayID: "gw-1", gatewayName: "Work", now: { DecisionFixture.start })
    f.model.chatForSession = { session in session == "sess-1" ? bot : nil }
    f.link.respond(to: "request.answer", with: ["status": "ok"])

    return f
  }

  @Test("a confirmation confirmed with a passkey and one declined are logged, without anything the sheet said")
  func confirmations() async throws {
    let log = try DecisionFixture.log()
    let f = await confirmation(log)

    try await PasskeyModelTests().raise(f, PasskeyModelTests.params(ids: [f.phone.id], detail: Marker.detail))
    await f.model.confirm("srq-1")

    try await PasskeyModelTests().raise(
      f, id: "srq-2", PasskeyModelTests.params(ids: [f.phone.id], detail: Marker.detail))
    await f.model.decline("srq-2")

    let entries = await log.entries()
    let confirmed = try #require(entries.first { $0.outcome == .confirmed })
    let declined = try #require(entries.first { $0.outcome == .declined })

    #expect(entries.count == 2)
    #expect(confirmed.kind == .confirm && confirmed.method == .passkey)
    #expect(declined.kind == .confirm && declined.method == .tap)
    #expect(confirmed.bot == bot && confirmed.session == "sess-1" && confirmed.gateway == "Work")
    #expect(confirmed.summary == nil)

    let dump = await log.dump()

    #expect(!dump.contains(Marker.detail))
    #expect(!dump.contains("Delete the build"), "the sheet's title is not kept")
    #expect(!dump.contains("Remove the old build directory"), "nor its summary")
    #expect(!dump.contains("signature") && !dump.contains("authenticator"), "nor the assertion")
  }

  @Test("a confirmation whose answer did not reach the gateway is not a decision, until it does")
  func confirmationNotSent() async throws {
    let log = try DecisionFixture.log()
    let f = await confirmation(log)

    try await PasskeyModelTests().raise(f)
    f.link.unrespond("request.answer")

    let task = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")

    f.link.fail(call, GatewayRPCError(.closed, "WebSocket closed"))
    await task.value
    #expect(await log.count() == 0)

    f.link.respond(to: "request.answer", with: ["status": "ok"])
    await f.model.confirm("srq-1")
    #expect(await log.entries().map(\.outcome) == [.confirmed])
  }

  @Test("a confirmation the gateway refused is not logged as confirmed")
  func confirmationRefused() async throws {
    let log = try DecisionFixture.log()
    let f = await confirmation(log)

    try await PasskeyModelTests().raise(f)
    f.link.unrespond("request.answer")

    let task = Task { await f.model.confirm("srq-1") }
    let call = try await f.link.pendingCall("request.answer")

    f.link.fail(call, GatewayRPCError(.rejected, "not allowed", code: 4033))
    await task.value
    #expect(await log.count() == 0)
  }

  @Test("a plain confirmation has no sheet yet and is declined by the app, which is not the person's decision")
  func plainConfirmation() async throws {
    let log = try DecisionFixture.log()
    let f = await PasskeyModelTests.fixture(plain: true)

    f.model.decisions = DecisionRecorder(log: log, gatewayID: "gw-1", gatewayName: "Work")

    var params = PasskeyModelTests.params(ids: [f.phone.id])

    params["level"] = "plain"
    params["passkey"] = nil
    try await PasskeyModelTests().raise(f, params)
    #expect(f.link.declines.map(\.id) == ["srq-1"])
    #expect(await log.count() == 0)
  }

  // MARK: Secure input

  @Test("a secure prompt answered is logged as entered, with the kind of prompt and nothing typed")
  func secureEntered() async throws {
    let log = try DecisionFixture.log()
    let h = SecureHarness(decisions: log)

    try await h.open()
    try await h.raiseOpen(
      "srq-1", "secret", params: ["env_var": .string(Marker.envVar), "prompt": .string(Marker.prompt)])
    try await h.raiseOpen(
      "srq-2", "vault.save_login", params: ["origin": .string("https://\(Marker.linkHost)"), "site": .string(Marker.title)])
    try await h.raiseOpen("srq-3", "sudo", params: ["command": .string("apt install \(Marker.secondLine)")])

    #expect(await h.center.send("srq-1", value: SecretValue(Marker.secret)))
    #expect(await h.center.send("srq-2", value: SecretValue(Marker.secret), identifier: Marker.login, via: .keyboard))
    #expect(await h.center.send("srq-3", value: SecretValue(Marker.secret)))

    let entries = await log.entries()

    #expect(entries.count == 3)
    #expect(entries.allSatisfy { $0.kind == .secure && $0.outcome == .entered && $0.bot == bot })
    #expect(entries.allSatisfy { $0.session == Fixture.runtime && $0.gatewayID == "g1" })

    let bySubject = Dictionary(uniqueKeysWithValues: entries.map { ($0.summary ?? "", $0) })

    #expect(Set(bySubject.keys) == ["secret", "vault.save_login", "sudo"], "the kind of prompt, which is a method name")
    #expect(bySubject["vault.save_login"]?.method == .keyboard)
    #expect(bySubject["secret"]?.method == .tap)
    await assertNoLeak(log)
    await h.session.shutdown()
  }

  @Test("a secure prompt skipped is logged as declined, and one that did not go out is not logged")
  func secureDeclined() async throws {
    let log = try DecisionFixture.log()
    let h = SecureHarness(decisions: log)

    try await h.open()
    try await h.raiseOpen("srq-1", "vault.code", params: ["site": .string(Marker.linkHost), "hint": .string(Marker.prompt)])
    #expect(await h.center.skip("srq-1"))

    let entry = try #require(await log.entries().first)

    #expect(entry.kind == .secure && entry.outcome == .declined && entry.summary == "vault.code")
    #expect(await log.count() == 1)

    // Nothing is sent for a prompt that is no longer open: no second entry.
    #expect(await h.center.skip("srq-1") == false)
    #expect(await h.center.send("srq-1", value: SecretValue(Marker.secret)) == false)
    #expect(await log.count() == 1)
    await assertNoLeak(log)
    await h.session.shutdown()
  }

  // MARK: Interactive and device requests

  private static let contractDirectory: URL = {
    var url = URL(fileURLWithPath: #filePath)

    for _ in 0..<7 { url.deleteLastPathComponent() }

    return url.appendingPathComponent("contract", isDirectory: true)
  }()

  /// The params of the contract's frame with this request id.
  private func frame(_ method: String, _ id: String) throws -> JSONObject {
    let data = try Data(contentsOf: Self.contractDirectory.appendingPathComponent("requests/examples.json"))
    let root = try JSONValue(parsing: data)
    let frames = try #require(root["methods"]?[method]?["frames"]?.arrayValue)
    let match = try #require(frames.first { $0["id"]?.stringValue == id }, "\(id)")
    var params = try #require(match["params"]?.objectValue)

    params["expires_at"] = .number(Double(InteractiveFrames.expires))

    return params
  }

  private func interactive(_ log: DecisionLog) async throws -> InteractiveHarness {
    let h = InteractiveHarness(requests: ServerRequestBody.Method.interactive, decisions: log)

    try await h.open()

    return h
  }

  @Test("a device request shared is logged as shared, and the position is not in the log")
  func deviceShared() async throws {
    let log = try DecisionFixture.log()
    let h = try await interactive(log)

    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_precise"))
    try await h.raiseOpen("srq-scan", "device.scan", params: try frame("device.scan", "req_scan_any"))
    try await h.raiseOpen("srq-cal", "device.calendar", params: try frame("device.calendar", "req_cal_event"))

    let fix = LocationFix(
      latitude: 52.373123, longitude: 4.892201, accuracyMeters: 8.5, time: Date(timeIntervalSince1970: 1_791_119_300))
    let location = try #require(SharedLocation(fix: fix, chose: .approximate))

    #expect(await h.center.answer("srq-loc", .location(location)))
    #expect(await h.center.answer("srq-scan", .scan(value: Marker.scan, symbology: .qr)))
    #expect(await h.center.answer("srq-cal", .calendarSaved))

    let entries = await log.entries()

    #expect(entries.count == 3)
    #expect(entries.allSatisfy { $0.kind == .device && $0.outcome == .shared && $0.method == .tap && $0.bot == bot })
    #expect(Set(entries.compactMap(\.summary)) == ["device.location", "device.scan", "device.calendar"])

    let dump = await log.dump()

    #expect(!dump.contains("52.37") && !dump.contains("4.89") && !dump.contains("8.5"), "no position")
    #expect(!dump.contains("1791119300"), "nor when it was taken")
    #expect(!dump.contains("Tandarts"), "nor a calendar entry's title")
    await assertNoLeak(log)
    await h.session.shutdown()
  }

  @Test("Don't share is logged as declined, and a refused permission or a failed upload is not a decision")
  func deviceDeclined() async throws {
    let log = try DecisionFixture.log()
    let h = try await interactive(log)

    try await h.raiseOpen("srq-loc", "device.location", params: try frame("device.location", "req_loc_precise"))
    try await h.raiseOpen("srq-c", "device.contact", params: try frame("device.contact", "req_contact_phone"))

    #expect(await h.center.cannotShow("srq-c", reason: CannotShowReason.permissionDenied))
    #expect(await log.count() == 0, "the system's refusal is not the person's choice here")

    #expect(await h.center.cannotShow("srq-loc", reason: CannotShowReason.declined))

    let entry = try #require(await log.entries().first)

    #expect(entry.kind == .device && entry.outcome == .declined && entry.summary == "device.location")
    #expect(await log.count() == 1)
    await h.session.shutdown()
  }

  @Test("a form answered, a draft approved or sent back and a question skipped are logged without their text")
  func inputAndReview() async throws {
    let log = try DecisionFixture.log()
    let h = try await interactive(log)

    try await h.raiseOpen("srq-form", "input.form", params: InteractiveFrames.form())
    try await h.raiseOpen("srq-opt", "input.form", params: InteractiveFrames.form(optional: true))
    try await h.raiseOpen("srq-ok", "review.draft", params: InteractiveFrames.draft())
    try await h.raiseOpen("srq-no", "review.draft", params: InteractiveFrames.draft())

    #expect(await h.center.answer("srq-form", .form(["name": .text(Marker.form)])))
    #expect(await h.center.skip("srq-opt", via: .keyboard))
    #expect(await h.center.answer("srq-ok", .approve(text: Marker.draft)))
    #expect(await h.center.answer("srq-no", .reject(comment: Marker.comment)))

    let entries = await log.entries()

    #expect(entries.count == 4)

    func entry(_ subject: String, _ outcome: DecisionOutcome) -> DecisionEntry? {
      entries.first { $0.summary == subject && $0.outcome == outcome }
    }

    #expect(entry("input.form", .answered)?.kind == .input)
    #expect(entry("input.form", .skipped)?.method == .keyboard)
    #expect(entry("review.draft", .approved)?.kind == .review)
    #expect(entry("review.draft", .denied)?.kind == .review)
    await assertNoLeak(log)
    await h.session.shutdown()
  }

  @Test("an interactive answer the gateway did not take is not logged")
  func interactiveNotTaken() async throws {
    let log = try DecisionFixture.log()
    let h = try await interactive(log)

    try await h.raiseOpen("srq-form", "input.form", params: InteractiveFrames.form())
    h.link.refuse(RPC.RequestAnswer.name) { _ in GatewayRPCError(.rejected, "invalid", code: 4034, data: ["reason": "field:name:required"]) }

    #expect(await h.center.answer("srq-form", .form(["name": .text(Marker.form)])) == false)
    #expect(await log.count() == 0)
    await assertNoLeak(log)
    await h.session.shutdown()
  }

  // MARK: Connectors

  private func connection(_ log: DecisionLog, calls: RecordingCalls = RecordingCalls()) -> ConnectionRequestsModel {
    let model = ConnectionRequestsModel(clock: ManualClock()) { method, params in try calls.call(method, params) }

    model.decisions = DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home", now: { DecisionFixture.start })
    model.requested(
      chat: bot, runtimeSessionID: "rt-1",
      ConnectionRequestPayload(json: [
        "op_id": "op-1", "seq": 1, "deadline_at": .number(1_790_000_300), "timeout_seconds": 300,
        "tool_call_id": "call-1",
        "targets": [
          ["name": "calendar", "kind": "connector", "action": "authorize", "state": "initiated",
            "connect_url": .string("https://\(Marker.linkHost)/start?state=x")],
          ["name": "mail", "kind": "connector", "action": "authorize", "state": "initiated"]
        ]
      ]))

    return model
  }

  @Test("opening a connector's authorisation link is logged as authorising it, once, without the link")
  func connectorAuthorised() async throws {
    let log = try DecisionFixture.log()
    let model = connection(log)

    await model.markOpened(chat: bot, target: "calendar")
    await model.markOpened(chat: bot, target: "calendar")

    let entries = await log.entries()

    #expect(entries.count == 1, "opening it again is not another decision")
    #expect(entries.first?.kind == .connector && entries.first?.outcome == .authorised)
    #expect(entries.first?.summary == "calendar" && entries.first?.session == "rt-1" && entries.first?.bot == bot)
    await assertNoLeak(log)
  }

  @Test("Not now and Cancel are logged once the gateway took them")
  func connectorSkipped() async throws {
    let log = try DecisionFixture.log()
    let calls = RecordingCalls()
    let model = connection(log, calls: calls)

    calls.failing(true)
    #expect(await model.skip(chat: bot, target: "mail") == false)
    #expect(await log.count() == 0)

    calls.failing(false)
    #expect(await model.skip(chat: bot, target: "mail"))
    #expect(await model.cancel(chat: bot))

    let entries = await log.entries()

    #expect(entries.count == 2)
    #expect(entries.first { $0.outcome == .declined }?.summary == "mail")
    #expect(entries.first { $0.outcome == .skipped }?.summary == nil)
  }

  // MARK: Without a log

  @Test("a session without a log answers as before and keeps nothing")
  func noLog() async throws {
    let harness = SessionHarness()

    try await harness.start()
    harness.link.respond(to: RPC.ApprovalReceived.name, with: ["acknowledged": true])

    let requests = RequestsModel(chat: harness.session.chat(bot))

    try await harness.open()
    try await harness.frame()
    harness.link.raise(
      id: "srq-1", method: "approval",
      params: ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "ls", "choices": ["once", "deny"]])
    harness.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": [["request_id": "appr-1"]]])
    try await harness.frame()
    await requests.answerApproval("srq-1", choice: "once")

    #expect(harness.link.answers.map(\.id) == ["srq-1"])
    #expect(!harness.session.decisions.isRecording)
    await harness.session.shutdown()
  }

  // MARK: Mapping

  @Test("every request method maps to one kind, and an unknown one to none")
  func kinds() {
    #expect(DecisionRecorder.kind(ofRequest: "secret") == .secure)
    #expect(DecisionRecorder.kind(ofRequest: "vault.unlock_prompt") == .secure)
    #expect(DecisionRecorder.kind(ofRequest: "device.contact") == .device)
    #expect(DecisionRecorder.kind(ofRequest: "device.scan") == .device)
    #expect(DecisionRecorder.kind(ofRequest: "input.signature") == .input)
    #expect(DecisionRecorder.kind(ofRequest: "review.diff") == .review)
    #expect(DecisionRecorder.kind(ofRequest: "confirm") == .confirm)
    #expect(DecisionRecorder.kind(ofRequest: "terminal.read") == nil)

    for method in ServerRequestBody.Method.interactive {
      #expect(DecisionRecorder.kind(ofRequest: method) != nil, "\(method)")
    }
  }

  @Test("an approval's choices map to their outcomes, and one this build does not know is only answered")
  func approvalOutcomes() {
    #expect(DecisionRecorder.outcome(ofApproval: "once") == .approved)
    #expect(DecisionRecorder.outcome(ofApproval: "session") == .approvedSession)
    #expect(DecisionRecorder.outcome(ofApproval: "always") == .approvedAlways)
    #expect(DecisionRecorder.outcome(ofApproval: "deny") == .denied)
    #expect(DecisionRecorder.outcome(ofApproval: "maybe") == .answered)
  }

  @Test("a request method that is not one of the protocol's is not kept as a summary")
  func unknownMethodIsNotAPayload() async throws {
    let log = try DecisionFixture.log()
    let recorder = DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home")

    await recorder.interactive(request: "something \(Marker.secret)", outcome: .answered, bot: bot, session: "s", via: .tap)
    await recorder.secure(entered: true, bot: bot, session: "s", request: "secret \(Marker.secret)", via: .tap)

    let entries = await log.entries()

    #expect(entries.count == 1, "an interactive request of no known kind is not logged")
    #expect(entries.first?.summary == nil, "a method name that is not the protocol's is dropped")
    #expect(!(await log.dump()).contains(Marker.secret))
  }
}
