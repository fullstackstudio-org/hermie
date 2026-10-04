import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

// The per-chat options beyond YOLO mode: fast mode, reasoning effort and the model, each one
// `config.set` for this chat's session, and the context usage the gateway reports. What the gateway
// then says about the session (`session.info`) is what the chat shows, as with YOLO mode.

extension TranscriptStore {
  /// Switch one option for this chat's session.
  ///
  /// Scoped as the web client scopes it: reasoning effort to the session (so it never rewrites the
  /// gateway's own configuration), and the model switch carrying `confirm_expensive_model` only
  /// when the reader confirmed. A model the gateway calls expensive writes nothing and is handed
  /// back as `.needsConfirmation`: this never confirms on its own.
  public func setOption(
    _ key: String,
    option: ChatSessionOption,
    value: String,
    confirmExpensive: Bool = false
  ) async throws -> ChatOptionOutcome {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    var params: JSONObject = [
      "key": .string(option.rawValue),
      "value": .string(value),
      "session_id": .string(runtimeID),
      "profile": .string(key)
    ]

    if option == .reasoning {
      params["scope"] = "session"
    }

    if option == .model, confirmExpensive {
      params["confirm_expensive_model"] = true
    }

    let sent = JSONValue.object(params)

    return try await ordered(key, { [link] in try await link.requestReply(RPC.ConfigSet.name, params: sent) }) {
      reply in
      let result = reply.result

      if result["confirm_required"] == .bool(true) {
        return .needsConfirmation(message: Self.nonEmpty(result["confirm_message"]?.stringValue))
      }

      let reported = result["info"]?.objectValue.map { SessionLiveInfo(json: $0) }

      self.mutateState(key) { state in
        if state.info == nil {
          state.info = SessionLiveInfo(json: [:])
        }

        switch option {
        case .fast:
          state.info?.fast = reported?.fast ?? (value != "normal" && value != "off")
        case .reasoning:
          state.info?.reasoningEffort = reported?.reasoningEffort ?? value
        case .model:
          state.info?.model = reported?.model ?? value

          if let provider = reported?.provider {
            state.info?.provider = provider
          }
        }
      }

      return .applied(warning: Self.nonEmpty(result["warning"]?.stringValue))
    }
  }

  /// The models the gateway offers, flattened out of `model.options` and kept for the connection:
  /// the inventory is a fact about the gateway, not about one chat. A gateway that cannot answer
  /// throws, and nothing is kept, so the next open asks again.
  public func modelChoices() async throws -> [BotModelChoice] {
    if let cached = modelChoiceCache {
      return cached
    }

    let reply = try await link.requestReply(RPC.ModelOptions.name, params: .object([:]))

    guard let options = ModelOptionsResult(jsonValue: reply.result) else {
      return []
    }

    let choices = BotModelChoice.choices(options)
    modelChoiceCache = choices
    return choices
  }

  /// Ask the gateway how full this session's context window is (`session.usage`), for a chat that was
  /// resumed and not yet spoken to: the ticks and the end of a turn keep it current from then on.
  ///
  /// Capability-gated by the gateway's own refusal: a gateway that does not know the method says so
  /// once, and nothing asks again on this connection. Answers `false` when there was nothing to read.
  @discardableResult
  public func refreshUsage(_ key: String) async -> Bool {
    guard usageSupported, let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return false
    }

    let params = JSONValue.object(["session_id": .string(runtimeID), "profile": .string(key)])

    do {
      let usage: JSONValue = try await ordered(
        key, { [link] in try await link.requestReply(RPC.SessionUsage.name, params: params) }
      ) { $0.result }

      guard case .object(let object) = usage, !object.isEmpty else {
        return false
      }

      mutateState(key) { $0.usage = Usage(json: object) }
      return true
    } catch is CancellationError {
      return false
    } catch {
      // Only the gateway's own refusal says the method is not there; a socket that dropped or a
      // call that timed out says nothing about it, and the next attempt is welcome.
      if let refusal = error as? GatewayRPCError, refusal.kind == .rejected {
        usageSupported = false
      }

      return false
    }
  }

  private static func nonEmpty(_ text: String?) -> String? {
    guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return text
  }
}
