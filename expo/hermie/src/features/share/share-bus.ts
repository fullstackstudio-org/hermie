/**
 * "Something was shared", from a shell that has no way to say it directly.
 *
 * `hermie://share/<id>` arrives at `useHermieLink`, which is mounted inside
 * whichever shell is on screen. The thing that has to act on it is
 * `ShareDelivery`, which lives beside the chat controller in `ChatRuntime` and
 * is not reachable from a shell — the same shape as a push notification needing
 * to open a chat, answered the same way (`app/open-chat-bus.ts`).
 *
 * Deliberately not a queue, and for a stronger reason than the chat bus has: the
 * durable queue is the outbox DIRECTORY. A request that arrives with nothing
 * subscribed is dropped and costs nothing at all, because the entry is still on
 * disk and the next pump — the launch, the next foreground — finds it. This is
 * an optimisation on latency, never on correctness.
 */

type Handler = () => void

const handlers = new Set<Handler>()

/** Subscribe. Returns its own teardown, which is what a React effect wants. */
export function onShareRequest(handler: Handler): () => void {
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
  }
}

/** Ask the delivery flow to look in the outbox now rather than at the next foreground. */
export function requestShareDelivery(): void {
  for (const handler of [...handlers]) {
    try {
      handler()
    } catch {
      // One subscriber throwing must not stop another, and a pump that failed
      // is not a reason to lose the link that asked for it.
    }
  }
}
