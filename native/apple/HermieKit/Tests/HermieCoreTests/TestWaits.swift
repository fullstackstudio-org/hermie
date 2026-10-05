import Foundation
import Testing

/// Until `condition` holds, on the caller's actor (the main actor, for a model that lives there). For what has no
/// signal of its own to await: a state a model reaches by itself, a call that arrives on another task. Where a signal
/// exists (a continuation, a stream, the model's own awaitable), await that instead.
///
/// The limit only turns a hang into a failure, and counts only the waiting that is the test's own. The test run is one
/// process whose UI suites lay windows out on the main actor for seconds on a quiet machine and for far longer on a
/// loaded runner (a CI run recorded a stall of nearly forty seconds), so a main-actor test that is merely queued behind
/// them has not hung, and a poll that counts iterations or a few seconds of wall clock gives up on a model that is only
/// waiting for its turn. Time that a pause overran by is given back.
func waitUntil(
  _ what: String,
  patience: Duration = .seconds(60),
  isolation: isolated (any Actor)? = #isolation,
  sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () async -> Bool
) async {
  let pause = Duration.milliseconds(5)
  var deadline = ContinuousClock.now + patience

  while !(await condition()) {
    let before = ContinuousClock.now

    guard before < deadline else {
      Issue.record("Timed out waiting for \(what)", sourceLocation: sourceLocation)
      return
    }

    try? await Task.sleep(for: pause)

    let overrun = ContinuousClock.now - before - pause

    if overrun > .milliseconds(250) {
      deadline += overrun
    }
  }
}
