import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// One profile on a gateway that stores it the way the real one does (`methods_profiles.py`): skills
/// as the DISABLED set, toolsets as an optional pin that an empty list removes, MCP servers as the
/// enabled complement, a soul, a description and a model pin; and answers
/// `profiles.describe`, `profiles.configure`, `profiles.set_asset`, `model.options` and `reload.mcp`.
final class ProfileGateway: Sendable {
  struct State {
    var description = "Finds things out."
    var soul = "You are careful."
    var provider = "example-provider"
    var model = "example-model"
    var skills = ["pdf", "docx", "web-search"]
    var disabledSkills: Set<String> = ["docx"]
    var toolsets = ["files", "web", "terminal"]
    /// `nil`: no pin, the platform defaults (all three) apply.
    var pinnedToolsets: Set<String>?
    var mcpServers = ["github", "notes"]
    var disabledMcp: Set<String> = []
    var avatar: String?
    var reloadsNeedConfirmation = true

    var calls: [(method: String, params: JSONObject)] = []
    /// Errors the next request for a method throws instead of answering.
    var failing: [String: any Error] = [:]
    var unsupported: Set<String> = []
    /// The method whose next request is kept in flight until `release()`.
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
  }

  let state = Mutex(State())

  var gateway: BotSettingsGateway {
    BotSettingsGateway { method, params in
      await self.holdIfArmed(method)
      return try self.handle(method, params)
    }
  }

  // MARK: Test controls

  func hold(_ method: String) {
    state.withLock { $0.armed = method }
  }

  @MainActor
  func waitUntilHeld() async {
    await botSettingsEventually("a held request") { state.withLock { $0.held != nil } }
  }

  func release() {
    let held = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.held = nil }
      return state.held
    }

    held?.resume()
  }

  private func holdIfArmed(_ method: String) async {
    guard state.withLock({ $0.armed == method }) else {
      return
    }

    await withCheckedContinuation { continuation in
      state.withLock { state in
        state.armed = nil
        state.held = continuation
      }
    }
  }

  func fail(_ method: String, with error: any Error) {
    state.withLock { $0.failing[method] = error }
  }

  func refuse(_ method: String, code: Int = 4030, message: String = "This account may not change profiles.") {
    fail(method, with: GatewayRPCError(.rejected, message, code: code))
  }

  var configures: [JSONObject] { calls("profiles.configure") }

  func calls(_ method: String) -> [JSONObject] {
    state.withLock { $0.calls.filter { $0.method == method }.map(\.params) }
  }

  var methods: [String] { state.withLock { $0.calls.map(\.method) } }

  // MARK: The gateway

  private func handle(_ method: String, _ params: JSONObject) throws -> JSONValue {
    try state.withLock { state in
      state.calls.append((method, params))

      if state.unsupported.contains(method) {
        throw GatewayRPCError(.rejected, "unknown method: \(method)", code: -32601)
      }

      if let error = state.failing.removeValue(forKey: method) {
        throw error
      }

      switch method {
      case "profiles.describe":
        let enabled = state.pinnedToolsets ?? Set(state.toolsets)

        return [
          "name": params["name"] ?? "researcher",
          "description": .string(state.description),
          "soul": .string(state.soul),
          "model": ["provider": .string(state.provider), "default": .string(state.model)],
          "skills": .array(
            state.skills.map { ["name": .string($0), "enabled": .bool(!state.disabledSkills.contains($0))] }),
          "toolsets": .array(
            state.toolsets.map {
              [
                "name": .string($0), "label": .string($0.capitalized), "description": .string("About \($0)."),
                "tool_count": 3, "enabled": .bool(enabled.contains($0))
              ]
            }),
          "toolsets_pinned": .bool(state.pinnedToolsets != nil),
          "mcp_servers": .array(
            state.mcpServers.map {
              ["name": .string($0), "enabled": .bool(!state.disabledMcp.contains($0)), "transport": "stdio"]
            })
        ]

      case "profiles.configure":
        var applied: JSONObject = [:]
        var answer: JSONObject = [:]

        if let text = params["description"]?.stringValue {
          state.description = text
          applied["description"] = true
        }

        if let text = params["soul"]?.stringValue {
          state.soul = text
          applied["soul"] = true
        }

        if let model = params["model"]?.stringValue, let provider = params["provider"]?.stringValue {
          if model.contains("expensive"), params["confirm_expensive_model"] != .bool(true) {
            answer["confirm_required"] = true
            answer["confirm_message"] = .string("\(model) is an expensive model. Continue?")
          } else {
            state.provider = provider
            state.model = model.hasPrefix("\(provider)/") ? String(model.dropFirst(provider.count + 1)) : model
            applied["model"] = true
          }
        }

        if case .array(let names)? = params["disabled_skills"] {
          state.disabledSkills = Set(names.compactMap(\.stringValue))
          applied["skills"] = true
        }

        if case .array(let names)? = params["enabled_toolsets"] {
          let wanted = Set(names.compactMap(\.stringValue))
          state.pinnedToolsets = wanted.isEmpty ? nil : wanted
          applied["toolsets"] = true
        }

        if case .array(let names)? = params["enabled_mcp_servers"] {
          let wanted = Set(names.compactMap(\.stringValue))
          state.disabledMcp = Set(state.mcpServers).subtracting(wanted)
          applied["mcp_servers"] = true
        }

        answer["ok"] = true
        answer["applied"] = .object(applied)
        return .object(answer)

      case "profiles.set_asset":
        if params["clear"] == .bool(true) {
          state.avatar = nil
          return ["ok": true, "asset": "avatar", "size": 0, "removed": 1]
        }

        state.avatar = params["data"]?.stringValue
        return ["ok": true, "asset": "avatar", "size": 4]

      case "model.options":
        return [
          "providers": [
            [
              "slug": "example-provider", "name": "Example Provider",
              "models": ["example-model", "expensive-model"], "total_models": 2, "is_current": true
            ],
            ["slug": "second-provider", "name": "Second Provider", "models": ["reasoner-2"], "total_models": 1]
          ],
          "model": "example-provider/example-model", "provider": "example-provider"
        ]

      case "reload.mcp":
        if state.reloadsNeedConfirmation, params["confirm"] != .bool(true) {
          return ["status": "confirm_required", "message": "Reloading will invalidate the prompt cache."]
        }

        if params["always"] == .bool(true) {
          state.reloadsNeedConfirmation = false
        }

        return ["status": "reloaded"]

      default:
        throw GatewayRPCError(.rejected, "unknown method: \(method)", code: -32601)
      }
    }
  }
}

/// Until `condition` holds, on the main actor where the model lives.
@MainActor
func botSettingsEventually(_ what: String, _ condition: () -> Bool) async {
  let deadline = ContinuousClock.now + .seconds(5)

  while !condition() {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      return
    }

    try? await Task.sleep(for: .milliseconds(2))
  }
}
