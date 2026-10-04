import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// The `request` item beyond what the golden replay already proves (`request-item.json`):
/// the method list against the contract, the item's JSON, and the rules that keep an
/// answer's VALUES out of it.
@Suite struct RequestItemTests {
  static let now = 1_790_000_000_000.0

  private static func request(_ id: String, _ method: String, title: String = "Title", optional: Bool = true) -> ServerRequest {
    ServerRequest(json: [
      "id": .string(id), "method": .string(method),
      "params": .object([
        "title": .string(title), "summary": .string("Summary"), "optional": .bool(optional),
        "fields": .array([.object(["id": "name", "kind": "text"])]),
      ]),
    ])
  }

  private static func cancel(_ state: ChatState, _ id: String, _ reason: String) -> ChatState {
    applyEvent(
      state,
      GatewayEvent(json: [
        "type": "request.cancel", "seq": 1,
        "payload": .object(["id": .string(id), "method": "x", "reason": .string(reason)]),
      ]),
      now
    )
  }

  private static func asked(_ method: String = "input.form") -> ChatState {
    applyServerRequest(createChatState("bot", "s", "s"), request("srq-9", method), now)
  }

  private static func requestItem(_ state: ChatState, _ id: String = "srq-9") -> RequestItem? {
    state.items[state.byRequestID[id] ?? ""]?.asRequest
  }

  // MARK: - The contract

  @Test func theMethodListIsTheContractsMethodList() throws {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    let schema = try JSONValue(parsing: Data(contentsOf: url.appendingPathComponent("contract/requests/schema.json")))
    let methods = try #require(schema.objectValue?["methods"]?.objectValue)

    #expect(interactiveMethods.sorted() == methods.keys.sorted())
    #expect(!interactiveMethods.contains("approval") && !interactiveMethods.contains("clarify"))
    #expect(isInteractiveMethod("review.draft") && !isInteractiveMethod("input.teleport") && !isInteractiveMethod(nil))
  }

  // MARK: - The item

  @Test func itRoundTripsThroughJSONWithItsSummary() throws {
    var state = Self.asked("review.draft")
    answerRequest(into: &state, "srq-9", .object(["decision": "approved", "edited": true]))
    let before = try #require(Self.requestItem(state))
    let after = try RequestItem(decoding: before.jsonValue, at: "$")

    #expect(after == before)
    #expect(after.answerSummary == RequestAnswerSummary(decision: "approved", edited: true))
    #expect(TranscriptItem.request(before).kind == .request)
  }

  @Test func itHasNoRoomForAnswerValues() throws {
    var state = Self.asked()
    answerRequest(
      into: &state, "srq-9",
      .object([
        "status": "answered", "count": 1, "values": .object(["name": "Ada Lovelace"]),
        "text": "secret draft body", "precision": "Utrecht, Oudegracht 12",
      ])
    )
    let item = try #require(Self.requestItem(state))

    #expect(item.answerSummary == RequestAnswerSummary(status: "answered", count: 1))
    let text = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
    #expect(!text.contains("Ada Lovelace") && !text.contains("secret draft body") && !text.contains("Oudegracht"))
  }

  @Test func titleAndSummaryAreCutToTheContractsLengths() throws {
    let long = ServerRequest(json: [
      "id": "srq-1", "method": "input.form",
      "params": .object(["title": .string(String(repeating: "t", count: 200)), "summary": .string(String(repeating: "s", count: 900))]),
    ])
    let item = try #require(Self.requestItem(applyServerRequest(createChatState("bot", "s", "s"), long, Self.now), "srq-1"))

    #expect(item.title.utf16.count == 80 && item.summary.utf16.count == 500 && item.optional == false)
  }

  @Test func aContactsSharedFieldsAndAScansSymbologyAreTheContractsNamesOnly() throws {
    var state = Self.asked()
    answerRequest(
      into: &state, "srq-9",
      .object([
        "status": "answered",
        // A value, a key the contract does not have and a repeat: only the names survive, once, in the contract's order.
        "fields": .array(["phones", "Bram de Vries", "name", "phones", "ssn"]),
        "symbology": "qr", "audio": true,
        "contact": .object(["name": "Bram de Vries"]), "value": "WIFI:T:WPA;S:home;P:hunter2;;",
      ])
    )

    #expect(
      Self.requestItem(state)?.answerSummary
        == RequestAnswerSummary(status: "answered", fields: ["name", "phones"], symbology: "qr", audio: true))
    let text = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
    #expect(!text.contains("Bram") && !text.contains("hunter2") && !text.contains("ssn"))

    let bads: [JSONObject] = [
      ["fields": .array([])], ["fields": "name"], ["fields": .array(["Bram de Vries"])], ["symbology": "QR"],
      ["symbology": "https://example.com"], ["audio": false], ["audio": "yes"],
    ]
    for bad in bads {
      var dropped = Self.asked()
      var summary: JSONObject = ["status": "answered"]
      summary.merge(bad) { $1 }
      answerRequest(into: &dropped, "srq-9", .object(summary))
      #expect(Self.requestItem(dropped)?.answerSummary == RequestAnswerSummary(status: "answered"), "\(bad)")
    }
  }

  // MARK: - Settling

  @Test func aStringOrAMapThatIsNoSummaryRecordsAnsweredAndNothingMore() throws {
    for answer in [RequestAnswer.text("Ada"), .byQuestion(["name": "Ada"]), .object([:])] {
      var state = Self.asked()
      answerRequest(into: &state, "srq-9", answer)
      let item = try #require(Self.requestItem(state))

      #expect(item.state == .answered && item.answerSummary == nil)
    }
  }

  @Test func aSummaryWithOnlyStringValuesStillCountsAsASummary() throws {
    var state = Self.asked()
    answerRequest(into: &state, "srq-9", .byQuestion(["status": "skipped"]))

    #expect(Self.requestItem(state)?.answerSummary == RequestAnswerSummary(status: "skipped"))
  }

  @Test func countsAndKeysOutsideTheirRangesAreDropped() throws {
    var state = Self.asked()
    answerRequest(into: &state, "srq-9", .object(["status": "maybe", "decision": "approved", "count": -1]))
    #expect(Self.requestItem(state)?.answerSummary == RequestAnswerSummary(decision: "approved"))

    var fractional = Self.asked()
    answerRequest(into: &fractional, "srq-9", .object(["status": "answered", "count": 1.5, "edited": "yes"]))
    #expect(Self.requestItem(fractional)?.answerSummary == RequestAnswerSummary(status: "answered"))

    #expect(TranscriptReducer.isSummaryKey("approximate") && TranscriptReducer.isSummaryKey("a_1"))
    #expect(!TranscriptReducer.isSummaryKey("Approximate") && !TranscriptReducer.isSummaryKey("1a"))
    #expect(!TranscriptReducer.isSummaryKey("") && !TranscriptReducer.isSummaryKey(String(repeating: "a", count: 25)))
  }

  @Test func answersOnceAndAWithdrawalNeverRewritesAnAnswer() throws {
    var state = Self.asked()
    answerRequest(into: &state, "srq-9", .object(["status": "skipped"]))
    let answered = state

    answerRequest(into: &state, "srq-9", .object(["status": "answered", "count": 3]))
    #expect(state == answered)

    let late = Self.cancel(answered, "srq-9", "timeout")
    #expect(Self.requestItem(late)?.state == .answered && Self.requestItem(late)?.cancelReason == nil)

    let withdrawn = Self.cancel(Self.asked(), "srq-9", "too_many_attempts")
    #expect(Self.requestItem(withdrawn)?.state == .cancelled && Self.requestItem(withdrawn)?.cancelReason == "too_many_attempts")

    var after = withdrawn
    answerRequest(into: &after, "srq-9", .object(["status": "answered"]))
    #expect(after == withdrawn)
  }

  @Test func theAnswerThatResolvedItUpgradesAResolvedCancelOnly() throws {
    let resolved = Self.cancel(Self.asked(), "srq-9", "resolved")
    #expect(Self.requestItem(resolved)?.state == .cancelled && Self.requestItem(resolved)?.cancelReason == "resolved")

    var answered = resolved
    answerRequest(into: &answered, "srq-9", .object(["status": "answered"]))
    #expect(Self.requestItem(answered)?.state == .answered)
    #expect(Self.requestItem(answered)?.cancelReason == nil)
    #expect(Self.requestItem(answered)?.answerSummary == RequestAnswerSummary(status: "answered"))

    var again = answered
    answerRequest(into: &again, "srq-9", .object(["status": "skipped"]))
    #expect(again == answered)

    for reason in ["timeout", "too_many_attempts", "turn_ended", "lapsed", "cannot_show"] {
      let withdrawn = Self.cancel(Self.asked(), "srq-9", reason)
      var after = withdrawn
      answerRequest(into: &after, "srq-9", .object(["status": "answered"]))
      #expect(after == withdrawn)
    }
  }

  @Test func theTurnEndingCancelsAnOpenRequest() throws {
    let ended = applyEvent(
      Self.asked(),
      GatewayEvent(json: ["type": "message.complete", "seq": 2, "payload": .object(["text": "done", "status": "complete"])]),
      Self.now
    )

    #expect(Self.requestItem(ended)?.state == .cancelled && Self.requestItem(ended)?.cancelReason == "turn_ended")
  }

  // MARK: - Around it

  @Test func anOpenRequestIsAskedAboutAndNotCachedASettledOneIs() throws {
    let open = Self.asked()
    let ids = SessionIDs(storedSessionID: "s", resolvedSessionID: "s")

    #expect(hasOpenRequest(open) && openRequests(open).count == 1)
    #expect(turnActivity(open) == .waiting)
    #expect(stateFromCache("bot", ids, snapshotForCache(open, now: Self.now)).order.isEmpty)

    var settled = open
    answerRequest(into: &settled, "srq-9", .object(["status": "answered", "count": 2]))
    let painted = stateFromCache("bot", ids, snapshotForCache(settled, now: Self.now))

    #expect(!hasOpenRequest(settled) && turnActivity(settled) == .idle)
    #expect(Self.requestItem(painted)?.answerSummary == RequestAnswerSummary(status: "answered", count: 2))
  }

  @Test func aReplayedOpenRequestDrawsNoSecondCard() throws {
    let once = Self.asked()
    let twice = applyServerRequest(once, Self.request("srq-9", "input.form"), Self.now)

    #expect(twice.order.count == 1 && twice == once)
  }
}
