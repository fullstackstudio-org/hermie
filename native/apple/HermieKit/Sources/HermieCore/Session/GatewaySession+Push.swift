import Foundation
import HermieProtocol
import HermieShared
import HermieTranscript

/// The session's side of a notification action (`PushController.pendingApprovals` and `respond`):
/// what the gateway lists as open for one bot's chat right now, and one answer to it.
///
/// Nothing here trusts the notification. The runtime session asked about is the one THIS session
/// has the bot's chat attached under (opened first when it is not), never the id a payload named;
/// `PushTapRules.resolve` then requires the payload's id, when it names one, to be that same
/// session. So a notification about bot A that names a session of bot B finds nothing to answer.
extension GatewaySession {
  /// The ids the roster knows the bot's own chat by (stored and resolved), for telling it from a
  /// branch or another conversation. Empty until the roster has been read.
  public func canonicalSessionIDs(bot: String) -> [String] {
    guard let canonical = chatList.rows[bot]?.bot.canonical else {
      return []
    }

    return [canonical.id, canonical.resolvedID].filter { !$0.isEmpty }
  }

  /// Wait until the socket is `ready`, for at most `limit`. Throws `PushSessionUnavailable` when it
  /// does not come, or the session is shut down meanwhile.
  public func waitUntilReady(within limit: Duration) async throws {
    let deadline = ContinuousClock.now + limit

    while status.phase != .ready {
      guard !isShutDown, ContinuousClock.now < deadline else {
        throw PushSessionUnavailable()
      }

      try await Task.sleep(for: .milliseconds(50))
    }
  }

  /**
   `approval.pending` for one bot's chat, read from the gateway now: every row stamped with the bot
   and the runtime session it was asked about. The chat is opened first when it is not attached
   yet (a tap from a cold start). Empty when the bot is not on this gateway or the chat cannot be
   attached; throws when the gateway does not answer.
   */
  public func pushOpenApprovals(bot: String) async throws -> [PushOpenApproval] {
    guard Identifiers.isBotName(bot), await roster.bot(named: bot) != nil else {
      return []
    }

    if await store.runtimeSessionID(bot) == nil {
      try await open(bot)
    }

    guard let runtimeID = await store.runtimeSessionID(bot) else {
      return []
    }

    let reply = try await link.requestReply(
      RPC.ApprovalPending.name,
      params: ["session_id": .string(runtimeID), "profile": .string(bot)]
    )

    return (reply.result["approvals"]?.arrayValue ?? []).compactMap { row in
      guard let json = row.objectValue else {
        return nil
      }

      let approval = PendingApproval(json: json)

      return PushOpenApproval(
        bot: bot,
        sessionId: runtimeID,
        requestId: approval.requestID ?? "",
        choices: approval.choices ?? []
      )
    }
  }

  /// Answer one approval a notification action resolved (`PushTapRules.resolve`), through the chat's
  /// own card when it shows one, so the transcript marks it answered.
  public func pushRespond(_ answer: PushApprovalAnswer) async throws {
    guard answer.gatewayId == gatewayID else {
      throw PushSessionUnavailable()
    }

    try await store.answerApprovalFromPush(
      answer.bot,
      approvalID: answer.requestId,
      runtimeSessionID: answer.sessionId,
      choice: answer.choice
    )
  }
}

extension TranscriptStore {
  /// The runtime session a chat is attached under, or nil.
  public func runtimeSessionID(_ key: String) -> String? {
    guard let id = chats[key]?.state.runtimeSessionID, !id.isEmpty else {
      return nil
    }

    return id
  }

  /**
   Answer an approval by its queue id, as a notification action does: through the chat's open card
   for it when there is one (`respondApproval`, which answers on the live reply frame and marks the
   card), otherwise `approval.respond` against the queue entry in that runtime session. The caller
   has already checked against `approval.pending` that it is still open.
   */
  func answerApprovalFromPush(
    _ key: String,
    approvalID: String,
    runtimeSessionID: String,
    choice: String
  ) async throws {
    if let card = openApprovalCard(key, approvalID: approvalID, runtimeSessionID: runtimeSessionID) {
      // `false` is an answer already on its way (the same card answered in the chat): not again.
      _ = try await respondApproval(key, requestID: card, choice: choice)
      return
    }

    let params: JSONValue = [
      "session_id": .string(runtimeSessionID),
      "profile": .string(key),
      "choice": .string(choice),
      "request_id": .string(approvalID)
    ]

    _ = try await link.requestReply(RPC.ApprovalRespond.name, params: params)
  }

  /// The request id of the chat's open approval card for this queue id, in this runtime session.
  private func openApprovalCard(_ key: String, approvalID: String, runtimeSessionID: String) -> String? {
    guard let state = chats[key]?.state, state.runtimeSessionID == runtimeSessionID else {
      return nil
    }

    return state.byRequestID.first { requestID, itemID in
      guard case .approval(let item)? = state.items[itemID], item.state == .open else {
        return false
      }

      return item.approvalID == approvalID || requestID == approvalID
    }?.key
  }
}
