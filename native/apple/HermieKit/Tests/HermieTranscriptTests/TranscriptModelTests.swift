import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// What the golden corpus cannot show: the model's own guarantees, the calls the
/// recorder could not write down, and the JavaScript semantics the regular
/// expressions are rewritten to keep.
@Suite struct TranscriptModelTests {
  // MARK: Losslessness

  @Test func unknownKeysKindsAndSpellingsSurvive() throws {
    let json: JSONValue = [
      "id": "a:1", "kind": "assistant", "seq": 1000, "origin": "teleported", "version": 2,
      "text": "hi", "streaming": false, "interim": false, "status": "paused",
      "futureField": ["nested": [1, 2.5, nil]],
      "durationS": nil
    ]
    let item = try TranscriptItem(decoding: json)
    #expect(item.origin == .other("teleported"))
    #expect(item.asAssistant?.status == .other("paused"))
    #expect(item.asAssistant?.durationS == nil)
    #expect(item.jsonValue == json)

    let future: JSONValue = ["id": "x", "kind": "hologram", "seq": 0, "origin": "live", "version": 0, "beam": true]
    let unknown = try TranscriptItem(decoding: future)
    #expect(unknown.kind == .other("hologram"))
    #expect(unknown.id == "x")
    #expect(unknown.jsonValue == future)
  }

  /// `Codable` goes through the same mapping (not a synthesised one), so a state
  /// written with `JSONEncoder` is the TypeScript shape too.
  @Test func codableUsesTheTypeScriptShape() throws {
    let suite = try GoldenCorpus.loadSuite("turn-activity")
    let calls = suite.tests.flatMap(\.calls).filter { $0.op == "turnActivity" }
    // The richest state the suite hands `turnActivity`.
    let raw = try #require(calls.map { $0.args[0] }.max { ($0["items"]?.objectValue?.count ?? 0) < ($1["items"]?.objectValue?.count ?? 0) })
    let state = try ChatState(decoding: raw)
    #expect(state.items.count > 1)

    let data = try JSONEncoder().encode(state)
    #expect(try JSONValue(parsing: data) == raw)
    #expect(try JSONDecoder().decode(ChatState.self, from: data) == state)

    let item = try #require(state.items.values.first)
    #expect(try JSONValue(parsing: JSONEncoder().encode(item)) == item.jsonValue)
    // Enums spell their `Codable` members out; the synthesised ones would write
    // `{"other":{"_0":"x"}}`.
    #expect(try JSONValue(parsing: JSONEncoder().encode(ItemOrigin.other("x"))) == "x")
    #expect(try JSONValue(parsing: JSONEncoder().encode(Subagent.Status.queued)) == "queued")
    #expect(try JSONValue(parsing: JSONEncoder().encode(NoticeKind.systemNote)) == "system_note")
    #expect(try JSONValue(parsing: JSONEncoder().encode(TurnActivity.tool("grep"))) == ["kind": "tool", "tool": "grep"])
    #expect(try JSONDecoder().decode(TurnActivity.self, from: Data(#"{"kind":"typing"}"#.utf8)) == .typing)
    #expect(try JSONDecoder().decode([ToolStatus].self, from: Data(#"["unknown","later"]"#.utf8)) == [.unknown, .other("later")])
  }

  @Test func aFractionWhereTheEngineCountsIsAnError() {
    let json: JSONValue = ["id": "u", "kind": "user", "seq": 1.5, "origin": "live", "version": 0, "text": ""]
    #expect(throws: TranscriptDecodingError.self) { try TranscriptItem(decoding: json) }

    // Optional: kept raw instead.
    let optional: JSONValue = ["id": "u", "kind": "user", "seq": 1, "rowId": 2.5, "origin": "live", "version": 0, "text": ""]
    let item = try? TranscriptItem(decoding: optional)
    #expect(item?.rowID == nil)
    #expect(item?.jsonValue == optional)
  }

  @Test func decodingErrorsSayWhere() throws {
    var state = createChatState("b", "s", "s").jsonValue.objectValue!
    state["items"] = ["a:1": ["id": "a:1", "kind": "assistant", "seq": 0, "origin": "live", "version": 0, "text": 5]]
    do {
      _ = try ChatState(decoding: .object(state))
      Issue.record("decoded a state with a numeric text")
    } catch {
      #expect(error.path == #"items["a:1"].text"#)
    }
  }

  @Test func subagentsEnumerateInJavaScriptOrder() throws {
    func child(_ id: String) -> JSONValue {
      [
        "id": .string(id), "parentId": nil, "goal": "g", "taskIndex": 0, "taskCount": 1, "status": "running",
        "startedAt": 0, "updatedAt": 0, "filesRead": [], "filesWritten": [], "stream": []
      ]
    }
    var state = createChatState("b", "s", "s").jsonValue.objectValue!
    state["subagents"] = ["b": child("b"), "10": child("10"), "a": child("a"), "9": child("9"), "01": child("01")]
    var decoded = try ChatState(decoding: .object(state))
    #expect(decoded.subagents.keys == ["9", "10", "01", "a", "b"])

    decoded.subagents["0"] = decoded.subagents["a"]
    decoded.subagents["aa"] = decoded.subagents["a"]
    decoded.subagents["a"] = decoded.subagents["b"]
    #expect(decoded.subagents.keys == ["0", "9", "10", "01", "a", "b", "aa"])
    decoded.subagents["a"] = nil
    #expect(decoded.subagents.keys == ["0", "9", "10", "01", "b", "aa"])
    #expect(decoded.jsonValue["subagents"]?.objectValue?.count == 6)
  }

  @Test func updatingAnItemInPlaceKeepsEverythingElse() {
    var item = TranscriptItem.assistant(
      AssistantItem(
        base: ItemBase(id: "a", seq: 0, origin: .live, version: 0),
        text: "x",
        streaming: true,
        interim: false,
        extra: ["k": 1]
      )
    )
    item.updateAssistant { $0.text += "y" }
    #expect(item.updateTool { _ in 1 } == nil)
    item.version += 1
    #expect(item.asAssistant?.text == "xy")
    #expect(item.version == 1)
    #expect(item.asAssistant?.extra == ["k": 1])
  }

  // MARK: Leaf helpers beyond the corpus

  @Test func freeItemIDSuffixesTheLaterOne() {
    let taken: [String: Int] = ["a": 1, "a#2": 1, "a#3": 1]
    #expect(freeItemID(taken, "b") == "b")
    #expect(freeItemID(taken, "a") == "a#4")
  }

  /// The two `contextUsageOf` calls the recorder skipped (`args: non-finite-number`).
  @Test func contextUsageRefusesNonFiniteFigures() {
    #expect(contextUsageOf(Usage(json: ["context_max": .number(.nan), "context_used": 10])) == nil)
    #expect(contextUsageOf(Usage(json: ["context_max": 100, "context_used": -1])) == nil)
    #expect(contextUsageOf(Usage(json: ["context_max": .number(.infinity), "context_used": 10])) == nil)
  }

  @Test func contextUsageRoundsLikeMathRound() {
    #expect(contextUsageOf(Usage(json: ["context_max": 200, "context_used": 1]))?.percent == 1)  // 0.5 → 1
    #expect(contextUsageOf(Usage(json: ["context_max": 1000, "context_used": 5]))?.percent == 1)  // 0.5 → 1
    #expect(JS.round(0.49999999999999994) == 0)
    #expect(JS.round(2.5) == 3)
    #expect(contextUsageOf(Usage(json: ["context_max": 100, "context_used": 250]))?.fraction == 1)
  }

  @Test func subagentProgressFoldsAPayload() {
    let first = toSubagent(
      [
        "subagent_id": "sa-1", "goal": "Audit", "task_index": 1, "task_count": 3, "tool_name": "read_file",
        "tool_preview": "  a.txt  "
      ],
      nil, "subagent.tool", 1000
    )
    #expect(first.parentID == nil)
    #expect(first.currentTool == "read_file")
    #expect(first.stream.map(\.text) == [#"Read File("a.txt")"#])
    #expect(first.jsonValue["parentId"] == .null)

    let done = toSubagent(["status": "timeout", "duration_seconds": 12.5], first, "subagent.complete", 2000)
    #expect(done.status == .failed)
    #expect(done.summary == "Timed out after 12.5s")
    #expect(done.currentTool == nil)
    #expect(done.startedAt == 1000)
    #expect(done.stream.last?.isError == true)
    #expect(subagentIDOf(["goal": "g", "task_index": 2]) == "root:2:g")
  }

  // MARK: JavaScript regular-expression semantics

  @Test func whitespaceIsJavaScriptsSet() {
    // U+FEFF and U+000B are `\s` in JavaScript and not in ICU; U+0085 is the reverse.
    #expect(unwrapSystemNote("[System:\u{FEFF}note]\u{000B}") == "note")
    #expect(JS.trim("\u{FEFF} x \u{000B}") == "x")
    #expect(JS.trim("\u{0085}x") == "\u{0085}x")
  }

  @Test func dollarIsTheVeryEnd() {
    // ICU's `$` would also match before a final line terminator (U+0085 is one to
    // ICU, and neither a line break nor the end to JavaScript).
    #expect(parseCronDelivery("[Cron delivery: Brief]\u{0085}") == nil)
    #expect(parseCronDelivery("[Cron delivery: Brief]")?.body == "")
  }

  @Test func wordBoundaryIsASCII() {
    // `\b` after `DELEGATION`: an accented letter is not a word character in JavaScript.
    #expect(parseInjectedRow("[ASYNC DELEGATIONé — x]\nbody")?.noticeKind == .asyncDelegationComplete)
    #expect(parseInjectedRow("[ASYNC DELEGATIONS — x]\nbody")?.noticeKind == .internalNotification)
  }

  @Test func offsetsAreUTF16() {
    // `\r\n` is one Swift Character but two JavaScript code units.
    let parsed = parseCronDelivery("[Cron delivery: Brief]\r\nbody")
    #expect(parsed?.body == "body")
    #expect(parseInjectedRow("[NOTE]\r\n🔄 body")?.title == "NOTE")
  }
}
