import Foundation
import Testing

@testable import HermieProtocol

/// The payloads the session layer reads beside the transcript, in the shapes the gateway's Python
/// contract gives them, read into their typed cases and rebuilt key for key.
@Suite("Session signal payloads")
struct SessionSignalPayloadTests {
  private func event(_ text: String) throws -> GatewayEvent {
    try #require(GatewayEvent(jsonValue: try JSONValue(parsing: text)))
  }

  private func roundTrips(_ event: GatewayEvent) throws -> Bool {
    try canonical(TypedCopy.event(event)) == canonical(event)
  }

  @Test func aNoticeReadsAndRebuilds() throws {
    let show = try event(
      #"{"type":"notification.show","session_id":"rt-1","seq":3,"payload":{"text":"You've used $5.00 of your $10.00 cap","level":"warn","kind":"ttl","ttl_ms":8000,"key":"credits.usage","id":"credits.usage"}}"#
    )
    guard case .notificationShow(let payload) = show.body else {
      Issue.record("notification.show did not read as one")
      return
    }
    #expect(payload.level == .warn)
    #expect(payload.kind == .ttl)
    #expect(payload.ttlMs == 8000)
    #expect(payload.key == "credits.usage")
    #expect(try roundTrips(show))

    let sticky = try event(#"{"type":"notification.show","payload":{"text":"x","level":"info","kind":"agent","ttl_ms":null}}"#)
    guard case .notificationShow(let agent) = sticky.body else {
      Issue.record("notification.show did not read as one")
      return
    }
    #expect(agent.ttlMs == nil)
    #expect(agent.kind == .agent)

    let clear = try event(#"{"type":"notification.clear","session_id":"rt-1","seq":4,"payload":{"key":"credits.usage"}}"#)
    guard case .notificationClear(let cleared) = clear.body else {
      Issue.record("notification.clear did not read as one")
      return
    }
    #expect(cleared.key == "credits.usage")
    #expect(try roundTrips(clear))
  }

  @Test func aConnectionRequestAndItsUpdatesReadAndRebuild() throws {
    let request = try event(
      #"{"type":"connection.request","session_id":"rt-1","seq":7,"payload":{"op_id":"op-1","seq":1,"deadline_at":1790000300.5,"timeout_seconds":300,"tool_call_id":"call-9","targets":[{"name":"calendar","kind":"connector","action":"authorize","state":"initiated","connect_url":"https://auth.example.invalid/start?x=1","attempt":"a1"},{"name":"files","kind":"mcp","action":"install","state":"pending","required_env":[{"name":"TOKEN","required":true,"secret":true,"default":""}],"scan":{"status":"passed","summary":"ok"}}]}}"#
    )
    guard case .connectionRequest(let payload) = request.body else {
      Issue.record("connection.request did not read as one")
      return
    }
    #expect(payload.opID == "op-1")
    #expect(payload.deadlineAt == 1_790_000_300.5)
    #expect(payload.targets?.count == 2)
    #expect(payload.targets?.first?.state == .initiated)
    #expect(payload.targets?.first?.connectURL == "https://auth.example.invalid/start?x=1")
    #expect(payload.targets?.last?.requiredEnv?.first?.secret == true)
    #expect(try roundTrips(request))

    let update = try event(
      #"{"type":"connection.update","session_id":"rt-1","seq":8,"payload":{"op_id":"op-1","seq":2,"deadline_at":1790000300.5,"settled":true,"settled_at":1790000100,"settled_by":"all_resolved","targets":[{"name":"calendar","kind":"connector","action":"authorize","state":"connected"}],"owner":{"type":"session","session_id":"rt-1"},"target":"calendar","from":"initiated","to":"connected","actor":"backend_watcher"}}"#
    )
    guard case .connectionUpdate(let changed) = update.body else {
      Issue.record("connection.update did not read as one")
      return
    }
    #expect(changed.settledBy == .allResolved)
    #expect(changed.fromState == .initiated)
    #expect(changed.to == .connected)
    #expect(changed.owner?.sessionID == "rt-1")
    #expect(try roundTrips(update))
    #expect(ConnectionSettleReason(rawValue: "continue") == .continue)
    #expect(ConnectionTargetState(rawValue: "not_connected") == .notConnected)
  }

  @Test func resumeProgressAndControlUpdatesReadAndRebuild() throws {
    let progress = try event(
      #"{"type":"session.resume_progress","session_id":"rt-1","seq":1,"payload":{"message_count":40,"phase":"history","status":"complete"}}"#
    )
    guard case .sessionResumeProgress(let payload) = progress.body else {
      Issue.record("session.resume_progress did not read as one")
      return
    }
    #expect(payload.status == .complete)
    #expect(payload.messageCount == 40)
    #expect(try roundTrips(progress))

    let control = try event(
      #"{"type":"session.control.update","session_id":"rt-1","seq":2,"payload":{"control":{"goal":{"text":"ship"},"loop":null,"heartbeat":null,"revision":"abc","updated_at":1790000000}}}"#
    )
    guard case .sessionControlUpdate(let snapshot) = control.body else {
      Issue.record("session.control.update did not read as one")
      return
    }
    #expect(snapshot.control?.revision == "abc")
    #expect(try roundTrips(control))
  }

  @Test func theCapabilitiesAndThePendingConnectionRead() throws {
    let capabilities = GatewayCapabilitiesResult(json: ["per_session_exclusive_submit": true, "per_message_author": true])
    #expect(capabilities.perMessageAuthor == true)
    #expect(GatewayCapabilitiesResult(json: ["per_session_exclusive_submit": true]).perMessageAuthor == nil)

    let resume = SessionResumeResult(json: [
      "session_id": "rt-1",
      "pending_connection": ["op_id": "op-1", "seq": 3, "deadline_at": 10, "timeout_seconds": 5, "targets": []]
    ])
    #expect(resume.pendingConnectionRequest?.opID == "op-1")
    #expect(resume.pendingConnectionRequest?.seq == 3)
    #expect(RPC.allMethodNames.contains("gateway.capabilities"))
    #expect(RPC.allMethodNames.contains("connection.respond"))
    #expect(RPC.allMethodNames.contains("session.status"))
  }
}
