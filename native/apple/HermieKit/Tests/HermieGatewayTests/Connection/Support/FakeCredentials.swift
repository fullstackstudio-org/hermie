import Foundation
import Synchronization

@testable import HermieGateway

/// The credential providers `connection.test.ts` builds, against the fake
/// gateway instead of HTTP: `SessionTokenCredentials` (the token in the dial
/// URL, `reauth` on a rejection) and `NativePkceCredentials` (a fresh ticket in
/// the subprotocols for every dial, a refresh-token rotation on a rejection).
final class FakeCredentials: CredentialProvider {
  enum Flavor: Sendable {
    case sessionToken
    case native
  }

  let flavor: Flavor
  let gateway: FakeGateway
  private let refreshToken = Mutex("refresh-0")
  private let calls = Mutex((dialPlans: 0, rejections: 0))
  private let holds = Mutex(Holds())

  /// What a test can make the provider wait on, or fail with.
  struct Holds {
    /// `dialPlan` waits here before minting.
    var dialPlan: Gate?
    /// `onRejected` waits here before answering.
    var rejection: Gate?
    /// `onRejected` throws this once it is let through.
    var rejectionFailure: GatewayError?
  }

  func hold(_ change: (inout Holds) -> Void) {
    holds.withLock { change(&$0) }
  }

  init(_ flavor: Flavor, gateway: FakeGateway) {
    self.flavor = flavor
    self.gateway = gateway
  }

  var mode: GatewayAuthMode {
    switch flavor {
    case .sessionToken: .sessionToken
    case .native: .nativePKCE
    }
  }

  var dialPlans: Int { calls.withLock { $0.dialPlans } }
  var rejections: Int { calls.withLock { $0.rejections } }

  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] {
    [:]
  }

  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    calls.withLock { $0.dialPlans += 1 }

    if let gate = holds.withLock({ $0.dialPlan }) {
      await gate.wait()
    }

    switch flavor {
    case .sessionToken:
      var components = URLComponents(string: wsURL)!
      components.queryItems = [URLQueryItem(name: "token", value: gateway.token)]
      return DialPlan(url: components.string!, headers: extraHeaders)

    case .native:
      let ticket = try gateway.mintTicket()
      return DialPlan(
        url: wsURL,
        protocols: [GatewayWebSocketProtocol.base, GatewayWebSocketProtocol.ticketPrefix + ticket],
        headers: extraHeaders
      )
    }
  }

  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict {
    calls.withLock { $0.rejections += 1 }

    let (gate, failure) = holds.withLock { ($0.rejection, $0.rejectionFailure) }

    if let gate {
      await gate.wait()
    }

    if let failure {
      throw failure
    }

    switch flavor {
    case .sessionToken:
      return .reauth

    case .native:
      // Read the token, let anything else run, then rotate it: two rotations
      // in flight at once would both present the same token, which is exactly
      // the replay a provider with reuse detection punishes.
      let presented = refreshToken.withLock { $0 }
      await Task.yield()
      let rotated = gateway.refresh(presenting: presented)
      refreshToken.withLock { $0 = rotated }
      return .retry
    }
  }

  func signOut() async throws {}
}

/// A provider whose every dial fails at the mint (the ladder tests): with
/// `errors` in turn, the last one repeating.
final class FailingCredentials: CredentialProvider {
  let errors: [GatewayError]
  private let dials = Mutex(0)

  init(error: GatewayError) {
    errors = [error]
  }

  init(errors: [GatewayError]) {
    self.errors = errors
  }

  var mode: GatewayAuthMode { .sessionToken }

  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] { [:] }

  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    let dial = dials.withLock { dials in
      defer { dials += 1 }
      return dials
    }

    throw errors[min(dial, errors.count - 1)]
  }

  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict { .reauth }

  func signOut() async throws {}
}

/// The subprotocols the gateway speaks (`GATEWAY_WS_PROTOCOL`,
/// `GATEWAY_WS_TICKET_PREFIX`). The production constants belong to the
/// credential providers; the fakes keep their own copy.
enum GatewayWebSocketProtocol {
  static let base = "hermes-gateway-v1"
  static let ticketPrefix = "hermes-gateway-ticket."
}

/// Something a fake can wait on until a test lets it through.
final class Gate: Sendable {
  private let state = Mutex((open: false, waiters: [CheckedContinuation<Void, Never>]()))

  func wait() async {
    await withCheckedContinuation { continuation in
      let open = state.withLock { state in
        if !state.open {
          state.waiters.append(continuation)
        }
        return state.open
      }

      if open {
        continuation.resume()
      }
    }
  }

  var waiting: Int { state.withLock { $0.waiters.count } }

  func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }

    for waiter in waiters {
      waiter.resume()
    }
  }
}
