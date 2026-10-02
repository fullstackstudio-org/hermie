import Synchronization

/// A one-shot result that can be settled before anyone waits for it, the role
/// a JavaScript `Promise` plays in the reference's dial loop.
///
/// The dial loop needs exactly that: the `gateway.ready` waiter is registered
/// before the socket is dialled (the frame can land in the same turn the socket
/// opens), and may be rejected while the dial is still connecting. A
/// continuation cannot exist before something awaits it; this can.
///
/// The first settlement wins; later ones are ignored.
final class Promise<Value: Sendable>: Sendable {
  private struct State {
    var outcome: Result<Value, any Error>?
    var waiters: [CheckedContinuation<Value, any Error>] = []
  }

  private let state = Mutex(State())

  func settle(_ outcome: Result<Value, any Error>) {
    let waiters = state.withLock { state -> [CheckedContinuation<Value, any Error>] in
      guard state.outcome == nil else {
        return []
      }

      state.outcome = outcome
      defer { state.waiters = [] }
      return state.waiters
    }

    for waiter in waiters {
      waiter.resume(with: outcome)
    }
  }

  func resolve(_ value: Value) {
    settle(.success(value))
  }

  func reject(_ error: any Error) {
    settle(.failure(error))
  }

  var isSettled: Bool {
    state.withLock { $0.outcome != nil }
  }

  /// Wait for the outcome (or return it at once when it is already there).
  func value() async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      let outcome = state.withLock { state -> Result<Value, any Error>? in
        if let outcome = state.outcome {
          return outcome
        }

        state.waiters.append(continuation)
        return nil
      }

      if let outcome {
        continuation.resume(with: outcome)
      }
    }
  }
}
