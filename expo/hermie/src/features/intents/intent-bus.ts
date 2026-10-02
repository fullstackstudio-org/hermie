/**
 * "A Shortcut is waiting", from a shell that has no way to say it directly.
 *
 * The exact twin of `features/share/share-bus.ts`, for the same structural
 * reason: `hermie://intent/<id>` arrives at `useHermieLink`, which is mounted
 * inside whichever shell is on screen, and `IntentRunner` lives beside the chat
 * controller where no shell can reach it.
 *
 * It differs from the share bus in what a missed message costs. A share that is
 * not pumped now is pumped at the next foreground and nobody notices; a
 * Shortcut that is not run now is a person watching a spinner until the budget
 * runs out. So this is the LATENCY-CRITICAL one of the two, even though the
 * mechanism is identical — which is why the runner is also driven by the
 * gateway's ready edge rather than by this alone.
 */

type Handler = () => void

const handlers = new Set<Handler>()

/** Subscribe. Returns its own teardown, which is what a React effect wants. */
export function onIntentRequest(handler: Handler): () => void {
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
  }
}

/** Ask the runner to drain the queue now. */
export function requestIntentRun(): void {
  for (const handler of [...handlers]) {
    try {
      handler()
    } catch {
      // One subscriber throwing must not stop another.
    }
  }
}
