import Foundation
import Testing

@testable import HermieProtocol

@Suite("Envelopes, events and methods")
struct EnvelopeTests {
  // MARK: Tolerance

  @Test func anUnknownEventTypeDecodesAndSurvivesARoundTrip() throws {
    let text = #"{"jsonrpc":"2.0","method":"event","params":{"type":"moa.reference","session_id":"s1","seq":4,"payload":{"label":"a","text":"b","nested":[1,{"x":null}]},"profile":"p"}}"#
    let frame = try #require(try InboundFrame(parsing: Data(text.utf8)))
    guard case .event(let notification) = frame else {
      Issue.record("not classified as an event: \(frame)")
      return
    }
    let event = notification.event
    #expect(event.type == "moa.reference")
    #expect(event.sessionID == "s1")
    #expect(event.seq == 4)
    guard case .unknown(let type, let payload) = event.body else {
      Issue.record("an unknown type read as a known one")
      return
    }
    #expect(type == "moa.reference")
    #expect(payload?["nested"]?[1]?["x"]?.isNull == true)
    #expect(try canonical(frame) == canonical(JSONValue(parsing: text)))
    // Rebuilt from the typed body alone, only the renderer-side `profile` tag is left behind.
    let rebuilt = GatewayEvent(event.body, sessionID: event.sessionID, seq: event.seq)
    var expected = event.json
    expected["profile"] = nil
    #expect(try canonical(rebuilt) == canonical(JSONValue.object(expected)))
  }

  @Test func anUnknownEnumValueDecodesAndSurvivesARoundTrip() throws {
    let raw: JSONValue = ["text": "done", "status": "paused_by_operator", "usage": ["input": 3, "future_field": [1]]]
    let payload = try #require(MessageCompletePayload(jsonValue: raw))
    #expect(payload.status == .unknown("paused_by_operator"))
    #expect(payload.status?.isKnown == false)
    #expect(payload.usage?.input == 3)
    #expect(try canonical(payload) == canonical(raw))

    var edited = payload
    edited.text = "changed"
    #expect(edited.json["status"] == "paused_by_operator")
    #expect(edited.json["usage"]?["future_field"] == [1])

    #expect(TurnStatus(rawValue: "complete") == .complete)
    #expect(TurnStatus(jsonValue: "interrupted") == .interrupted)
    #expect(ApprovalChoice(rawValue: "forever") == .unknown("forever"))
    #expect(ApprovalChoice.unknown("forever").rawValue == "forever")
    #expect(InterruptStatus(rawValue: "not_interrupted") == .notInterrupted)
  }

  @Test func wrongTypesReadAsAbsentAndAreKept() throws {
    let raw: JSONValue = ["tool_id": 7, "name": "x", "args": "not an object", "duration_s": "1s", "todos": [1, "a"]]
    let payload = try #require(ToolCompletePayload(jsonValue: raw))
    #expect(payload.toolID == nil)
    #expect(payload.name == "x")
    #expect(payload.args == nil)
    #expect(payload.durationS == nil)
    #expect(payload.todos == [1, "a"])
    #expect(try canonical(payload) == canonical(raw))
    // An array keeps the elements that convert, as the reference's `.filter` does.
    let risk = try #require(ToolOutputRiskPayload(jsonValue: ["findings": ["a", 2, "b", nil]]))
    #expect(risk.findings == ["a", "b"])
  }

  @Test func nullAndAbsentStayDistinctOnReencode() throws {
    let raw: JSONValue = ["text": "a", "rendered": nil]
    let payload = try #require(StreamDeltaPayload(jsonValue: raw))
    #expect(payload.rendered == nil)
    #expect(try canonical(payload) == #"{"rendered":null,"text":"a"}"#)
    var cleared = payload
    cleared.rendered = nil
    #expect(try canonical(cleared) == #"{"text":"a"}"#)
  }

  @Test func aKnownEventWithoutAnObjectPayloadReadsAsEmptyAndKeepsItsPayload() throws {
    let absent = try #require(GatewayEvent(jsonValue: ["type": "message.start", "session_id": "s", "seq": 1]))
    guard case .messageStart(let payload) = absent.body else {
      Issue.record("message.start did not read as one")
      return
    }
    #expect(payload.json.isEmpty)
    #expect(absent.payload == nil)
    #expect(try canonical(absent) == #"{"seq":1,"session_id":"s","type":"message.start"}"#)

    let scalar = try #require(GatewayEvent(jsonValue: ["type": "message.delta", "payload": "x"]))
    guard case .messageDelta(let delta) = scalar.body else {
      Issue.record("message.delta did not read as one")
      return
    }
    #expect(delta.text == nil)
    #expect(scalar.payload == "x")
  }

  @Test func everyListedEventTypeReadsIntoATypedCase() {
    for type in GatewayEventType.all {
      let body = GatewayEventBody(type: type, payload: .object([:]))
      #expect(!body.isUnknown, "\(type)")
      #expect(body.type == type)
      #expect(body.payload == .object([:]))
    }
    #expect(Set(GatewayEventType.all).count == GatewayEventType.all.count)
    for synthetic in ["bot_dm_in", "bot_dm_reply", "cron_delivery"] {
      #expect(GatewayEventBody(type: synthetic, payload: nil).isUnknown)
    }
  }

  @Test func readsTheTypedFieldsOfATurn() throws {
    let complete = try #require(
      GatewayEvent(jsonValue: [
        "type": "message.complete", "session_id": "run-1", "seq": 9,
        "payload": [
          "text": "", "status": "error", "error": "429", "partial": true, "recoverable": true,
          "error_surface": ["layer": "provider", "code": "rate_limited", "retryable": true],
          "usage": ["input": 10, "output": 20, "total": 30, "context_percent": 2.6]
        ]
      ]))
    guard case .messageComplete(let payload) = complete.body else {
      Issue.record("not message.complete")
      return
    }
    #expect(payload.status == .error)
    #expect(payload.error == "429")
    #expect(payload.partial == true)
    #expect(payload.errorSurface?.code == "rate_limited")
    #expect(payload.errorSurface?.retryable == true)
    #expect(payload.usage?.total == 30)
    #expect(payload.usage?.contextPercent == 2.6)

    let ready = GatewayReadyPayload(json: ["skin": [:], "change_events": true, "replay_epoch": "e1", "heartbeat": true])
    #expect(ready.heartbeat == true)
    #expect(ready.replayEpoch == "e1")
    #expect(ready.skin?.json.isEmpty == true)
  }

  // MARK: JSON-RPC

  @Test func mintsRequestIDsAsTheReferenceDoes() {
    var ids = RequestIDSequence()
    #expect(ids.next() == .string("r1"))
    #expect(ids.next() == .string("r2"))
    #expect(ids.next().description == "r3")
    #expect(JSONRPCID(jsonValue: 7) == .number(7))
    #expect(JSONRPCID(jsonValue: true) == nil)
  }

  @Test func buildsTypedRequests() throws {
    let request = JSONRPCRequest(id: .string("r1"), RPC.PromptSubmit.self, params: .init(sessionID: "s", text: "hi"))
    #expect(
      try canonical(request)
        == #"{"id":"r1","jsonrpc":"2.0","method":"prompt.submit","params":{"session_id":"s","text":"hi"}}"#)
    let ping = JSONRPCRequest(id: .string("heartbeat-1"), method: RPC.GatewayPing.name)
    #expect(try canonical(ping) == #"{"id":"heartbeat-1","jsonrpc":"2.0","method":"gateway.ping","params":{}}"#)
    let since = JSONRPCRequest(id: .string("r2"), RPC.SessionEventsSince.self, params: .init(sessionID: "s", lastSeen: 97))
    #expect(since.params?["last_seen"] == 97)
  }

  @Test func classifiesFramesExactlyAsHandleFrame() throws {
    func classify(_ text: String) throws -> String {
      guard let frame = try InboundFrame(parsing: Data(text.utf8)) else { return "nil" }
      switch frame {
      case .serverRequest: return "request"
      case .response: return "response"
      case .event: return "event"
      case .other: return "other"
      }
    }
    #expect(try classify(#"{"jsonrpc":"2.0","id":"srq-1","method":"clarify","params":{}}"#) == "request")
    #expect(try classify(#"{"jsonrpc":"2.0","id":"r1","result":{}}"#) == "response")
    #expect(try classify(#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601}}"#) == "response")
    // A numeric id with a method is a response to the reference, not a server request.
    #expect(try classify(#"{"id":3,"method":"approval"}"#) == "response")
    // `method: "event"` with an id is not a server request either.
    #expect(try classify(#"{"id":"x","method":"event","params":{"type":"notice"}}"#) == "response")
    #expect(try classify(#"{"jsonrpc":"2.0","method":"event","params":{"type":"notice","payload":{}}}"#) == "event")
    #expect(try classify(#"{"method":"event","params":{"payload":{}}}"#) == "other")
    #expect(try classify(#"{"id":null,"method":"event","params":{"type":"notice"}}"#) == "event")
    #expect(try classify("[1]") == "nil")
    #expect(try classify("null") == "nil")
    #expect(throws: JSONParseError.self) { try InboundFrame(parsing: Data("{".utf8)) }
  }

  @Test func readsResponseOutcomes() throws {
    let ok = JSONRPCResponse(json: ["jsonrpc": "2.0", "id": "r1", "result": ["status": "queued"]])
    #expect(ok.result(of: RPC.PromptSubmit.self)?.status == .queued)
    let failed = JSONRPCResponse(json: ["jsonrpc": "2.0", "id": "r2", "error": ["code": 4001, "message": "no", "data": [1]]])
    guard case .failure(let error) = failed.outcome else {
      Issue.record("an error answer read as success")
      return
    }
    #expect(error.code == 4001)
    #expect(error.message == "no")
    #expect(error.data == [1])
    #expect(failed.result(of: RPC.PromptSubmit.self) == nil)
    let empty = JSONRPCResponse(json: ["id": "r3"])
    #expect(empty.outcome == .success(.null))
  }

  @Test func answersServerRequests() throws {
    let request = ServerRequest(json: [
      "jsonrpc": "2.0", "id": "srq-7", "method": "approval",
      "params": ["session_id": "s", "request_id": "apr-3", "command": "rm", "choices": ["once", "deny", "later"]]
    ])
    guard case .approval(let params) = request.body else {
      Issue.record("approval did not read as one")
      return
    }
    #expect(params.requestID == "apr-3")
    #expect(params.choices == [.once, .deny, .unknown("later")])
    #expect(request.sessionID == "s")

    let answer = try #require(request.respond(ApprovalResult(choice: .once).jsonValue))
    #expect(try canonical(answer) == #"{"id":"srq-7","jsonrpc":"2.0","result":{"choice":"once"}}"#)
    let refusal = try #require(request.fail(code: JSONRPCError.methodNotFound, message: "no handler"))
    #expect(try canonical(refusal) == #"{"error":{"code":-32601,"message":"no handler"},"id":"srq-7","jsonrpc":"2.0"}"#)

    let other = ServerRequest(id: "srq-9", method: "tour", params: ["session_id": "s"])
    #expect(other.body == .unknown(method: "tour", params: ["session_id": "s"]))
    #expect(!other.body.isSecureInput)
    #expect(ServerRequest(json: ["id": "a", "method": "clarify", "params": "x"]).params.isEmpty)
  }

  @Test func readsTheOneStringPrompts() throws {
    let secret = ServerRequest(
      id: "srq-1", method: "secret",
      params: ["session_id": "s", "env_var": "API_KEY", "prompt": "Paste the key", "metadata": ["skill": "x"]])
    guard case .secret(let params) = secret.body else {
      Issue.record("secret did not read as one")
      return
    }
    #expect(params.envVar == "API_KEY")
    #expect(params.prompt == "Paste the key")
    #expect(params.metadata == ["skill": "x"])
    #expect(secret.body.isSecureInput)

    #expect(ServerRequest(id: "a", method: "sudo", params: ["command": "apt install x"]).body
      == .sudo(SudoRequestParams(json: ["command": "apt install x"])))
    #expect(ServerRequest(id: "a", method: "vault.unlock_prompt", params: ["backend": "b", "display_name": "B"]).body
      == .vaultUnlock(VaultUnlockRequestParams(json: ["backend": "b", "display_name": "B"])))
    #expect(ServerRequest(id: "a", method: "vault.code", params: ["site": "example.com"]).body
      == .vaultCode(VaultCodeRequestParams(json: ["site": "example.com"])))
    #expect(ServerRequest(id: "a", method: "vault.save_login", params: ["origin": "o", "site": "s"]).body
      == .vaultSaveLogin(VaultSaveLoginRequestParams(json: ["origin": "o", "site": "s"])))
    #expect(ServerRequestBody.Method.secureInput.count == 5)

    // The answer goes out as it is, but never shows in a description or a mirror.
    let result = ValueResult(value: "hunter2-value")
    let answer = try #require(secret.respond(result.jsonValue))
    #expect(try canonical(answer) == #"{"id":"srq-1","jsonrpc":"2.0","result":{"value":"hunter2-value"}}"#)
    var dumped = ""
    dump(result, to: &dumped)
    for text in [String(describing: result), String(reflecting: result), "\(result)", dumped] {
      #expect(!text.contains("hunter2"))
    }
  }

  @Test func readsAResumeSnapshot() throws {
    let result = try #require(
      SessionResumeResult(jsonValue: [
        "session_id": "runtime-1", "stored_session_id": "stored-1", "message_count": 2, "messages": [],
        "info": ["model": "m", "running": true, "desktop_contract": 7, "usage": ["calls": 1]],
        "inflight": ["assistant": "partial", "streaming": true],
        "open_requests": [["id": "srq-1", "method": "clarify", "params": ["session_id": "runtime-1", "question": "?"]]],
        "todo_state": ["todos": [["content": "x"]], "revision": 3]
      ]))
    #expect(result.sessionID == "runtime-1")
    #expect(result.info?.running == true)
    #expect(result.info?.desktopContract == 7)
    #expect(result.inflight?.assistant == "partial")
    #expect(result.openRequests?.first?.method == "clarify")
    if case .clarify(let params) = result.openRequests?.first?.body {
      #expect(params.question == "?")
    } else {
      Issue.record("open request did not read as clarify")
    }
    #expect(result.todoState?.revision == 3)
  }

  @Test func catalogueNamesAreUnique() {
    #expect(Set(RPC.allMethodNames).count == RPC.allMethodNames.count)
    #expect(RPC.allMethodNames.contains("session.events.since"))
    #expect(RPC.SessionSteer.name == "session.steer")
  }

  // MARK: REST

  @Test func readsTheRESTBodies() throws {
    let status = try StatusResponse(parsing: Data(#"{"version":"0.21.3","auth_required":true,"auth_flows":["cookie","native_pkce"]}"#.utf8))
    #expect(status.authRequired == true)
    #expect(status.authFlows?.contains(StatusResponse.nativePKCEFlow) == true)

    let tokens = NativeTokenResponse(json: [
      "access_token": "at", "refresh_token": "rt", "token_type": "Bearer", "expires_at": 1_790_003_600,
      "provider": "p", "user_id": "u"
    ])
    #expect(tokens.expiresAt == 1_790_003_600)
    #expect(try canonical(NativeTokenRequest(code: "c", codeVerifier: "v")) == #"{"code":"c","code_verifier":"v"}"#)
    #expect(
      try canonical(NativeRefreshRequest(refreshToken: "rt", provider: "p")) == #"{"provider":"p","refresh_token":"rt"}"#)

    let error = RESTErrorBody(json: ["error": "session_expired", "detail": "Refresh token expired"])
    #expect(error.detailText == "Refresh token expired")
    #expect(error.error == "session_expired")

    let upload = FileUploadResponse(json: [
      "ok": true, "path": "/tmp/a.png", "root": nil, "locked_root": nil, "can_change_path": true,
      "entry": ["name": "a.png", "path": "/tmp/a.png", "is_directory": false, "size": 12, "mtime": 1.5, "mime_type": "image/png"]
    ])
    #expect(upload.entry?.size == 12)
    #expect(upload.root == nil)
    #expect(upload.json["root"] == .null)

    #expect(RESTPath.sessionMessages("stored/1 a") == "/api/sessions/stored%2F1%20a/messages")
    #expect(RESTPath.profile("default") == "/api/profiles/default")

    #expect(throws: JSONDecodeFailure.notAnObject) { try StatusResponse(parsing: Data("[]".utf8)) }
  }
}
