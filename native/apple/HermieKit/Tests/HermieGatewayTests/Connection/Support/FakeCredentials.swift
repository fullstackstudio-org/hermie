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

/// A provider whose every dial fails at the mint with one error (the ladder tests).
struct FailingCredentials: CredentialProvider {
  let error: GatewayError

  var mode: GatewayAuthMode { .sessionToken }

  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] { [:] }

  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan {
    throw error
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
