import Foundation
import HermieGateway
import HermieProtocol
import Synchronization

@testable import HermieCore

/// JSON as the wire writes it. Tests build their answers from text rather than from dictionary
/// literals: a long literal of nested `JSONValue`s is what the 6.3 type checker times out on.
func jsonValue(_ text: String) -> JSONValue {
  // swiftlint:disable:next force_try
  try! JSONValue(parsing: text)
}

/// A gateway's RPC side, scripted: what each method answers (or refuses with), and what was asked.
/// `gateway` is the seam the services take (`BotSettingsGateway`).
final class ScriptedRPC: Sendable {
  struct Call: Sendable {
    var method: String
    var params: JSONObject
  }

  private struct State {
    var calls: [Call] = []
    var handlers: [String: @Sendable (JSONObject) throws -> JSONValue] = [:]
    var held: String?
    var waiting: CheckedContinuation<Void, Never>?
  }

  private let state = Mutex(State())

  var gateway: BotSettingsGateway {
    BotSettingsGateway { method, params in
      let handler = self.state.withLock { state -> (@Sendable (JSONObject) throws -> JSONValue)? in
        state.calls.append(Call(method: method, params: params))

        return state.handlers[method]
      }

      await self.holdIfArmed(method)

      guard let handler else {
        throw GatewayRPCError(.rejected, "unknown method: \(method)", code: 4001)
      }

      return try handler(params)
    }
  }

  var calls: [Call] { state.withLock { $0.calls } }

  func calls(_ method: String) -> [JSONObject] {
    state.withLock { $0.calls.filter { $0.method == method }.map(\.params) }
  }

  func respond(_ method: String, _ value: JSONValue) {
    state.withLock { $0.handlers[method] = { _ in value } }
  }

  func handle(_ method: String, _ handler: @escaping @Sendable (JSONObject) throws -> JSONValue) {
    state.withLock { $0.handlers[method] = handler }
  }

  func refuse(_ method: String, _ message: String, code: Int = 4001) {
    state.withLock { $0.handlers[method] = { _ in throw GatewayRPCError(.rejected, message, code: code) } }
  }

  /// The next call to `method` is kept in the air until `release()`.
  func hold(_ method: String) {
    state.withLock { $0.held = method }
  }

  var isHolding: Bool { state.withLock { $0.waiting != nil } }

  func release() {
    let waiting = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.waiting = nil }
      return state.waiting
    }

    waiting?.resume()
  }

  private func holdIfArmed(_ method: String) async {
    let armed = state.withLock { state -> Bool in
      guard state.held == method else {
        return false
      }

      state.held = nil

      return true
    }

    guard armed else {
      return
    }

    await withCheckedContinuation { continuation in
      state.withLock { $0.waiting = continuation }
    }
  }
}
