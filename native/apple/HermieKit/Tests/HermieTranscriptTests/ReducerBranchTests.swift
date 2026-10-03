import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

// Hand-written reducer scenarios for the branches the golden corpus does not reach.
//
// The corpus replays every call the TypeScript test suites made, and a code
// coverage run of it over `Reducer*.swift` leaves a handful of branches unvisited
// (the interim note that opens a new stretch, `reducer.ts:669`, among them). Each
// scenario below drives those branches from an empty state. The `expected` state
// of each was RECORDED by running the same steps through the TypeScript engine
// (`packages/transcript/src`), so these assert parity with the TypeScript, not the
// port's reading of it. Steps use the corpus conventions: a `null` argument is
// "not supplied", `patchState` is the stream scenarios' `{ ...state, ...fields }`.
// A step may also name one of the state-first history operations (`reconcile`,
// `reconcileTail`, `prependHistory`), for the identity branches that live there;
// its items are written out as the engine holds them.
//
// Re-recording after a deliberate TypeScript change, or after adding a scenario
// (its `expected` may start as `null`): `npm run golden:branch-cases` runs every
// scenario's steps through the TypeScript functions of the same names, starting
// from `createChatState('bot', 'stored', 'resolved')`, and rewrites each
// `expected` line in place (`scripts/golden/record-branch-cases.ts`).

@Suite(.serialized) struct ReducerBranchTests {
  static let scenarios: [JSONValue] = {
    guard case .array(let scenarios)? = try? JSONValue(parsing: fixture) else {
      preconditionFailure("the reducer branch fixture is not a JSON array")
    }
    return scenarios
  }()

  static let names: [String] = scenarios.compactMap { $0["name"]?.stringValue }

  /// Replays one scenario's steps through the golden operation table.
  static func replay(_ steps: [JSONValue]) throws -> JSONValue {
    var state = createChatState("bot", "stored", "resolved").jsonValue

    for step in steps {
      guard case .array(let parts) = step, let op = parts.first?.stringValue else {
        throw GoldenHarnessError("malformed step \(step)")
      }
      let args = Array(parts.dropFirst())

      if op == "patchState" {
        state = try GoldenStreamRunner.patchState(state, args.first, args.count > 1 ? args[1] : nil)
        continue
      }

      guard let operation = GoldenOps.reducer[op] ?? GoldenOps.history[op] else {
        throw GoldenHarnessError("no reducer or history operation \(op)")
      }
      state = try operation(GoldenArgs([state] + args)) ?? .null
    }

    return state
  }

  @Test(arguments: names)
  func scenarioMatchesTheTypeScript(_ name: String) throws {
    let scenario = try #require(Self.scenarios.first { $0["name"]?.stringValue == name })
    let steps = try #require(scenario["steps"]?.arrayValue)
    let expected = try #require(scenario["expected"])
    let actual = try Self.replay(steps)

    // Strict: a `null` written where the TypeScript omits a key is a difference here.
    switch GoldenCompare.compare(expected: expected, actual: actual) {
    case .equal:
      break
    case .equalModuloNull:
      Issue.record("\(name): equal only once null and absent members are treated alike")
    case .different(let lines):
      Issue.record(Comment(rawValue: "\(name) (\(scenario["covers"]?.stringValue ?? "")):\n  " + lines.joined(separator: "\n  ")))
    }
  }

  // MARK: Readable spot checks of the same branches

  /// `reducer.ts:669`: no live bubble, and the last item is a tool card, so the
  /// preview is a new sealed note rather than a rewrite of an older one.
  @Test func anInterimAfterAToolCardStartsANewNote() {
    var state = createChatState("bot", "stored", "resolved")
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "payload": [:]]), 1_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "tool.start", "payload": ["tool_id": "c1", "name": "terminal"]]), 2_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.interim", "payload": ["text": "note"]]), 3_000)

    let note = state.items[state.order.last!]?.asAssistant
    #expect(note?.text == "note")
    #expect(note?.interim == true)
    #expect(note?.streaming == false)
    #expect(state.turn.assistantID == nil)

    // A status line after it does not stop the next preview from replacing it.
    applyEvent(into: &state, GatewayEvent(json: ["type": "status.update", "payload": ["kind": "x", "text": "busy"]]), 4_000)
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.interim", "payload": ["text": "note, longer"]]), 5_000)
    #expect(state.orderedItems.compactMap(\.asAssistant).map(\.text) == ["note, longer"])
  }

  /// The in-place form and the pure wrapper give the same state, and the wrapper
  /// leaves its input alone.
  @Test func theWrapperAndTheInPlaceFormAgree() {
    let start = beginLocalTurn(createChatState("bot", "stored", "resolved"), "hi", nil, 1_000)
    let event = GatewayEvent(json: ["type": "message.delta", "payload": ["text": "hello"], "seq": 3])

    var inPlace = start
    applyEvent(into: &inPlace, event, 2_000)
    let pure = applyEvent(start, event, 2_000)

    #expect(pure == inPlace)
    #expect(start.lastSeq == 0)
    #expect(start.turn.assistantID == nil)
    #expect(pure.lastSeq == 3)
  }

  // MARK: Argument types

  /// `string | Record<string, string>`, the record in JavaScript key order.
  @Test func aRequestAnswerRoundTripsAndRefusesOtherShapes() throws {
    #expect(try RequestAnswer(decoding: "yes") == .text("yes"))
    let record = try RequestAnswer(decoding: ["b": "2", "a": "1", "10": "x", "2": "y"])
    guard case .byQuestion(let answers) = record else {
      Issue.record("an object did not decode as answers by question")
      return
    }
    #expect(answers.keys == ["2", "10", "a", "b"])
    #expect(record.jsonValue == ["b": "2", "a": "1", "10": "x", "2": "y"])
    #expect(RequestAnswer(jsonValue: RequestAnswer.text("no").jsonValue) == .text("no"))
    #expect(throws: TranscriptDecodingError.self) { try RequestAnswer(decoding: 3) }
    #expect(throws: TranscriptDecodingError.self) { try RequestAnswer(decoding: ["a": 1]) }

    let encoded = try JSONEncoder().encode(record)
    #expect(try JSONDecoder().decode(RequestAnswer.self, from: encoded) == record)
  }

  @Test func aSnapshotRowReadsItsFields() {
    var row = SubagentSnapshotRow(json: [
      "subagent_id": "s1", "parent_id": nil, "depth": 2, "goal": "g", "delegation_id": "d", "model": "m",
      "started_at": 1_789_999_000, "status": "running", "tool_count": 3, "last_tool": "web", "accepting_steer": true,
      "child_session_id": "c"
    ])
    #expect(row.subagentID == "s1")
    #expect(row.parentID == nil)
    #expect(row.depth == 2)
    #expect(row.goal == "g")
    #expect(row.delegationID == "d")
    #expect(row.model == "m")
    #expect(row.startedAt == 1_789_999_000)
    #expect(row.status == "running")
    #expect(row.toolCount == 3)
    #expect(row.lastTool == "web")
    #expect(row.acceptingSteer == true)
    #expect(row.childSessionID == "c")

    row.subagentID = "s2"
    row.parentID = "p"
    row.depth = nil
    row.goal = nil
    row.delegationID = nil
    row.model = nil
    row.startedAt = nil
    row.status = nil
    row.toolCount = nil
    row.lastTool = nil
    row.acceptingSteer = nil
    row.childSessionID = nil
    #expect(row.json == ["subagent_id": "s2", "parent_id": "p"])
  }

  // MARK: Streaming cost

  /// A state holding `filler` settled items, a running turn, and the
  /// `message.delta` events to stream into it.
  static func streamingSetup(deltas: Int, filler: Int) -> (ChatState, [GatewayEvent]) {
    var state = createChatState("bench", "stored", "stored")
    for index in 0..<filler {
      let id = "r:\(index)"
      let base = ItemBase(id: id, seq: index * seqStep, rowID: index, origin: .history, version: 0)
      state.items[id] = .user(UserItem(base: base, text: "message \(index)"))
      state.order.append(id)
      state.byRowID[String(index)] = id
    }
    state.turn.nextSeq = (filler + 1) * seqStep
    applyEvent(into: &state, GatewayEvent(json: ["type": "message.start", "seq": 1]), 1_000)

    let events = (0..<deltas).map { index in
      GatewayEvent(json: ["type": "message.delta", "payload": ["text": "token · "], "seq": .number(Double(index + 2))])
    }
    return (state, events)
  }

  /// Streams the events into the state through the store's `inout` form.
  static func stream(deltas: Int, filler: Int) -> (seconds: Double, bytes: Int, version: Int) {
    var (state, events) = streamingSetup(deltas: deltas, filler: filler)
    let time = StateCopyBenchmarkTests.seconds {
      for event in events {
        applyEvent(into: &state, event, 2_000)
      }
    }
    let item = state.items[state.turn.assistantID ?? ""]?.asAssistant
    return (time, item?.text.utf8.count ?? 0, item?.version ?? -1)
  }

  /// The fastest of `runs` streams: the other test suites run alongside this one,
  /// and the minimum is the measurement they disturb least.
  static func fastest(of runs: Int, deltas: Int, filler: Int) -> (seconds: Double, bytes: Int, version: Int) {
    (0..<runs).map { _ in stream(deltas: deltas, filler: filler) }.min { $0.seconds < $1.seconds }!
  }

  @Test func tenThousandDeltasStreamInLinearTime() {
    let small = Self.fastest(of: 3, deltas: 10_000, filler: 500)
    let large = Self.fastest(of: 3, deltas: 40_000, filler: 500)
    let crowded = Self.fastest(of: 3, deltas: 10_000, filler: 10_000)
    print(
      String(
        format: "applyEvent(into:) message.delta: 10,000 deltas %.4f s, 40,000 deltas %.4f s (ratio %.2f); "
          + "10,000 deltas over a 10,000-item transcript %.4f s (ratio to 500 items %.2f)",
        small.seconds, large.seconds, large.seconds / small.seconds, crowded.seconds, crowded.seconds / small.seconds
      )
    )

    #expect(small.bytes == 10_000 * "token · ".utf8.count)
    // `version` counts the patches: one item, created at 0, bumped once per delta.
    #expect(small.version == 10_000)
    #expect(small.seconds < 2.0, "10,000 deltas took \(small.seconds) s")
    // Four times the deltas: linear is ×4, quadratic ×16. Room for timer noise.
    #expect(large.seconds / small.seconds < 8.0, "4× the deltas multiplied the time by \(large.seconds / small.seconds)")
    // Nothing per delta is proportional to the transcript.
    #expect(crowded.seconds / small.seconds < 4.0, "a 20× larger transcript multiplied the time by \(crowded.seconds / small.seconds)")
  }
}

/// The scenarios, with the state the TypeScript engine reached after each.
private let fixture = #"""
[
  {
    "name": "interim-after-tool-card",
    "covers": "message.interim with no live bubble and no open interim adds a sealed note (reducer.ts:669); a status line is skipped and the note replaced (openInterimId); empty interim and empty delta are no-ops",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"call-1","name":"terminal","args":{"command":"ls"}}},1790000002000],
      ["applyEvent",{"type":"message.interim","payload":{"text":"first note"}},1790000003000],
      ["applyEvent",{"type":"status.update","payload":{"kind":"thinking","text":"working"}},1790000004000],
      ["applyEvent",{"type":"status.update","payload":{"kind":"compacting","text":""}},1790000004000],
      ["applyEvent",{"type":"message.interim","payload":{"text":"first note, longer"}},1790000005000],
      ["applyEvent",{"type":"message.interim","payload":{}},1790000006000],
      ["applyEvent",{"type":"message.delta","payload":{"text":""}},1790000007000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"call-1":"t:call-1"},"compacting":true,"draft":"","hydration":"cold","items":{"a:3000":{"id":"a:3000","interim":true,"kind":"assistant","origin":"live","seq":3000,"streaming":false,"text":"first note, longer","ts":1790000003,"version":1},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"s:4000":{"id":"s:4000","kind":"status","origin":"live","seq":4000,"statusKind":"thinking","text":"working","ts":1790000004,"version":0},"t:call-1":{"args":{"command":"ls"},"id":"t:call-1","kind":"tool","name":"terminal","origin":"live","resultKnown":false,"seq":2000,"status":"running","toolId":"call-1","ts":1790000002,"version":0}},"lastSeq":0,"order":["f:1000","t:call-1","a:3000","s:4000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":5000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "interim-on-empty-transcript",
    "covers": "openInterimId on an empty order; the interim note is the first item",
    "steps": [
      ["applyEvent",{"type":"message.interim","payload":{"text":"hello"}},1790000001000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"draft":"","hydration":"cold","items":{"a:1000":{"id":"a:1000","interim":true,"kind":"assistant","origin":"live","seq":1000,"streaming":false,"text":"hello","ts":1790000001,"version":0}},"lastSeq":0,"order":["a:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "reasoning-verbose-and-held",
    "covers": "empty reasoning is ignored; `verbose` marks the item; reasoning.available after a tool seal goes back to the held item (reasoningTargetId)",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"reasoning.delta","payload":{"text":""}},1790000002000],
      ["applyEvent",{"type":"reasoning.delta","payload":{"text":"think ","verbose":true}},1790000003000],
      ["applyEvent",{"type":"thinking.delta","payload":{"text":"more"}},1790000004000],
      ["applyEvent",{"type":"message.delta","payload":{"text":"Let me look."}},1790000005000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"c1","name":"read_file"}},1790000006000],
      ["applyEvent",{"type":"reasoning.available","payload":{"text":"think more, summarised"}},1790000007000],
      ["applyEvent",{"type":"tool.complete","payload":{"tool_id":"c1","result_text":"ok"}},1790000008000],
      ["applyEvent",{"type":"message.complete","payload":{"text":"Let me look. Done."}},1790000009000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"c1":"t:c1"},"compacting":false,"draft":"","hydration":"cold","items":{"a:2000":{"durationS":8,"id":"a:2000","interim":false,"kind":"assistant","origin":"live","reasoning":"think more, summarised","reasoningVerbose":true,"seq":2000,"status":"complete","streaming":false,"text":"Let me look. Done.","ts":1790000003,"version":6},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"t:c1":{"id":"t:c1","isError":false,"kind":"tool","name":"read_file","origin":"live","resultKnown":true,"resultText":"ok","seq":3000,"status":"complete","toolId":"c1","ts":1790000006,"version":1}},"lastSeq":0,"order":["f:1000","a:2000","t:c1"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":4000},"unreadCount":0}
  },
  {
    "name": "seal-drops-blank-bubble",
    "covers": "sealAssistantForTool drops a bubble with only whitespace text and reasoning; interimContinuedBy refuses a blank sealed text",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"reasoning.delta","payload":{"text":"   "}},1790000002000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"c1","name":"terminal"}},1790000003000],
      ["applyEvent",{"type":"message.interim","payload":{"text":"   "}},1790000004000],
      ["applyEvent",{"type":"message.complete","payload":{"text":"The answer."}},1790000005000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"c1":"t:c1"},"compacting":false,"draft":"","hydration":"cold","items":{"a:4000":{"id":"a:4000","interim":true,"kind":"assistant","origin":"live","seq":4000,"streaming":false,"text":"   ","ts":1790000004,"version":0},"a:5000":{"durationS":4,"id":"a:5000","interim":false,"kind":"assistant","origin":"live","seq":5000,"status":"complete","streaming":false,"text":"The answer.","ts":1790000005,"version":1},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"t:c1":{"id":"t:c1","kind":"tool","name":"terminal","origin":"live","resultKnown":false,"seq":3000,"status":"running","toolId":"c1","ts":1790000003,"version":0}},"lastSeq":0,"order":["f:1000","t:c1","a:4000","a:5000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":6000},"unreadCount":0}
  },
  {
    "name": "error-without-bubble",
    "covers": "error with no assistant bubble creates one (currentAssistantId) and cancels open requests as turn_failed",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyServerRequest",{"id":"srq-1","method":"approval","params":{"command":"rm -rf build"}},1790000002000],
      ["applyEvent",{"type":"error","payload":{"message":""}},1790000003000]
    ],
    "expected": {"botName":"bot","byApprovalId":{"srq-1":"req:srq-1"},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{"srq-1":"req:srq-1"},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"cold","items":{"a:3000":{"error":{"message":"The gateway reported an error","partial":false},"id":"a:3000","interim":false,"kind":"assistant","origin":"live","seq":3000,"status":"error","streaming":false,"text":"","ts":1790000003,"version":1},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"req:srq-1":{"allowPermanent":true,"allowSession":true,"approvalId":"srq-1","cancelReason":"turn_failed","choices":["once","session","always","deny"],"command":"rm -rf build","id":"req:srq-1","kind":"approval","origin":"live","requestId":"srq-1","seq":2000,"state":"cancelled","ts":1790000002,"version":1}},"lastSeq":0,"order":["f:1000","req:srq-1","a:3000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":4000},"unreadCount":0}
  },
  {
    "name": "tool-edges",
    "covers": "delegate_task goal from `goal` and from no tasks; tool.output_risk on a dispatch and a delegation group (written as outputRisk on them); inline diff, todos and revision on tool.complete; output risk for an unknown id",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"d1","name":"delegate_task","args":{"goal":"  research x  "}}},1790000002000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"d2","name":"delegate_task","args":{"tasks":"nope"}}},1790000003000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"m1","name":"message_agent","args":{"target":"@Writer","message":"hi"}}},1790000004000],
      ["applyEvent",{"type":"tool.output_risk","payload":{"tool_id":"m1","risk":"high","findings":["secret",3],"redacted":true}},1790000005000],
      ["applyEvent",{"type":"tool.output_risk","payload":{"tool_id":"d1","risk":"low"}},1790000006000],
      ["applyEvent",{"type":"tool.output_risk","payload":{"tool_id":"nope","risk":"low"}},1790000006000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"e1","name":"patch","context":"a.txt","args_text":"{\"x\":1}"}},1790000007000],
      ["applyEvent",{"type":"tool.complete","payload":{"tool_id":"e1","inline_diff":"--- a\n+++ b","duration_s":1.5,"summary":"patched","error":"boom","result":null,"todos":[{"id":1,"content":"x","status":"pending"}],"revision":4}},1790000008000],
      ["applyEvent",{"type":"tool.complete","payload":{"tool_id":"e2","name":"","inline_diff":"   "}},1790000009000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"d1":"t:d1","d2":"t:d2","e1":"t:e1","e2":"t:e2","m1":"t:m1"},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"t:d1":{"goals":["research x"],"id":"t:d1","kind":"subagent_group","origin":"live","outputRisk":{"findings":[],"redacted":false,"risk":"low"},"rootIds":[],"seq":2000,"status":"dispatched","toolId":"d1","ts":1790000002,"version":1},"t:d2":{"goals":[],"id":"t:d2","kind":"subagent_group","origin":"live","rootIds":[],"seq":3000,"status":"dispatched","toolId":"d2","ts":1790000003,"version":0},"t:e1":{"argsText":"{\"x\":1}","context":"a.txt","durationS":1.5,"id":"t:e1","inlineDiff":"--- a\n+++ b","isError":true,"kind":"tool","name":"patch","origin":"live","result":null,"resultKnown":true,"seq":5000,"status":"error","summary":"patched","toolId":"e1","ts":1790000007,"version":1},"t:e2":{"id":"t:e2","isError":false,"kind":"tool","name":"tool","origin":"live","resultKnown":true,"seq":6000,"status":"complete","toolId":"e2","ts":1790000009,"version":1},"t:m1":{"dispatch":{"status":"sending"},"id":"t:m1","kind":"bot_dm_out","message":"hi","origin":"live","outputRisk":{"findings":["secret"],"redacted":true,"risk":"high"},"seq":4000,"target":"@Writer","targetHandle":"writer","toolId":"m1","ts":1790000004,"version":1}},"lastSeq":0,"order":["f:1000","t:d1","t:d2","t:m1","t:e1","t:e2"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"todo":{"revision":4,"todos":[{"content":"x","id":1,"status":"pending"}]},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":7000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "subagent-grouping",
    "covers": "groupForSubagent walks past a non-group item, stops at a finished group, skips a group of another delegation; spawn of an unknown child is ignored without create",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"subagent.start","payload":{"subagent_id":"s1","goal":"one"}},1790000002000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"c1","name":"terminal"}},1790000003000],
      ["applyEvent",{"type":"subagent.start","payload":{"subagent_id":"s2","goal":"two"}},1790000004000],
      ["applyEvent",{"type":"subagent.progress","payload":{"subagent_id":"ghost","text":"x"}},1790000005000],
      ["applyEvent",{"type":"subagent.complete","payload":{"subagent_id":"s1","status":"completed","summary":"done 1"}},1790000006000],
      ["applyEvent",{"type":"subagent.complete","payload":{"subagent_id":"s2","status":"failed","summary":"broke"}},1790000007000],
      ["applyEvent",{"type":"subagent.progress","payload":{"subagent_id":"s2","text":"late"}},1790000008000],
      ["applyEvent",{"type":"subagent.start","payload":{"subagent_id":"s3","goal":"three","delegation_id":"dA"}},1790000009000],
      ["applyEvent",{"type":"subagent.start","payload":{"subagent_id":"s4","goal":"four","delegation_id":"dB"}},1790000010000],
      ["applyEvent",{"type":"subagent.start","payload":{"subagent_id":"s5","goal":"five"}},1790000011000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{"dA":"g:4000","dB":"g:5000"},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"c1":"t:c1"},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"g:2000":{"goals":["one","two"],"id":"g:2000","kind":"subagent_group","origin":"live","rootIds":["s1","s2"],"seq":2000,"status":"failed","ts":1790000002,"version":8},"g:4000":{"delegationId":"dA","goals":["three"],"id":"g:4000","kind":"subagent_group","origin":"live","rootIds":["s3"],"seq":4000,"status":"running","ts":1790000009,"version":2},"g:5000":{"delegationId":"dB","goals":["four","five"],"id":"g:5000","kind":"subagent_group","origin":"live","rootIds":["s4","s5"],"seq":5000,"status":"running","ts":1790000010,"version":4},"t:c1":{"id":"t:c1","kind":"tool","name":"terminal","origin":"live","resultKnown":false,"seq":3000,"status":"running","toolId":"c1","ts":1790000003,"version":0}},"lastSeq":0,"order":["f:1000","g:2000","t:c1","g:4000","g:5000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{"s1":{"filesRead":[],"filesWritten":[],"goal":"one","id":"s1","parentId":null,"startedAt":1790000002000,"status":"completed","stream":[{"at":1790000006000,"kind":"summary","text":"done 1"}],"summary":"done 1","taskCount":1,"taskIndex":0,"updatedAt":1790000006000},"s2":{"filesRead":[],"filesWritten":[],"goal":"two","id":"s2","parentId":null,"startedAt":1790000004000,"status":"failed","stream":[{"at":1790000007000,"isError":true,"kind":"summary","text":"broke"}],"summary":"broke","taskCount":1,"taskIndex":0,"updatedAt":1790000007000},"s3":{"delegationId":"dA","filesRead":[],"filesWritten":[],"goal":"three","id":"s3","parentId":null,"startedAt":1790000009000,"status":"running","stream":[],"taskCount":1,"taskIndex":0,"updatedAt":1790000009000},"s4":{"delegationId":"dB","filesRead":[],"filesWritten":[],"goal":"four","id":"s4","parentId":null,"startedAt":1790000010000,"status":"running","stream":[],"taskCount":1,"taskIndex":0,"updatedAt":1790000010000},"s5":{"filesRead":[],"filesWritten":[],"goal":"five","id":"s5","parentId":null,"startedAt":1790000011000,"status":"running","stream":[],"taskCount":1,"taskIndex":0,"updatedAt":1790000011000}},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":6000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "subagent-snapshot-edges",
    "covers": "applySubagentSnapshot: an empty roster, seconds and milliseconds start times, a non-boolean accepting_steer kept as it came, last_tool and child_session_id, a finished child skipped",
    "steps": [
      ["applySubagentSnapshot",[],1790000001000],
      ["applySubagentSnapshot",[{"subagent_id":"r1","goal":"roster one","started_at":1789999000,"accepting_steer":"yes","last_tool":"web_search","child_session_id":"child-1","depth":null,"tool_count":2},{"subagent_id":"r2","goal":null,"status":"queued","started_at":1789999000123,"accepting_steer":false,"depth":1,"delegation_id":"dZ"},{"subagent_id":"r3","started_at":-5,"parent_id":"r1"}],1790000002000],
      ["applyEvent",{"type":"subagent.complete","payload":{"subagent_id":"r1","status":"completed"}},1790000003000],
      ["applySubagentSnapshot",[{"subagent_id":"r1","status":"running"},{"subagent_id":"r2","status":"running","accepting_steer":true}],1790000004000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{"dZ":"g:1000"},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"draft":"","hydration":"cold","items":{"g:1000":{"delegationId":"dZ","goals":["roster one","Subagent"],"id":"g:1000","kind":"subagent_group","origin":"live","rootIds":["r1","r2","r3"],"seq":1000,"status":"running","ts":1790000002,"version":10}},"lastSeq":0,"order":["g:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{"r1":{"acceptingSteer":"yes","childSessionId":"child-1","filesRead":[],"filesWritten":[],"goal":"roster one","id":"r1","parentId":null,"startedAt":1789999000000,"status":"completed","stream":[{"at":1790000002000,"kind":"tool","text":"Web Search"}],"taskCount":1,"taskIndex":0,"toolCount":2,"updatedAt":1790000003000},"r2":{"acceptingSteer":true,"delegationId":"dZ","depth":1,"filesRead":[],"filesWritten":[],"goal":"Subagent","id":"r2","parentId":null,"startedAt":1789999000123,"status":"running","stream":[],"taskCount":1,"taskIndex":0,"updatedAt":1790000002000},"r3":{"filesRead":[],"filesWritten":[],"goal":"Subagent","id":"r3","parentId":"r1","startedAt":1790000002000,"status":"running","stream":[],"taskCount":1,"taskIndex":0,"updatedAt":1790000002000}},"turn":{"active":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "request-edges",
    "covers": "approval with no ids at all; clarify batch with given answers (some non-string) and a non-string choice; answerRequest filling the first open question then by record; unknown method; answering an unknown id; request.cancel by approval id; a new question under an answered id",
    "steps": [
      ["applyServerRequest",{"id":"","method":"approval","params":{"command":"ls"}},1790000001000],
      ["applyServerRequest",{"id":"c1","method":"clarify","params":{"questions":[{"qid":"a","question":"A?"},{"question":"B?","choices":["x",1,"y"],"multi_select":true},"junk"],"answers":{"a":"yes","b":2}}},1790000002000],
      ["answerRequest","c1","no"],
      ["answerRequest","c1",{"q3":"later","a":"changed"}],
      ["applyServerRequest",{"id":"x1","method":"telepathy","params":{}},1790000003000],
      ["answerRequest","missing","x"],
      ["applyServerRequest",{"id":"srq-1","method":"approval","params":{"request_id":"q-7","command":"git push","description":"push","tool_name":"terminal","choices":[],"allow_permanent":false,"smart_denied":true}},1790000004000],
      ["applyServerRequest",{"id":"pending:q-7","method":"approval","params":{"request_id":"q-7","command":"git push"}},1790000005000],
      ["answerRequest","srq-1",{"first":"session","second":"deny"}],
      ["applyServerRequest",{"id":"srq-1","method":"approval","params":{"request_id":"q-7","command":"git push --force"}},1790000006000],
      ["applyEvent",{"type":"request.cancel","payload":{"id":"q-7","reason":"expired"}},1790000007000],
      ["applyServerRequest",{"id":"c2","method":"clarify","params":{"request_id":"qq","question":"Which?","choices":["a",null],"answers":{"qq":"a"}}},1790000008000]
    ],
    "expected": {"botName":"bot","byApprovalId":{"q-7":"req:srq-1#2"},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{"":"req:","c1":"req:c1","c2":"req:c2","srq-1":"req:srq-1#2"},"byRowId":{},"byToolId":{},"draft":"","hydration":"cold","items":{"req:":{"allowPermanent":true,"allowSession":true,"approvalId":"","choices":["once","session","always","deny"],"command":"ls","id":"req:","kind":"approval","origin":"live","requestId":"","seq":1000,"state":"open","ts":1790000001,"version":0},"req:c1":{"answers":{"a":"changed","q2":"no","q3":"later"},"batch":true,"id":"req:c1","kind":"clarify","locked":["a","q2","q3"],"origin":"live","questions":[{"multiSelect":false,"qid":"a","question":"A?"},{"choices":["x","y"],"multiSelect":true,"qid":"q2","question":"B?"},{"multiSelect":false,"qid":"q3","question":""}],"requestId":"c1","seq":2000,"state":"answered","ts":1790000002,"version":2},"req:c2":{"answers":{"qq":"a"},"id":"req:c2","kind":"clarify","locked":["qq"],"origin":"live","questions":[{"choices":["a"],"multiSelect":false,"qid":"qq","question":"Which?"}],"requestId":"c2","seq":5000,"state":"answered","ts":1790000008,"version":0},"req:srq-1":{"allowPermanent":false,"allowSession":true,"answer":"session","approvalId":"q-7","choices":["once","session","always","deny"],"command":"git push","description":"push","id":"req:srq-1","kind":"approval","origin":"live","requestId":"srq-1","seq":3000,"smartDenied":true,"state":"answered","toolName":"terminal","ts":1790000004,"version":1},"req:srq-1#2":{"allowPermanent":true,"allowSession":true,"approvalId":"q-7","cancelReason":"expired","choices":["once","session","always","deny"],"command":"git push --force","id":"req:srq-1#2","kind":"approval","origin":"live","requestId":"srq-1","seq":4000,"state":"cancelled","ts":1790000006,"version":1}},"lastSeq":0,"order":["req:","req:c1","req:srq-1","req:srq-1#2","req:c2"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":6000},"unreadCount":0}
  },
  {
    "name": "answer-request-at-non-request",
    "covers": "answerRequest when the request index points at an item that is not a question returns the state unchanged",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["patchState",{"byRequestId":{"weird":"f:1000"}}],
      ["answerRequest","weird","yes"]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{"weird":"f:1000"},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0}},"lastSeq":0,"order":["f:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":2000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "resume-interrupted-live-bubble",
    "covers": "applyResumeSnapshot settling `interrupted` and a longer text onto a live, unsealed bubble",
    "steps": [
      ["beginLocalTurn","hello",null,1790000001000],
      ["confirmSubmit",{"status":"streaming"},1790000001000],
      ["applyEvent",{"type":"message.start","payload":{},"seq":1},1790000002000],
      ["applyEvent",{"type":"message.delta","payload":{"text":"partial"},"seq":2},1790000003000],
      ["applyResumeSnapshot",{"inflight":{"user":"hello","assistant":"partial and more","status":"interrupted","streaming":false},"running":false},1790000004000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"live","items":{"a:2000":{"id":"a:2000","interim":false,"kind":"assistant","origin":"live","seq":2000,"status":"interrupted","streaming":false,"text":"partial and more","ts":1790000003,"version":2},"o:1000":{"id":"o:1000","kind":"user","origin":"optimistic","pending":false,"seq":1000,"text":"hello","ts":1790000001,"version":1}},"lastSeq":2,"order":["o:1000","a:2000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"assistantId":"a:2000","interrupted":false,"local":true,"nextSeq":3000,"startedAt":1790000002000},"unreadCount":0}
  },
  {
    "name": "prompt-scaffolding",
    "covers": "stripUserText: the Discord triggering note, the attached-context block hoisting a missing ref, directive lines collapsing; mergeAttachmentRefs keeping file and image; dropSteer matching the stripped text",
    "steps": [
      ["beginLocalTurn","[Triggering message id: `123` — use as `message_id` for reply/react/pin via the discord tools.]\nplease read   @file:a.txt   now\n@image:\"/tmp/p q.png\"\n\n\nthanks\n\n--- Attached Context ---\n@file:a.txt\n@file:\"b c.txt\"\n@url:http://x.test\n--- Context Warnings ---\nbig",["@image:/elsewhere/p q.png","@image:other.png"],1790000001000],
      ["beginSteer","also @file:`z.md` please",null,1790000002000],
      ["beginSteer","second steer",["@file:k.txt"],1790000003000],
      ["dropSteer","also @file:`z.md` please"],
      ["dropSteer","not there"]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"draft":"","hydration":"cold","items":{"o:1000":{"attachments":["@file:\"b c.txt\"","@file:a.txt","@image:\"/tmp/p q.png\"","@image:other.png"],"id":"o:1000","kind":"user","origin":"optimistic","pending":true,"seq":1000,"text":"@url:http://x.test\n\nplease read now\n\nthanks","ts":1790000001,"version":0},"o:3000":{"attachments":["@file:k.txt"],"displayKind":"steer","id":"o:3000","kind":"user","origin":"optimistic","seq":3000,"text":"second steer","ts":1790000003,"version":0}},"lastSeq":0,"order":["o:1000","o:3000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"interrupted":false,"local":true,"nextSeq":4000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "resume-scaffolded-prompt",
    "covers": "readInflightPrompt projects the stripped prompt with its refs; an attachment-only prompt resumes with its references",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{},"seq":1},1790000001000],
      ["applyResumeSnapshot",{"inflight":{"user":"@file:\"only.pdf\"","assistant":"","streaming":true},"running":true,"turn_started_at":1790000000},1790000002000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"live","items":{"f:1000":{"attachments":["@file:\"only.pdf\""],"id":"f:1000","kind":"user","origin":"inflight","seq":1000,"text":"","ts":1790000002,"version":1}},"lastSeq":1,"order":["f:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"interrupted":false,"local":false,"nextSeq":2000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "process-completion-edges",
    "covers": "applyProcessCompletion with one block for a known dispatch and one for an unknown process; text with no blocks",
    "steps": [
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"m1","name":"message_agent","args":{"target":"writer","message":"draft?"}}},1790000001000],
      ["applyEvent",{"type":"tool.complete","payload":{"tool_id":"m1","result":{"status":"queued","process_id":"proc-1","delivery_id":"dl-1","to":"writer"}}},1790000002000],
      ["applyProcessCompletion","nothing here",1790000003000],
      ["applyProcessCompletion","[IMPORTANT: Background process proc-1 completed (exit code 0).\nCommand: python3 tools/bot_mode_dm.py --run-delivery query-file /tmp/x.json hermes -p writer chat\nOutput:\nMessage from 🤖 Writer (@writer): ready]\n\n[IMPORTANT: Background process proc-x completed (exit code 0).\nCommand: python3 tools/bot_mode_dm.py --run-delivery query-file /tmp/x.json hermes -p writer chat\nOutput:\nignored]",1790000004000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{"proc-1":"t:m1"},"byRequestId":{},"byRowId":{},"byToolId":{"m1":"t:m1"},"draft":"","hydration":"cold","items":{"t:m1":{"dispatch":{"deliveryId":"dl-1","processId":"proc-1","status":"queued","to":"writer"},"id":"t:m1","kind":"bot_dm_out","message":"draft?","origin":"live","reply":{"text":"ready","ts":1790000004},"seq":1000,"target":"writer","targetHandle":"writer","toolId":"m1","ts":1790000001,"version":2}},"lastSeq":0,"order":["t:m1"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "confirm-without-optimistic",
    "covers": "confirmSubmit with no optimistic prompt returns the state unchanged; markInterrupted with no bubble",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["confirmSubmit",{"status":"queued"},1790000002000],
      ["markInterrupted",1790000003000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0}},"lastSeq":0,"order":["f:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":true,"local":false,"nextSeq":2000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "reactions-and-session",
    "covers": "message.reaction keeps only entries with a string emoji; session.title, session.usage, session.info, session.reclaimed, btw/background notices, a command notice, a replayed seq",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{},"seq":5},1790000001000],
      ["applyEvent",{"type":"message.delta","payload":{"text":"hi"},"seq":4},1790000001000],
      ["patchState",{"byRowId":{"42":"f:1000"}}],
      ["applyEvent",{"type":"message.reaction","payload":{"row_id":42,"reactions":[{"emoji":"👍","count":2},{"emoji":3},"x"]}},1790000002000],
      ["applyEvent",{"type":"session.title","payload":{"title":"Renamed"}},1790000003000],
      ["applyEvent",{"type":"session.usage","payload":{"usage":{"input":1}}},1790000003000],
      ["applyEvent",{"type":"session.info","payload":{"stored_session_id":"stored-2","running":false,"turn_started_at":1}},1790000004000],
      ["applyEvent",{"type":"btw.complete","payload":{"text":" answer ","question":" why? "}},1790000005000],
      ["applyEvent",{"type":"background.complete","payload":{"text":"bg done"}},1790000006000],
      ["applyEvent",{"type":"notice","payload":{"message":"/status","detail":"line 1\nline 2","noticeKind":"command"}},1790000007000],
      ["applyEvent",{"type":"notice","payload":{"message":"hey","noticeKind":"system_note"}},1790000008000],
      ["applyEvent",{"type":"session.reclaimed","payload":{"reason":"idle"}},1790000009000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"42":"f:1000"},"byToolId":{},"compacting":false,"draft":"","hydration":"stale","info":{"running":false,"stored_session_id":"stored-2","turn_started_at":1},"items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","reactions":[{"count":2,"emoji":"👍"}],"seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":1},"n:2000":{"body":"answer","id":"n:2000","kind":"notice","noticeKind":"notice","origin":"live","seq":2000,"title":"Side question: why?","ts":1790000005,"version":0},"n:3000":{"body":"bg done","id":"n:3000","kind":"notice","noticeKind":"notice","origin":"live","seq":3000,"title":"Background task finished","ts":1790000006,"version":0},"n:4000":{"body":"line 1\nline 2","id":"n:4000","kind":"notice","noticeKind":"command","origin":"live","seq":4000,"title":"/status","ts":1790000007,"version":0},"n:5000":{"id":"n:5000","kind":"notice","noticeKind":"notice","origin":"live","seq":5000,"title":"hey","ts":1790000008,"version":0},"n:6000":{"body":"idle","id":"n:6000","kind":"notice","noticeKind":"reclaimed","origin":"live","seq":6000,"title":"Session reclaimed by the gateway","ts":1790000009,"version":0}},"lastSeq":5,"order":["f:1000","n:2000","n:3000","n:4000","n:5000","n:6000"],"resolvedSessionId":"resolved","storedSessionId":"stored-2","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":7000,"startedAt":1790000001000},"unreadCount":0,"usage":{"input":1}}
  },
  {
    "name": "tool-start-after-reasoning-only",
    "covers": "a bubble holding only reasoning when a tool starts is sealed, not dropped; the reply after the tool opens a new bubble",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"reasoning.delta","payload":{"text":"weighing the options"}},1790000002000],
      ["applyEvent",{"type":"tool.start","payload":{"tool_id":"c1","name":"terminal","args":{"command":"ls"}}},1790000003000],
      ["applyEvent",{"type":"tool.complete","payload":{"tool_id":"c1","result_text":"a.txt"}},1790000004000],
      ["applyEvent",{"type":"message.delta","payload":{"text":"Found it."}},1790000005000],
      ["applyEvent",{"type":"message.complete","payload":{"text":"Found it."}},1790000006000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"c1":"t:c1"},"compacting":false,"draft":"","hydration":"cold","items":{"a:2000":{"id":"a:2000","interim":true,"kind":"assistant","origin":"live","reasoning":"weighing the options","seq":2000,"streaming":false,"text":"","ts":1790000002,"version":2},"a:4000":{"durationS":5,"id":"a:4000","interim":false,"kind":"assistant","origin":"live","seq":4000,"status":"complete","streaming":false,"text":"Found it.","ts":1790000005,"version":2},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"t:c1":{"args":{"command":"ls"},"id":"t:c1","isError":false,"kind":"tool","name":"terminal","origin":"live","resultKnown":true,"resultText":"a.txt","seq":3000,"status":"complete","toolId":"c1","ts":1790000003,"version":1}},"lastSeq":0,"order":["f:1000","a:2000","t:c1","a:4000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":5000},"unreadCount":0}
  },
  {
    "name": "resume-new-inflight-interrupted",
    "covers": "applyResumeSnapshot with no live bubble adds an inflight reply marked `interrupted`",
    "steps": [
      ["applyResumeSnapshot",{"inflight":{"user":"go on","assistant":"half of it","status":"interrupted","streaming":false},"running":false},1790000001000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"draft":"","hydration":"live","items":{"i:1000":{"id":"i:1000","kind":"user","origin":"inflight","seq":1000,"text":"go on","ts":1790000001,"version":0},"i:2000":{"id":"i:2000","interim":false,"kind":"assistant","origin":"inflight","seq":2000,"status":"interrupted","streaming":false,"text":"half of it","ts":1790000001,"version":0}},"lastSeq":0,"order":["i:1000","i:2000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":3000},"unreadCount":0}
  },
  {
    "name": "resume-new-inflight-recoverable-failure",
    "covers": "applyResumeSnapshot with no live bubble adds a streaming inflight reply carrying a recoverable failure",
    "steps": [
      ["applyResumeSnapshot",{"inflight":{"user":"try again","assistant":"partial","error":"  provider down  ","recoverable":true,"streaming":true},"running":true,"turn_started_at":1790000000},1790000001000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"draft":"","hydration":"live","items":{"i:1000":{"id":"i:1000","kind":"user","origin":"inflight","seq":1000,"text":"try again","ts":1790000001,"version":0},"i:2000":{"error":{"message":"provider down","partial":true,"recoverable":true},"id":"i:2000","interim":false,"kind":"assistant","origin":"inflight","seq":2000,"status":"error","streaming":true,"text":"partial","ts":1790000001,"version":0}},"lastSeq":0,"order":["i:1000","i:2000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"assistantId":"i:2000","local":false,"nextSeq":3000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "clarify-redelivered-open",
    "covers": "an open clarify re-delivered under its own request id is not added twice, even with different words",
    "steps": [
      ["applyServerRequest",{"id":"srq-5","method":"clarify","params":{"question":"Which branch?","choices":["main","next"]}},1790000001000],
      ["applyServerRequest",{"id":"srq-5","method":"clarify","params":{"question":"Which branch, again?","choices":["main"]}},1790000002000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{"srq-5":"req:srq-5"},"byRowId":{},"byToolId":{},"draft":"","hydration":"cold","items":{"req:srq-5":{"answers":{},"id":"req:srq-5","kind":"clarify","locked":[],"origin":"live","questions":[{"choices":["main","next"],"multiSelect":false,"qid":"q1","question":"Which branch?"}],"requestId":"srq-5","seq":1000,"state":"open","ts":1790000001,"version":0}},"lastSeq":0,"order":["req:srq-5"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "complete-with-only-an-error",
    "covers": "message.complete with an error and no text, and no bubble at all, creates a failed reply",
    "steps": [
      ["applyEvent",{"type":"message.complete","payload":{"status":"error","error":"provider down","recoverable":true}},1790000001000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{},"compacting":false,"draft":"","hydration":"cold","items":{"a:1000":{"error":{"message":"provider down","partial":false,"recoverable":true},"id":"a:1000","interim":false,"kind":"assistant","origin":"live","seq":1000,"status":"error","streaming":false,"text":"","ts":1790000001,"version":1}},"lastSeq":0,"order":["a:1000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"interrupted":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "tool-events-without-ids",
    "covers": "tool.start without a tool_id gets a `gen-` id; tool.complete without one and no running tool lands as a `late-` card",
    "steps": [
      ["applyEvent",{"type":"message.start","payload":{}},1790000001000],
      ["applyEvent",{"type":"tool.start","payload":{"name":"terminal","args":{"command":"pwd"}}},1790000002000],
      ["applyEvent",{"type":"tool.complete","payload":{"name":"read_file","result_text":"ok"}},1790000003000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{},"byToolId":{"gen-2000":"t:gen-2000","late-3000":"t:late-3000"},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"unknownAuthor":true,"version":0},"t:gen-2000":{"args":{"command":"pwd"},"id":"t:gen-2000","kind":"tool","name":"terminal","origin":"live","resultKnown":false,"seq":2000,"status":"running","toolId":"gen-2000","ts":1790000002,"version":0},"t:late-3000":{"id":"t:late-3000","isError":false,"kind":"tool","name":"read_file","origin":"live","resultKnown":true,"resultText":"ok","seq":3000,"status":"complete","toolId":"late-3000","ts":1790000003,"version":1}},"lastSeq":0,"order":["f:1000","t:gen-2000","t:late-3000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":4000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "pending-approval-command-only",
    "covers": "a resume whose pending_approval carries only a command rebuilds the sheet under `pending:approval`",
    "steps": [
      ["applyResumeSnapshot",{"pending_approval":{"command":"rm -rf build"},"running":true},1790000001000]
    ],
    "expected": {"botName":"bot","byApprovalId":{"pending:approval":"req:pending:approval"},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{"pending:approval":"req:pending:approval"},"byRowId":{},"byToolId":{},"draft":"","hydration":"live","items":{"req:pending:approval":{"allowPermanent":true,"allowSession":true,"approvalId":"pending:approval","choices":["once","session","always","deny"],"command":"rm -rf build","id":"req:pending:approval","kind":"approval","origin":"live","requestId":"pending:approval","seq":1000,"state":"open","ts":1790000001,"version":0}},"lastSeq":0,"order":["req:pending:approval"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"local":false,"nextSeq":2000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "identity-card-learns-its-call",
    "covers": "a card drawn without a call identity learns it from tool.complete; a tool id whose card names another call is refused; tool.output_risk by call key; message.start without a turn id lets go of the named turn's thought",
    "steps": [
      ["applyEvent",{"type":"message.start","turn_id":"T1","payload":{}},1790000001000],
      ["applyEvent",{"type":"reasoning.delta","turn_id":"T1","payload":{"text":"thinking"}},1790000001500],
      ["applyEvent",{"type":"tool.start","turn_id":"T1","payload":{"tool_id":"c1","name":"terminal"}},1790000002000],
      ["applyEvent",{"type":"tool.complete","turn_id":"T1","payload":{"tool_id":"c1","name":"terminal","call_row_id":5,"call_index":0,"row_id":6,"result_text":"ok"}},1790000003000],
      ["applyEvent",{"type":"tool.complete","turn_id":"T1","payload":{"tool_id":"c1","name":"terminal","call_row_id":9,"call_index":0,"result_text":"other"}},1790000003500],
      ["applyEvent",{"type":"tool.output_risk","turn_id":"T1","payload":{"tool_id":"c1","call_row_id":9,"call_index":0,"risk":"high","findings":["token"],"redacted":true}},1790000003600],
      ["applyEvent",{"type":"message.start","payload":{}},1790000004000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{"5/0":"t:c1","9/0":"t:c1#2"},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"6":"t:c1"},"byToolId":{"c1":"t:c1#2"},"compacting":false,"draft":"","hydration":"cold","items":{"a:2000":{"id":"a:2000","interim":true,"kind":"assistant","origin":"live","reasoning":"thinking","seq":2000,"streaming":false,"text":"","ts":1790000001.5,"version":2},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"turnId":"T1","unknownAuthor":true,"version":0},"f:5000":{"id":"f:5000","kind":"user","origin":"foreign","seq":5000,"text":"","ts":1790000004,"unknownAuthor":true,"version":0},"t:c1":{"callKey":"5/0","id":"t:c1","isError":false,"kind":"tool","name":"terminal","origin":"live","resultKnown":true,"resultText":"ok","rowId":6,"seq":3000,"status":"complete","toolId":"c1","ts":1790000002,"version":3},"t:c1#2":{"callKey":"9/0","id":"t:c1#2","isError":false,"kind":"tool","name":"terminal","origin":"live","outputRisk":{"findings":["token"],"redacted":true,"risk":"high"},"resultKnown":true,"resultText":"other","seq":4000,"status":"complete","toolId":"c1","ts":1790000003.5,"version":2}},"lastSeq":0,"order":["f:1000","a:2000","t:c1","t:c1#2","f:5000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":6000,"startedAt":1790000004000},"unreadCount":0}
  },
  {
    "name": "identity-settle-carries-thought-and-usage",
    "covers": "settleOntoRow hands the row the live bubble's thought, its verbosity and its usage when the row has none",
    "steps": [
      ["patchState",{"items":{"r:10":{"id":"r:10","kind":"assistant","origin":"history","rowId":10,"seq":0,"streaming":false,"interim":false,"text":"the note","version":0},"a:1000":{"id":"a:1000","kind":"assistant","origin":"live","seq":1000,"streaming":true,"interim":false,"text":"the note","reasoning":"thinking","reasoningVerbose":true,"usage":{"input":1,"output":2},"version":3}},"order":["r:10","a:1000"],"byRowId":{"10":"r:10"},"turn":{"active":true,"local":true,"nextSeq":2000,"id":"T2","assistantId":"a:1000","reasoningId":"a:1000"}}],
      ["applyEvent",{"type":"message.interim","turn_id":"T2","payload":{"text":"the note","row_id":10,"already_streamed":true}},1790000002000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"10":"r:10"},"byToolId":{},"draft":"","hydration":"cold","items":{"r:10":{"id":"r:10","interim":false,"kind":"assistant","origin":"history","reasoning":"thinking","reasoningVerbose":true,"rowId":10,"seq":0,"streaming":false,"text":"the note","usage":{"input":1,"output":2},"version":1}},"lastSeq":0,"order":["r:10"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"id":"T2","local":true,"nextSeq":2000,"reasoningId":"r:10"},"unreadCount":0}
  },
  {
    "name": "identity-call-row-stamps-a-thought-only-bubble",
    "covers": "a tool call whose row is not on screen stamps that row onto a live bubble holding only a thought, which the seal then keeps",
    "steps": [
      ["applyEvent",{"type":"message.start","turn_id":"T3","payload":{}},1790000001000],
      ["applyEvent",{"type":"reasoning.delta","turn_id":"T3","payload":{"text":"pondering"}},1790000001500],
      ["applyEvent",{"type":"tool.start","turn_id":"T3","payload":{"tool_id":"t9","name":"read_file","call_row_id":20,"call_index":0}},1790000002000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{"20/0":"t:t9"},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"20":"a:2000"},"byToolId":{"t9":"t:t9"},"compacting":false,"draft":"","hydration":"cold","items":{"a:2000":{"id":"a:2000","interim":true,"kind":"assistant","origin":"live","reasoning":"pondering","rowId":20,"seq":2000,"streaming":false,"text":"","ts":1790000001.5,"version":3},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"turnId":"T3","unknownAuthor":true,"version":0},"t:t9":{"callKey":"20/0","id":"t:t9","kind":"tool","name":"read_file","origin":"live","resultKnown":false,"seq":3000,"status":"running","toolId":"t9","ts":1790000002,"version":0}},"lastSeq":0,"order":["f:1000","a:2000","t:t9"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"foreignReconcilePending":true,"id":"T3","interrupted":false,"local":false,"nextSeq":4000,"reasoningId":"a:2000","startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "identity-rehydrate-by-turn-and-call",
    "covers": "reconcile pairs by turn id and call key onto persisted items, and refuses a turn match whose row id says it is another row",
    "steps": [
      ["reconcile",[{"id":"r:1","kind":"user","origin":"history","rowId":1,"seq":0,"text":"hi","turnId":"T4","version":0},{"id":"r:2","kind":"tool","origin":"history","rowId":2,"seq":1000,"toolId":"x","callKey":"1/0","name":"terminal","status":"complete","resultKnown":false,"version":0}]],
      ["reconcile",[{"id":"r:7","kind":"user","origin":"history","rowId":7,"seq":0,"text":"other","turnId":"T4","version":0},{"id":"user:1","kind":"user","origin":"history","seq":1000,"text":"hi again","turnId":"T4","version":0},{"id":"tool:2","kind":"tool","origin":"history","seq":2000,"toolId":"y","callKey":"1/0","name":"terminal","status":"complete","resultKnown":false,"version":0}]]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{"1/0":"r:2"},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"7":"r:7"},"byToolId":{"y":"r:2"},"draft":"","hydration":"live","items":{"r:1":{"id":"r:1","kind":"user","origin":"history","pending":false,"seq":1000,"text":"hi again","turnId":"T4","version":1},"r:2":{"callKey":"1/0","id":"r:2","kind":"tool","name":"terminal","origin":"history","resultKnown":false,"seq":2000,"status":"complete","toolId":"y","version":1},"r:7":{"id":"r:7","kind":"user","origin":"history","rowId":7,"seq":0,"text":"other","turnId":"T4","version":0}},"lastSeq":0,"order":["r:7","r:1","r:2"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":3000},"unreadCount":0}
  },
  {
    "name": "identity-tail-by-turn-and-call",
    "covers": "reconcileTail fills a placeholder by its turn id once, appends a second row of that turn, and pairs a card by its call key over a different tool id",
    "steps": [
      ["applyEvent",{"type":"message.start","turn_id":"T5","payload":{}},1790000001000],
      ["applyEvent",{"type":"tool.start","turn_id":"T5","payload":{"tool_id":"k1","name":"terminal","call_row_id":29,"call_index":0}},1790000002000],
      ["reconcileTail",[{"id":"r:31","kind":"user","origin":"history","rowId":31,"seq":0,"text":"do it","turnId":"T5","version":0},{"id":"r:32","kind":"user","origin":"history","rowId":32,"seq":1000,"text":"dup","turnId":"T5","version":0},{"id":"r:33","kind":"tool","origin":"history","rowId":33,"seq":2000,"toolId":"k1-other","callKey":"29/0","name":"terminal","status":"complete","resultKnown":false,"version":0}]]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{"29/0":"t:k1"},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"31":"f:1000","32":"r:32","33":"t:k1"},"byToolId":{"k1-other":"t:k1"},"compacting":false,"draft":"","hydration":"cold","items":{"f:1000":{"id":"f:1000","kind":"user","origin":"history","rowId":31,"seq":0,"text":"do it","turnId":"T5","version":1},"r:32":{"id":"r:32","kind":"user","origin":"history","rowId":32,"seq":1000,"text":"dup","turnId":"T5","version":0},"t:k1":{"callKey":"29/0","id":"t:k1","kind":"tool","name":"terminal","origin":"history","resultKnown":false,"rowId":33,"seq":2000,"status":"complete","toolId":"k1-other","version":1}},"lastSeq":0,"order":["f:1000","r:32","t:k1"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":true,"id":"T5","interrupted":false,"local":false,"nextSeq":3000,"startedAt":1790000001000},"unreadCount":0}
  },
  {
    "name": "identity-older-page-overlaps-by-call",
    "covers": "prependHistory drops an older tool row whose call key is already on screen, whatever its row id",
    "steps": [
      ["reconcile",[{"id":"r:50","kind":"tool","origin":"history","rowId":50,"seq":0,"toolId":"p","callKey":"49/0","name":"terminal","status":"complete","resultKnown":false,"version":0}]],
      ["prependHistory",[{"id":"r:40","kind":"user","origin":"history","rowId":40,"seq":0,"text":"older","version":0},{"id":"r:41","kind":"tool","origin":"history","rowId":41,"seq":1000,"toolId":"p","callKey":"49/0","name":"terminal","status":"complete","resultKnown":false,"version":0}]]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{"49/0":"r:50"},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"40":"r:40","50":"r:50"},"byToolId":{"p":"r:50"},"draft":"","hydration":"live","items":{"r:40":{"id":"r:40","kind":"user","origin":"history","rowId":40,"seq":0,"text":"older","version":0},"r:50":{"callKey":"49/0","id":"r:50","kind":"tool","name":"terminal","origin":"history","resultKnown":false,"rowId":50,"seq":1000,"status":"complete","toolId":"p","version":0}},"lastSeq":0,"order":["r:40","r:50"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"local":false,"nextSeq":2000},"unreadCount":0}
  },
  {
    "name": "identity-fractional-row-id-reads-as-absent",
    "covers": "a row_id that is not a positive integer (2.5, 7.5) names no row: the interim stamps none and the completion falls back to the receipt's final_assistant_row_id",
    "steps": [
      ["applyEvent",{"type":"message.start","turn_id":"T9","payload":{}},1790000001000],
      ["applyEvent",{"type":"message.delta","turn_id":"T9","payload":{"text":"note"}},1790000002000],
      ["applyEvent",{"type":"message.interim","turn_id":"T9","payload":{"text":"note","already_streamed":true,"row_id":2.5}},1790000003000],
      ["applyEvent",{"type":"message.delta","turn_id":"T9","payload":{"text":"final"}},1790000004000],
      ["applyEvent",{"type":"message.complete","turn_id":"T9","payload":{"text":"final","status":"complete","row_id":7.5,"persisted_turn":{"final_assistant_row_id":8}}},1790000005000]
    ],
    "expected": {"botName":"bot","byApprovalId":{},"byCallKey":{},"byDelegationId":{},"byProcessId":{},"byRequestId":{},"byRowId":{"8":"a:3000"},"byToolId":{},"compacting":false,"draft":"","hydration":"cold","items":{"a:2000":{"id":"a:2000","interim":true,"kind":"assistant","origin":"live","seq":2000,"streaming":false,"text":"note","ts":1790000002,"version":2},"a:3000":{"durationS":4,"id":"a:3000","interim":false,"kind":"assistant","origin":"live","rowId":8,"seq":3000,"status":"complete","streaming":false,"text":"final","ts":1790000004,"version":2},"f:1000":{"id":"f:1000","kind":"user","origin":"foreign","seq":1000,"text":"","ts":1790000001,"turnId":"T9","unknownAuthor":true,"version":0}},"lastSeq":0,"order":["f:1000","a:2000","a:3000"],"resolvedSessionId":"resolved","storedSessionId":"stored","subagents":{},"turn":{"active":false,"foreignReconcilePending":true,"interrupted":false,"local":false,"nextSeq":4000},"unreadCount":0}
  }
]
"""#
