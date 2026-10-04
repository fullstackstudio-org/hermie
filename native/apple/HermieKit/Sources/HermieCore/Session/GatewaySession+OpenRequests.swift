import Foundation
import HermieProtocol

/// What the session's four holders of requests say is open right now, as `RequestAlerts` reads it
/// (the transcript's approvals, questions and cards; the secure prompts; the interactive requests;
/// the passkey confirmations).
struct OpenRequestSample: Sendable {
  /// Every request but a confirmation, named by chat, with no `chatName` yet.
  var requests: [OpenRequest]
  /// The confirmations still waiting: their chat is the store's to say (`chatKey(forRuntime:)`).
  var confirmations: [PasskeyConfirmation]
  /// The connection is `ready`: a list read now may be trusted to say what is over.
  var ready: Bool
}

extension GatewaySession {
  /**
   Everything the person is being asked, from the four places that hold it. Reads only observable
   state that moves when a request opens or ends (`openAsks`, `secureInput.prompts`,
   `interactive.prompts`, `passkeys.confirmations`, `status`), so an `Observations` over it wakes for
   nothing else: not for a token of a streaming reply, and not for a chat's unread count.
   */
  func openRequestSample() -> OpenRequestSample {
    var requests: [OpenRequest] = []

    for chat in openAsks.keys.sorted() {
      for ask in openAsks[chat] ?? [] {
        requests.append(
          OpenRequest(gatewayId: gatewayID, chat: chat, method: ask.method, requestId: ask.requestId, text: ask.text)
        )
      }
    }

    for prompt in secureInput.prompts {
      requests.append(
        OpenRequest(
          gatewayId: gatewayID,
          chat: prompt.chatKey,
          method: prompt.method,
          requestId: prompt.id,
          sessionId: prompt.sessionID
        )
      )
    }

    for prompt in interactive.prompts {
      requests.append(
        OpenRequest(
          gatewayId: gatewayID,
          chat: prompt.chatKey,
          method: prompt.method,
          requestId: prompt.id,
          sessionId: prompt.sessionID
        )
      )
    }

    let now = Date()
    let confirmations = (passkeys?.confirmations ?? []).filter { $0.isOpen && !$0.isExpired(at: now) }

    return OpenRequestSample(requests: requests, confirmations: confirmations, ready: status.phase == .ready)
  }

  /**
   The sample as the final list: confirmations placed in their chats, one entry per request (a card on
   the transcript and the interactive center's prompt are the same request), each chat under the name
   the person gave it. A confirmation whose chat is not known yet is left out and counted in
   `unresolved`: a later pass finds it.
   */
  func openRequests(from sample: OpenRequestSample) async -> (requests: [OpenRequest], unresolved: Int) {
    var all = sample.requests
    var unresolved = 0

    for confirmation in sample.confirmations {
      guard let chat = await store.chatKey(forRuntime: confirmation.sessionID) else {
        unresolved += 1
        continue
      }

      all.append(
        OpenRequest(
          gatewayId: gatewayID,
          chat: chat,
          method: PushRequestMethod.confirm.rawValue,
          requestId: confirmation.id,
          sessionId: confirmation.sessionID,
          level: .passkey
        )
      )
    }

    var seen = Set<String>()
    var out: [OpenRequest] = []

    for var request in all where seen.insert(request.requestId).inserted {
      request.chatName = chatName(request.chat)
      out.append(request)
    }

    return (out, unresolved)
  }

  /// Fold a batch's chat summaries into `openAsks`; it moves only when what is open does.
  func applyAsks(_ batch: FrameBatch) {
    guard !batch.summaries.isEmpty || !batch.removed.isEmpty else {
      return
    }

    var next = openAsks

    for (key, summary) in batch.summaries {
      next[key] = summary.asks.isEmpty ? nil : summary.asks
    }

    for key in batch.removed {
      next[key] = nil
    }

    if next != openAsks {
      openAsks = next
    }
  }
}
