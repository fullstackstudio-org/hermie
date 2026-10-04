import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

// YOLO mode: the session skips approval requests. One `config.set` scoped to this session, so the
// switch never rewrites the gateway's own configuration (`scope: "session"`, as the web client does).
// What the gateway then says about the session (`session.info.yolo`) is what the chat shows.

extension TranscriptStore {
  /// Switch YOLO mode on or off for this chat's session.
  ///
  /// The answer carries the session's new info when the gateway sends it; a gateway that only
  /// announces it as a `session.info` event of its own has it applied from the event, in wire order.
  /// When neither is here by the time the answer is placed, the switch is taken as made: the gateway
  /// answered without an error.
  public func setYolo(_ key: String, enabled: Bool) async throws {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    let params: JSONValue = [
      "key": "yolo",
      "value": .string(enabled ? "on" : "off"),
      "session_id": .string(runtimeID),
      "profile": .string(key),
      "scope": "session"
    ]

    try await ordered(key, { [link] in try await link.requestReply(RPC.ConfigSet.name, params: params) }) { reply in
      let reported = reply.result["info"]?.objectValue.flatMap { SessionLiveInfo(json: $0).yolo }
      let value = reported ?? enabled

      self.mutateState(key) { state in
        if state.info == nil {
          state.info = SessionLiveInfo(json: [:])
        }

        state.info?.yolo = value
      }
    }
  }
}
