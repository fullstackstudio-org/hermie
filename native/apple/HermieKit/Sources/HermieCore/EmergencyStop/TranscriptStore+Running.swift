import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// What the store found running on its gateway, before anyone is named for it.
struct RunningSessions: Sendable, Equatable {
  /// A running session one of this app's own chats holds: stopped through the chat.
  struct Held: Sendable, Equatable {
    var key: String
    var runtimeID: String
  }

  /// A running session the app does not hold in any chat: another client's (the terminal, another
  /// device of the same person), a branch, a cron's run. Stopped by its runtime id.
  struct Other: Sendable, Equatable {
    var runtimeID: String
    /// The stored session id the gateway lists it under, to tell which bot it is.
    var sessionKey: String
    var title: String
  }

  var held: [Held] = []
  var other: [Other] = []
  /// Running sessions the gateway lists as a bare row: busy, but not ones this connection may act on
  /// (it gives no runtime id for them), so nothing can be stopped there from here.
  var unreachable = 0
  /// The gateway's list was read. When it was not, `held` is what the app's own chats say is busy and
  /// nothing else is known.
  var listed = true
}

extension TranscriptStore {
  /**
   The sessions that are running on the gateway right now, from one `session.active_list` and the
   chats this app holds.

   The gateway's list is the truth: a chat that thinks its turn is busy while the list says
   otherwise has finished, and a session in the list that no chat holds is somebody else's turn
   this connection may still stop (the same person's: the gateway lists a session in full only to a
   connection that may act on it, and as a bare row to any other). Where the list cannot be read the
   app's own chats are all there is to go by.
   */
  func runningSessions() async -> RunningSessions {
    let rows: [JSONValue]?

    do {
      rows = try await link.requestReply(RPC.SessionActiveList.name, params: [:]).result["sessions"]?.arrayValue
    } catch {
      rows = nil
    }

    guard let rows else {
      var found = RunningSessions(listed: false)

      for (key, record) in chats.sorted(by: { $0.key < $1.key }) {
        if let id = record.state.runtimeSessionID, !id.isEmpty, isBusy(record.state) {
          found.held.append(.init(key: key, runtimeID: id))
        }
      }

      return found
    }

    var busy: [String: JSONValue] = [:]
    var found = RunningSessions()

    for row in rows where BotRoster.busyStatuses.contains(Self.text(row["status"])) {
      let id = Self.text(row["id"])

      if id.isEmpty {
        found.unreachable += 1
      } else {
        busy[id] = row
      }
    }

    var claimed = Set<String>()

    for (key, record) in chats.sorted(by: { $0.key < $1.key }) {
      if let id = record.state.runtimeSessionID, busy[id] != nil, claimed.insert(id).inserted {
        found.held.append(.init(key: key, runtimeID: id))
      }
    }

    for id in busy.keys.sorted() where !claimed.contains(id) {
      let row = busy[id]
      found.other.append(
        .init(runtimeID: id, sessionKey: Self.text(row?["session_key"]), title: Self.text(row?["title"])))
    }

    return found
  }

  /// Interrupt a running session this app holds no chat for, by its runtime id. Answers whether the
  /// gateway interrupted a turn (`false`: it had ended by itself).
  func interruptSession(_ runtimeID: String) async throws -> Bool {
    let params: JSONValue = ["session_id": .string(runtimeID)]
    let reply = try await link.requestReply(RPC.SessionInterrupt.name, params: params)

    return Self.interrupted(reply.result)
  }

  /// Stop every running turn of the caller's, in one call (`session.interrupt_all`): the fork's own method.
  /// Throws `GatewayRPCError` with code `-32601` on a gateway that does not have it.
  func interruptEverything() async throws -> JSONValue {
    try await link.requestReply(RPC.SessionInterruptAll.name, params: [:]).result
  }

  private static func text(_ value: JSONValue?) -> String {
    value?.stringValue ?? ""
  }
}
