import Foundation

/// One caller at a time through an async section, in the order they asked, none dropped.
///
/// For a shared object that keeps one continuation per question (the system's location manager does):
/// two sheets asking at once (two windows) would both pass a "nothing in flight" check before either
/// had set its continuation, and the second would replace the first, which then never resumes. Here
/// the turn is taken synchronously, on the main actor, before anything is awaited; a caller that
/// finds it taken waits its turn, and a waiter whose task is cancelled leaves the line at once.
@MainActor
final class SerialTurns {
  private var busy = false
  private var next: UInt64 = 0
  private var waiters: [(id: UInt64, continuation: CheckedContinuation<Bool, Never>)] = []

  /// Run `body` when it is this caller's turn; `cancelled` is the answer of a caller whose task was
  /// cancelled while it waited (its body does not run).
  func run<Result: Sendable>(ifCancelled cancelled: Result, _ body: @MainActor () async -> Result) async -> Result {
    guard await acquire() else {
      return cancelled
    }

    defer { release() }
    return await body()
  }

  /// How many callers wait for their turn.
  var waiting: Int { waiters.count }

  private func acquire() async -> Bool {
    // Taken before any suspension: this is what makes two callers unable to both pass.
    if !busy {
      busy = true
      return true
    }

    let id = next
    next += 1

    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        if Task.isCancelled {
          continuation.resume(returning: false)
        } else {
          waiters.append((id, continuation))
        }
      }
    } onCancel: {
      Task { @MainActor in
        self.leave(id)
      }
    }
  }

  private func leave(_ id: UInt64) {
    guard let index = waiters.firstIndex(where: { $0.id == id }) else {
      return
    }

    waiters.remove(at: index).continuation.resume(returning: false)
  }

  /// The turn passes to the next in line, still held: `busy` only clears when nobody waits.
  private func release() {
    if waiters.isEmpty {
      busy = false
    } else {
      waiters.removeFirst().continuation.resume(returning: true)
    }
  }
}
