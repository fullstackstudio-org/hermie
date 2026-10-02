import Foundation
import Synchronization

@testable import HermieGateway

/// `tokens()` / `tokenSet()` of the reference tests.
func tokens(
  accessToken: String = "at-1",
  refreshToken: String = "rt-1",
  expiresAt: Double = 10_000,
  provider: String = "self-hosted",
  userID: String = "tester"
) -> TokenSet {
  TokenSet(accessToken: accessToken, refreshToken: refreshToken, expiresAt: expiresAt, provider: provider, userID: userID)
}

/// An auth timeline that keeps every event, in order.
final class RecordingTimeline: AuthEventRecorder {
  private let recorded = Mutex<[AuthEvent]>([])

  func record(_ event: AuthEvent) {
    recorded.withLock { $0.append(event) }
  }

  var events: [AuthEvent] { recorded.withLock { $0 } }
  var names: [String] { events.map(\.event.rawValue) }
}

/// A gate a test opens: everything waiting on it resumes then.
actor Gate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen {
      return
    }

    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true

    for waiter in waiters {
      waiter.resume()
    }

    waiters.removeAll()
  }
}

/// A counter several tasks can bump.
final class Counter: Sendable {
  private let value = Mutex(0)

  @discardableResult
  func increment() -> Int {
    value.withLock {
      $0 += 1
      return $0
    }
  }

  var count: Int { value.withLock { $0 } }
}

/// A token store whose three operations are closures, for the cases that need
/// a slow, failing or recording store.
struct ScriptedTokenStore: TokenStore {
  var onLoad: @Sendable () throws -> TokenSet?
  var onSave: @Sendable (TokenSet) throws -> Void = { _ in }
  var onClear: @Sendable () throws -> Void = {}

  func load() throws -> TokenSet? { try onLoad() }
  func save(_ tokens: TokenSet) throws { try onSave(tokens) }
  func clear() throws { try onClear() }
}

/// A plain error with a message, like a platform failure.
struct PlainFailure: Error, CustomStringConvertible {
  var description: String
}

/// A coordinator over a memory store that never reads the wall clock (`coordinatorWith`).
func coordinator(
  _ initial: TokenSet?,
  now: Double = 0,
  timeline: RecordingTimeline? = nil,
  refresh: @escaping TokenCoordinator.Refresh = { _ in tokens() }
) -> (TokenCoordinator, MemoryTokenStore) {
  let store = MemoryTokenStore(initial)
  return (TokenCoordinator(store: store, refresh: refresh, nowSeconds: { now }, timeline: timeline), store)
}

/// Credentials that carry nothing (`anonymous`).
struct AnonymousCredentials: CredentialProvider {
  var verdict: RejectionVerdict = .reauth
  var headers: [String: String] = [:]

  var mode: GatewayAuthMode { .sessionToken }
  func httpAuthHeaders(_ options: AuthHeaderOptions) async throws -> [String: String] { headers }
  func dialPlan(wsURL: String, extraHeaders: [String: String]) async throws -> DialPlan { DialPlan(url: wsURL) }
  func onRejected(rejectedToken: String?) async throws -> RejectionVerdict { verdict }
  func signOut() async throws {}
}

/// Wait (in real time, briefly) until `count` callers have joined a refresh in flight.
func waitForJoins(_ coordinator: TokenCoordinator, _ count: Int) async {
  for _ in 0..<5_000 where await coordinator.joinedRefreshes < count {
    try? await Task.sleep(for: .milliseconds(1))
  }
}

/// Wait (in real time, briefly) until `condition` holds.
func waitUntil(_ condition: @Sendable () -> Bool) async {
  for _ in 0..<5_000 where !condition() {
    try? await Task.sleep(for: .milliseconds(1))
  }
}

/// Run `work` and hand back the `GatewayError` it threw (or `nil`).
func gatewayError<T>(_ work: () async throws -> T) async -> GatewayError? {
  do {
    _ = try await work()
    return nil
  } catch {
    return error as? GatewayError
  }
}
