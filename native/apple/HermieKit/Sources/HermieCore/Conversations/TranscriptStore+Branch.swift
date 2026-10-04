import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

extension TranscriptStore {
  /**
   Fork the chat under `key` into a conversation of its own, from one item of its transcript
   (`branchFrom` in the web client's chat controller).

   The branch is an ordinary visible session of the same profile (nothing here can ask for a hidden
   one), so the canonical chat it was taken from is untouched by construction. Nothing is started on
   the session it forks and no turn is in its way: a turn running on the parent is no reason to wait.

   `session.branch` wants the RUNTIME id and a message count (`BranchPoint`), counted off the whole
   ordered transcript. The count is never zero: a branch of no messages is a branch of nothing, and a
   gateway that took it literally would hand back an empty conversation under a name that promised
   otherwise.

   The title in the answer is the one the gateway settled on, not the one asked for: a name already
   worn is refused upstream, and the Conversations page finds the branch by what it ended up with.
   */
  public func branch(_ key: String, from itemID: String, title: String) async throws -> Conversation {
    guard let state = chats[key]?.state, let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    let ordered = state.order.compactMap { state.items[$0] }.map { (id: $0.id, rowID: $0.rowID) }
    let count = max(1, BranchPoint.messageCount(in: ordered, upTo: itemID))
    let params = SessionBranchParams(sessionID: runtimeID, profile: key, name: title, count: count)
    let reply = try await link.requestReply(RPC.SessionBranch.name, params: .object(params.json))
    let result = SessionBranchResult(json: reply.result.objectValue ?? [:])

    guard let storedID = result.storedSessionID, !storedID.isEmpty else {
      throw ChatRuntimeError(message: "The gateway branched \(key)'s chat without returning its id.")
    }

    let settled = result.title.flatMap { $0.isEmpty ? nil : $0 } ?? title

    return Conversation(
      id: storedID,
      resolvedID: storedID,
      title: settled,
      messageCount: result.messageCount ?? 0,
      lastActive: (now() / 1000).rounded(.down),
      kind: .branch
    )
  }
}
