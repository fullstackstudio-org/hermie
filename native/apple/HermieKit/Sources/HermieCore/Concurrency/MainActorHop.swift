import Foundation

/**
 For callbacks from Apple frameworks that may come on any queue (delegate methods, completion
 handlers, notification blocks). Such a callback must be `nonisolated` (or `@Sendable`): a closure or
 method isolated to the main actor that the system calls from another queue traps in Swift 6's
 runtime isolation check. The callback reads what it was given into `Sendable` values, then hands the
 rest to the main actor through `run`.
 */
public enum MainActorHop {
  /// Runs `body` on the main actor: at once when already on the main thread (so a callback that does
  /// arrive there keeps its order), otherwise as soon as the main actor is free.
  public static func run(_ body: @escaping @MainActor @Sendable () -> Void) {
    if Thread.isMainThread {
      MainActor.assumeIsolated(body)
    } else {
      Task { @MainActor in body() }
    }
  }
}
