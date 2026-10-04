import Foundation
import HermieProtocol

/// What the gateway said to a correction handed to a running child (`SteerStatus`).
public enum SubagentSteerOutcome: Sendable, Equatable {
  /// Queued. Queued is not delivered: a child past its final tool batch surfaces `missed_steer`.
  case queued
  /// The child would not take it.
  case rejected
}

/// A child's live transcript, the last 16 KB of it.
public enum SubagentTail: Sendable, Equatable {
  case text(String)
  /// The child has no live transcript (yet, or it was cleaned up).
  case unavailable
}

extension TranscriptStore {
  /// `subagent.steer`: queue `text` into a live child of this chat. The runtime session is the chat's
  /// own; a chat that has none yet is not attached.
  public func steerSubagent(_ key: String, id: String, text: String) async throws -> SubagentSteerOutcome {
    let reply = try await link.requestReply(
      RPC.SubagentSteer.name, params: try subagentParams(key, id, ["text": .string(text)]))

    return reply.result["status"]?.stringValue == "rejected" ? .rejected : .queued
  }

  /// `subagent.interrupt`: stop one child. False when the gateway no longer knows it (it finished).
  public func interruptSubagent(_ key: String, id: String) async throws -> Bool {
    let reply = try await link.requestReply(RPC.SubagentInterrupt.name, params: try subagentParams(key, id))

    return reply.result["found"]?.boolValue == true
  }

  /// `subagent.tail`: the child's live transcript. `available: false` is a child with nothing yet.
  public func tailSubagent(_ key: String, id: String) async throws -> SubagentTail {
    let reply = try await link.requestReply(RPC.SubagentTail.name, params: try subagentParams(key, id))

    guard reply.result["available"]?.boolValue != false else {
      return .unavailable
    }

    return .text(reply.result["text"]?.stringValue ?? "")
  }

  private func subagentParams(_ key: String, _ id: String, _ extra: JSONObject = [:]) throws -> JSONValue {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    var params: JSONObject = ["session_id": .string(runtimeID), "profile": .string(key), "subagent_id": .string(id)]

    for (name, value) in extra {
      params[name] = value
    }

    return .object(params)
  }
}
