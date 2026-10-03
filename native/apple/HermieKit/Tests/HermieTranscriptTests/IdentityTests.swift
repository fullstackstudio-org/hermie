import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The row, call and turn identities the gateway attaches (`identity.ts`): how they
/// are read, where the model keeps them, which indices carry them, and what the cache
/// does with a turn it cut off. The golden corpus pins the same behaviour on the
/// TypeScript side's own inputs; these name the cases.
@Suite struct IdentityTests {
  private static func row(_ json: JSONValue) -> TranscriptRow {
    TranscriptRow(json: json.objectValue ?? [:])
  }

  private static func rows(_ json: [JSONValue]) -> [TranscriptRow] {
    json.map(row)
  }

  private static let ids = SessionIDs(storedSessionID: "stored", resolvedSessionID: "resolved")

  // MARK: The readers

  @Test func aCallKeyNeedsBothHalvesWellFormed() {
    #expect(callKeyOf(["call_row_id": 11, "call_index": 0]) == "11/0")
    #expect(callKeyOf(["call_row_id": 3, "call_index": 12]) == "3/12")
    #expect(callKeyOf(["call_row_id": 11]) == nil)
    #expect(callKeyOf(["call_index": 0]) == nil)
    #expect(callKeyOf(["call_row_id": "11", "call_index": 0]) == nil)
    #expect(callKeyOf(["call_row_id": 11, "call_index": -1]) == nil)
    #expect(callKeyOf(["call_row_id": 11, "call_index": 0.5]) == nil)
    #expect(callKeyOf(["call_row_id": 0, "call_index": 0]) == nil)
    #expect(callKeyOf(["call_row_id": 11, "call_index": nil]) == nil)
    #expect(callKeyOf(nil) == nil)
  }

  @Test func aRowIDIsAPositiveWholeNumber() {
    #expect(rowIDOf(["row_id": 7]) == 7)
    #expect(rowIDOf(["row_id": 0]) == nil)
    #expect(rowIDOf(["row_id": -3]) == nil)
    #expect(rowIDOf(["row_id": 2.5]) == nil)
    #expect(rowIDOf(["row_id": "7"]) == nil)
    #expect(rowIDOf([:]) == nil)
    #expect(rowIDOf(nil) == nil)
  }

  @Test func theTurnIDComesOutOfAnObjectOrItsJSONText() {
    #expect(turnIDOfMetadata(["turn_id": "abc"]) == "abc")
    #expect(turnIDOfMetadata(.string(#"{"turn_id":"def"}"#)) == "def")
    #expect(turnIDOfMetadata(.string(#""{\"turn_id\":\"ghi\"}""#)) == "ghi")
    #expect(turnIDOfMetadata(["turn_id": ""]) == nil)
    #expect(turnIDOfMetadata(["turn_id": 7]) == nil)
    #expect(turnIDOfMetadata(.string("not json")) == nil)
    #expect(turnIDOfMetadata(["author": ["id": "a"]]) == nil)
    #expect(turnIDOfMetadata(nil) == nil)
  }

  // MARK: rowsToItems

  @Test func anRPCToolRowIsReadByItsToolCallIDRowIDAndCallIdentity() throws {
    let items = rowsToItems(
      Self.rows([
        ["role": "tool", "name": "read_file", "tool_call_id": "call_0", "row_id": 12, "call_row_id": 11, "call_index": 0]
      ]),
      .rpc
    )
    let tool = try #require(items.first?.asTool)

    #expect(tool.id == "t:call_0")
    #expect(tool.toolID == "call_0")
    #expect(tool.rowID == 12)
    #expect(tool.callKey == "11/0")
  }

  @Test func aRESTToolRowIsReadByItsToolIDIDAndCallIdentity() throws {
    let items = rowsToItems(
      Self.rows([
        ["role": "tool", "name": "read_file", "tool_id": "call_0", "id": 12, "call_row_id": 11, "call_index": 1]
      ]),
      .rest
    )
    let tool = try #require(items.first?.asTool)

    #expect(tool.id == "t:call_0")
    #expect(tool.rowID == 12)
    #expect(tool.callKey == "11/1")
  }

  @Test func toolIDBeatsToolCallIDAndTheRowIndexIsTheLastResort() {
    let items = rowsToItems(
      Self.rows([
        ["role": "tool", "name": "a", "tool_id": "one", "tool_call_id": "two"],
        ["role": "tool", "name": "b"]
      ]),
      .rpc
    )

    #expect(items.compactMap(\.asTool).map(\.toolID) == ["one", "row-1"])
  }

  @Test func aToolRowWithNoIdentityIsAsItWas() throws {
    let items = rowsToItems(Self.rows([["role": "tool", "name": "read_file", "tool_id": "call_1"]]), .rpc)
    let tool = try #require(items.first?.asTool)

    #expect(tool.callKey == nil)
    #expect(tool.rowID == nil)
    #expect(tool.jsonValue.objectValue?["callKey"] == nil)
  }

  @Test func halfACallIdentityAndMalformedHalvesAreNoIdentity() {
    let items = rowsToItems(
      Self.rows([
        ["role": "tool", "name": "a", "tool_id": "x", "call_row_id": 11],
        ["role": "tool", "name": "b", "tool_id": "y", "call_index": 0],
        ["role": "tool", "name": "c", "tool_id": "z", "call_row_id": "11", "call_index": 0],
        ["role": "tool", "name": "d", "tool_id": "w", "call_row_id": 11, "call_index": -1]
      ]),
      .rpc
    )

    #expect(items.count == 4)
    #expect(items.allSatisfy { $0.callKey == nil })
  }

  @Test func theCallIdentityRidesAMessageAgentAndADelegateTaskRow() throws {
    let items = rowsToItems(
      Self.rows([
        [
          "role": "tool", "name": "message_agent", "tool_id": "dm", "args": ["target": "@bob", "message": "hi"],
          "call_row_id": 3, "call_index": 0
        ],
        ["role": "tool", "name": "delegate_task", "tool_id": "dg", "args": ["goal": "g"], "call_row_id": 3, "call_index": 1]
      ]),
      .rpc
    )

    #expect(items.count == 2)
    #expect(items[0].asBotDmOut?.callKey == "3/0")
    #expect(items[1].asSubagentGroup?.callKey == "3/1")
  }

  @Test func theTurnIDIsReadOffAUserRow() {
    let items = rowsToItems(
      Self.rows([
        ["role": "user", "text": "hello", "row_id": 1, "display_metadata": ["author": ["id": "a:1"], "turn_id": "abc123"]],
        ["role": "user", "text": "again", "row_id": 2, "display_metadata": .string(#"{"turn_id":"def456"}"#)],
        ["role": "user", "text": "plain", "row_id": 3],
        ["role": "user", "text": "empty", "row_id": 4, "display_metadata": ["turn_id": ""]],
        ["role": "user", "text": "wrong", "row_id": 5, "display_metadata": ["turn_id": 7]]
      ]),
      .rpc
    )

    #expect(items.compactMap(\.asUser).map(\.turnID) == ["abc123", "def456", nil, nil, nil])
  }

  // MARK: The model's JSON

  @Test func theNewFieldsAreWrittenUnderTheKeysTheTypeScriptWrites() throws {
    var tool = ToolItem(
      base: ItemBase(id: "t:a", seq: 0, origin: .live, version: 0),
      toolID: "a",
      name: "read_file",
      callKey: "3/0",
      status: .complete,
      resultKnown: false
    )
    #expect(tool.jsonValue["callKey"] == "3/0")
    tool.callKey = nil
    #expect(tool.jsonValue.objectValue?.keys.contains("callKey") == false)

    let dm = BotDmOutItem(
      base: ItemBase(id: "t:b", seq: 0, origin: .live, version: 0),
      toolID: "b",
      target: "@bob",
      targetHandle: "bob",
      message: "hi",
      callKey: "3/1",
      dispatch: BotDmDispatch(status: .unknown)
    )
    #expect(dm.jsonValue["callKey"] == "3/1")

    let group = SubagentGroupItem(
      base: ItemBase(id: "t:c", seq: 0, origin: .live, version: 0),
      toolID: "c",
      callKey: "3/2",
      goals: [],
      rootIDs: [],
      status: .dispatched
    )
    #expect(group.jsonValue["callKey"] == "3/2")

    let user = UserItem(base: ItemBase(id: "r:1", seq: 0, origin: .history, version: 0), text: "hi", turnID: "turn-1")
    #expect(user.jsonValue["turnId"] == "turn-1")
    #expect(user.jsonValue["turnID"] == nil)

    for value in [tool.jsonValue, dm.jsonValue, group.jsonValue, user.jsonValue] {
      let decoded = try TranscriptItem(decoding: value)
      #expect(decoded.jsonValue == value)
    }
  }

  @Test func theTurnIDAndTheCallIndexAreWrittenOnTheState() throws {
    var state = createChatState("bot", "stored", "resolved")
    #expect(state.jsonValue["byCallKey"] == [:])
    #expect(state.jsonValue["turn"]?["id"] == nil)

    state.byCallKey["3/0"] = "t:a"
    state.turn.id = "turn-1"

    let json = state.jsonValue
    #expect(json["byCallKey"] == ["3/0": "t:a"])
    #expect(json["turn"]?["id"] == "turn-1")

    let decoded = try ChatState(decoding: json)
    #expect(decoded == state)
    #expect(decoded.jsonValue == json)
  }

  // MARK: The indices

  private static let history: [TranscriptRow] = rows([
    ["role": "user", "text": "go", "row_id": 1, "display_metadata": ["turn_id": "turn-1"]],
    ["role": "assistant", "text": "on it", "row_id": 2],
    ["role": "tool", "name": "read_file", "tool_id": "call_0", "row_id": 3, "call_row_id": 2, "call_index": 0],
    ["role": "tool", "name": "message_agent", "tool_id": "dm", "args": ["target": "@bob", "message": "x"], "call_row_id": 2, "call_index": 1],
    ["role": "tool", "name": "delegate_task", "tool_id": "dg", "args": ["goal": "g"], "call_row_id": 2, "call_index": 2]
  ])

  @Test func reconcileIndexesTheCallKeysOfWhatItPlaces() throws {
    let fresh = createChatState("bot", "stored", "resolved")
    let state = reconcile(fresh, rowsToItems(Self.history, .rpc))

    #expect(state.byCallKey == ["2/0": "t:call_0", "2/1": "t:dm", "2/2": "t:dg"])
    #expect(state.byToolID["call_0"] == "t:call_0")
    #expect(state.items["r:1"]?.asUser?.turnID == "turn-1")
  }

  @Test func theCacheRebuildsTheCallIndexFromTheItemsAndNeverStoresIt() throws {
    let before = reconcile(createChatState("bot", "stored", "resolved"), rowsToItems(Self.history, .rpc))
    let snapshot = snapshotForCache(before, now: 1_790_000_000_000)
    let after = stateFromCache("bot", Self.ids, snapshot)

    #expect(after.byCallKey == before.byCallKey)
    #expect(try snapshot.jsonValue.canonicalString().contains("byCallKey") == false)
    #expect(after.items["r:1"]?.asUser?.turnID == "turn-1")
  }

  // MARK: The turn the cache cut off

  private func streamingState() -> ChatState {
    var state = createChatState("bot", "stored", "resolved")
    let user = TranscriptItem.user(
      UserItem(base: ItemBase(id: "r:1", seq: 0, rowID: 1, origin: .history, version: 0), text: "go", turnID: "turn-1")
    )
    let bubble = TranscriptItem.assistant(
      AssistantItem(
        base: ItemBase(id: "a:1000", seq: 1000, origin: .live, version: 3), text: "half a no", streaming: true, interim: false)
    )
    let thought = TranscriptItem.assistant(
      AssistantItem(
        base: ItemBase(id: "a:2000", seq: 2000, origin: .live, version: 1), text: "", reasoning: "hmm", streaming: false,
        interim: false)
    )
    for item in [user, bubble, thought] {
      state.items[item.id] = item
      state.order.append(item.id)
    }
    state.lastSeq = 7
    state.lastSeqSessionID = "runtime-1"
    state.turn.active = true
    state.turn.id = "turn-1"
    state.turn.assistantID = "a:1000"
    state.turn.reasoningID = "a:2000"
    return state
  }

  @Test func aSnapshotCarriesTheRunningTurnsPointersAndRestoringPutsThemBack() throws {
    let snapshot = snapshotForCache(streamingState(), now: 1)
    #expect(snapshot.turn == CachedTurn(id: "turn-1", assistantID: "a:1000", reasoningID: "a:2000"))
    #expect(snapshot.jsonValue["turn"] == ["id": "turn-1", "assistantId": "a:1000", "reasoningId": "a:2000"])

    let restored = stateFromCache("bot", Self.ids, snapshot)
    #expect(restored.turn.id == "turn-1")
    #expect(restored.turn.assistantID == "a:1000")
    #expect(restored.turn.reasoningID == "a:2000")
    // Nothing that would make the reopened chat claim a turn is running.
    #expect(restored.turn.active == false)
    #expect(restored.turn.startedAt == nil)

    let decoded = try CachedTranscript(decoding: snapshot.jsonValue)
    #expect(decoded == snapshot)
  }

  @Test func aSnapshotOfATurnTheGatewayDidNotNameWritesNoTurn() throws {
    var state = streamingState()
    state.turn.id = nil

    let snapshot = snapshotForCache(state, now: 1)
    #expect(snapshot.turn == nil)
    #expect(snapshot.jsonValue.objectValue?.keys.contains("turn") == false)
    #expect(stateFromCache("bot", Self.ids, snapshot).turn.id == nil)
  }

  @Test func aPointerNamingNothingCachedIsLeftOut() {
    var state = streamingState()
    state.turn.assistantID = "a:gone"
    state.turn.reasoningID = ""

    #expect(snapshotForCache(state, now: 1).turn == CachedTurn(id: "turn-1"))
  }

  @Test func theTurnIsRestoredOnlyBesideAWatermark() {
    var snapshot = snapshotForCache(streamingState(), now: 1)
    snapshot.lastSeqSessionID = nil

    let restored = stateFromCache("bot", Self.ids, snapshot)
    #expect(restored.turn.id == nil)
    #expect(restored.turn.assistantID == nil)
    #expect(restored.lastSeq == 0)
  }

  @Test func aRestoredBubblePointerNeedsAnOpenUnpersistedAssistantItem() {
    func restoredAssistant(_ change: (inout CachedTranscript) -> Void) -> String? {
      var snapshot = snapshotForCache(streamingState(), now: 1)
      change(&snapshot)
      return stateFromCache("bot", Self.ids, snapshot).turn.assistantID
    }

    #expect(restoredAssistant { _ in } == "a:1000")
    // It is sealed commentary now.
    #expect(
      restoredAssistant { snapshot in
        for index in snapshot.items.indices {
          snapshot.items[index].updateAssistant { $0.interim = true }
        }
      } == nil)
    // It became a row.
    #expect(restoredAssistant { $0.items[1].rowID = 9 } == nil)
    // It points at something that is not an assistant bubble.
    #expect(restoredAssistant { $0.turn?.assistantID = "r:1" } == nil)
    // It points at nothing.
    #expect(restoredAssistant { $0.turn?.assistantID = "a:gone" } == nil)
    // An empty turn id is no turn.
    #expect(restoredAssistant { $0.turn?.id = "" } == nil)
  }

  @Test func theThoughtPointerNeedsAnAssistantItemToo() {
    var snapshot = snapshotForCache(streamingState(), now: 1)
    snapshot.turn?.reasoningID = "r:1"
    #expect(stateFromCache("bot", Self.ids, snapshot).turn.reasoningID == nil)

    snapshot.turn?.reasoningID = "a:2000"
    #expect(stateFromCache("bot", Self.ids, snapshot).turn.reasoningID == "a:2000")
  }

  // MARK: Diagnostics

  @Test func diagnosticsCountTheItemsCarryingTheIdentitiesAndPrintOneLine() {
    let loaded = reconcileTail(
      createChatState("bot", "stored", "resolved"),
      rowsToItems(
        Self.rows([
          ["role": "user", "row_id": 1, "text": "hi", "display_metadata": ["turn_id": "t-1"]],
          ["role": "tool", "name": "read_file", "tool_id": "c0", "row_id": 3, "call_row_id": 2, "call_index": 0],
          ["role": "tool", "name": "read_file", "tool_id": "c1", "row_id": 5]
        ]),
        .rpc
      )
    )
    let report = transcriptDiagnostics(loaded)

    #expect(report.withCallKey == 1)
    #expect(report.withTurnID == 1)
    #expect(report.jsonValue["withCallKey"] == 1)
    #expect(report.jsonValue["withTurnId"] == 1)
    #expect(formatTranscriptDiagnostics("bot", loaded).contains("bot: 1 with call key, 1 with turn id"))
  }

  // MARK: The wire

  @Test func theEnvelopeAndThePayloadsReadTheNewKeys() {
    let event = GatewayEvent(json: [
      "type": "message.complete", "session_id": "s", "seq": 4, "turn_id": "turn-1",
      "payload": [
        "text": "done", "row_id": 10,
        "persisted_turn": ["complete": true, "final_assistant_row_id": 10, "row_ids": [9, 10, 11], "user_row_id": 9]
      ]
    ])
    #expect(event.turnID == "turn-1")
    guard case .messageComplete(let complete) = event.body else {
      Issue.record("not a message.complete")
      return
    }
    #expect(complete.rowID == 10)
    #expect(complete.persistedTurn?.finalAssistantRowID == 10)
    #expect(complete.persistedTurn?.rowIDs == [9, 10, 11])
    #expect(complete.persistedTurn?.userRowID == 9)
    #expect(complete.persistedTurn?.complete == true)

    let complete2 = GatewayEvent(.messageStart(EmptyPayload()), sessionID: "s", seq: 1, turnID: "turn-2")
    #expect(complete2.json["turn_id"] == "turn-2")

    let start = ToolStartPayload(json: ["call_row_id": 10, "call_index": 0])
    #expect(start.callRowID == 10)
    #expect(start.callIndex == 0)

    let done = ToolCompletePayload(json: ["call_row_id": 10, "call_index": 1, "row_id": 11])
    #expect(done.callRowID == 10)
    #expect(done.callIndex == 1)
    #expect(done.rowID == 11)

    #expect(MessageInterimPayload(json: ["row_id": 8]).rowID == 8)
    #expect(ToolOutputRiskPayload(json: ["call_row_id": 8, "call_index": 2]).callIndex == 2)
    #expect(IdentityTests.row(["role": "tool", "call_row_id": 8, "call_index": 3]).callIndex == 3)
  }
}
