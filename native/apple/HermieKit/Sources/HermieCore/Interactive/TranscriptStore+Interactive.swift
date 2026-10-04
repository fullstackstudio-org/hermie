import Foundation
import HermieProtocol
import HermieTranscript

/// What `InteractiveRequestCenter` tells a chat's transcript about the interactive requests
/// (`input.form`, `input.file`, `review.draft`): that a question was asked and how it ended. The
/// card carries no value (`RequestItem` has no field that could hold one), and neither do these
/// calls: the answer's `summary` is the whitelisted status, count and `edited` flag.
///
/// Each call is placed among the chat's frames like any local change (`local`): after everything
/// taken in before it, so a withdrawal that arrived first has already been applied. The center
/// makes them one at a time, in order, so an answer never overtakes its question.
extension TranscriptStore {
  /// The question is on its chat: put its card up (`applyServerRequest`). One the gateway already
  /// withdrew (a `request.cancel` that overtook it) draws none.
  func interactiveAsked(_ key: String, request: ServerRequest, replayed: Bool) async {
    _ = try? await local(key) {
      guard self.chats[key] != nil, let id = request.id, !(self.closedRequests[key] ?? []).contains(id) else {
        return
      }

      var json = request.json

      if replayed {
        json["replayed"] = true
      }

      let now = self.now()
      self.mutateState(key) { applyServerRequest(into: &$0, ServerRequest(json: json), now) }
    }
  }

  /// The answer went out: mark the card answered, with `summary` (`status`, `decision`, `count`,
  /// `edited`; anything else is dropped by the engine).
  func interactiveAnswered(_ key: String, requestID: String, summary: JSONObject) async {
    _ = try? await local(key) {
      self.mutateState(key) { answerRequest(into: &$0, requestID, .object(summary)) }
    }
  }

  /// The question ended without an answer from here (its deadline passed, a reconnect found the
  /// gateway no longer waiting, its chat let go of its session, this app could not show it): close
  /// the card as the gateway's own `request.cancel` with `reason` would. A card that is not open
  /// (answered, or withdrawn by the gateway meanwhile) is left as it is.
  func interactiveEnded(_ key: String, requestID: String, reason: String) async {
    _ = try? await local(key) {
      guard let state = self.chats[key]?.state, let itemID = state.byRequestID[requestID],
        case .request(let item)? = state.items[itemID], item.state == .open
      else {
        return
      }

      let event = GatewayEvent(json: [
        "type": .string(GatewayEventType.requestCancel),
        "session_id": .string(state.runtimeSessionID ?? ""),
        "payload": ["id": .string(requestID), "reason": .string(reason)]
      ])
      let now = self.now()
      self.mutateState(key) { applyEvent(into: &$0, event, now) }
    }
  }
}
