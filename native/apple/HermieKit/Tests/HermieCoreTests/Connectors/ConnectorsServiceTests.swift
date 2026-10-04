import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct ConnectorsServiceTests {
  private let rpc = ScriptedRPC()
  private var service: ConnectorsService { ConnectorsService(gateway: rpc.gateway) }

  // MARK: The rows

  @Test func aRowIsKnownByItsSlugAndLabelledByTheVendorsNameWhenThereIsOne() throws {
    let plain = try #require(
      ConnectorItem(row: jsonValue(#"{"connector": "gmail", "connected": true, "enabled": true, "connectionStatus": "active"}"#)))
    let named = try #require(
      ConnectorItem(row: jsonValue(#"{"connector": "gmail", "name": "Gmail", "description": "Mail."}"#)))

    #expect(plain.slug == "gmail")
    #expect(plain.label == "gmail", "the slug stands in for a missing name")
    #expect(plain.connected)
    #expect(plain.enabled == true)
    #expect(plain.connectionStatus == "active")
    #expect(named.label == "Gmail")
    #expect(named.description == "Mail.")
  }

  @Test func theStatusFieldsAreReadUnderBothSpellings() throws {
    let camel = try #require(
      ConnectorItem(row: jsonValue(#"{"connector": "a", "connectionStatus": "failed", "statusReason": "revoked"}"#)))
    let snake = try #require(
      ConnectorItem(row: jsonValue(#"{"connector": "a", "connection_status": "failed", "status_reason": "revoked"}"#)))

    #expect(camel.connectionStatus == "failed" && camel.statusReason == "revoked")
    #expect(snake.connectionStatus == "failed" && snake.statusReason == "revoked")
  }

  @Test func anAbsentEnabledFlagIsNotOffAndARowWithNoNameIsDropped() throws {
    let row = try #require(ConnectorItem(row: jsonValue(#"{"connector": "a"}"#)))

    #expect(row.enabled == nil)
    #expect(row.connected == false)
    #expect(ConnectorItem(row: jsonValue(#"{"connected": true}"#)) == nil)
    #expect(ConnectorItem(row: jsonValue(#""text""#)) == nil)
  }

  // MARK: The list

  @Test func theListNamesTheAccountAsItsOwnerAndNeverASessionId() async throws {
    rpc.respond("connectors.list", jsonValue(#"{"available": true, "connectors": [{"connector": "gmail"}]}"#))

    let list = try await service.list(profile: "writer")

    #expect(list.available)
    #expect(list.connectors.map(\.slug) == ["gmail"])

    let call = try #require(rpc.calls("connectors.list").first)

    #expect(call["owner"] == ["type": "account"])
    #expect(call["profile"] == "writer")
    #expect(call["session_id"] == nil, "the gateway's contract is extra=forbid: a top-level session_id is refused")
    #expect(Set(call.keys) == ["owner", "profile"])
  }

  @Test func switchedOffIsASuccessfulAnswerThatSaysSo() async throws {
    rpc.respond("connectors.list", jsonValue(#"{"available": false, "connectors": []}"#))

    let list = try await service.list(profile: nil)

    #expect(list.available == false)
    #expect(list.connectors.isEmpty)
    #expect(rpc.calls("connectors.list").first?["profile"] == nil)
  }

  // MARK: Connecting

  @Test func aConnectNamesTheSlugAndOnlyAsksForAReconnectWhenItMeansOne() async throws {
    rpc.respond(
      "connectors.connect",
      jsonValue(
        #"{"op_id": "op-1", "seq": 3, "settled": false, "targets": [{"name": "notion", "state": "initiated", "connect_url": "https://v.example.test/a"}]}"#
      ))

    let operation = try await service.connect("notion", reconnect: false, profile: "writer")
    _ = try await service.connect("notion", reconnect: true, profile: "writer")

    #expect(operation.id == "op-1")
    #expect(operation.seq == 3)
    #expect(operation.target("notion")?.connectURL == "https://v.example.test/a")
    #expect(operation.target("notion")?.state == .initiated)

    let first = try #require(rpc.calls("connectors.connect").first)
    let second = try #require(rpc.calls("connectors.connect").last)

    #expect(first["connectors"] == ["notion"])
    #expect(first["reconnect"] == nil)
    #expect(second["reconnect"] == true)
    #expect(first["owner"] == ["type": "account"])
    #expect(Set(first.keys) == ["owner", "profile", "connectors"])
  }

  @Test func theStatusAndTheWakeNameTheOperation() async throws {
    rpc.respond("connectors.operation.status", jsonValue(#"{"op_id": "op-1", "seq": 4, "settled": true, "targets": []}"#))
    rpc.respond("connectors.operation.wake", jsonValue(#"{"status": "ok"}"#))

    let status = try await service.status(of: "op-1", profile: "writer")
    await service.wake("op-1", profile: "writer")

    #expect(status.settled)
    #expect(rpc.calls("connectors.operation.status").first?["op_id"] == "op-1")
    #expect(Set(rpc.calls("connectors.operation.wake").first.map { Array($0.keys) } ?? []) == ["owner", "profile", "op_id"])
  }

  @Test func aWakeThatTheGatewayRefusesIsIgnored() async {
    rpc.refuse("connectors.operation.wake", "No open operation with that op_id.", code: 4004)

    await service.wake("gone", profile: nil)

    #expect(rpc.calls("connectors.operation.wake").count == 1)
  }

  @Test func aSettledTargetIsAnOutcomeAndAMovingOneIsNot() {
    func target(_ state: String, detail: String? = nil) -> ConnectionOperationTarget {
      var json: JSONObject = ["name": "a", "state": .string(state)]

      if let detail {
        json["detail"] = .string(detail)
      }

      return ConnectionOperationTarget(json: json)
    }

    #expect(ConnectOutcome(settled: target("connected")) == .connected)
    #expect(ConnectOutcome(settled: target("expired")) == .expired)
    #expect(ConnectOutcome(settled: target("skipped")) == .skipped)
    #expect(ConnectOutcome(settled: target("failed", detail: "the workspace refused")) == .failed("the workspace refused"))
    #expect(ConnectOutcome(settled: target("unavailable")) != nil)
    #expect(ConnectOutcome(settled: target("initiated")) == nil)
    #expect(ConnectOutcome(settled: target("pending")) == nil)

    if case .failed(let words)? = ConnectOutcome(settled: target("failed")) {
      #expect(words.isEmpty == false, "a failure with no words has some")
    } else {
      Issue.record("expected a failure")
    }
  }
}
