/**
 * "Show me that folder", from a widget tap.
 *
 * `hermie://folder/<id>` arrives at `useHermieLink` inside whichever shell is
 * mounted, and the thing that has to act on it is the chat list — which is a
 * screen, not a controller, and which on a phone may not even be the route on
 * top yet. The same shape as `app/open-chat-bus.ts`, with one difference that
 * matters.
 *
 * **This one RETAINS.** The chat bus is deliberately not a queue, because a
 * request with no shell mounted only happens during a sign-out and replaying it
 * would open a chat on a gateway the reader has just left. A folder tap is the
 * opposite case: the commonest one by far is a COLD START, where the link is
 * read during the first mount and the list does not exist yet. Dropping it
 * there would mean the feature worked only when the app was already open.
 *
 * So the request is held until something consumes it, and consuming clears it —
 * `consume` rather than `get`, for the reason `deep-link.ts` gives about a
 * launch URL: anything that merely reads would answer the same folder to every
 * caller forever, and a Fast Refresh would re-scroll the list.
 *
 * Opening the folder is NOT done here. That is a write to the arrangement
 * (`chat-layout`'s `setFolderOpen`), it works whether or not any list is
 * mounted, and the shells do it directly — this is only the scroll.
 */

type Handler = (folderId: string) => void

const handlers = new Set<Handler>()

/** The folder a link asked for and nobody has shown yet. */
let pending: string | null = null

/** Subscribe. Returns its own teardown, which is what a React effect wants. */
export function onRevealFolder(handler: Handler): () => void {
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
  }
}

/**
 * Take the folder a link asked for, if there is one, and forget it.
 *
 * Called by the list when it mounts. A list that mounts after the link arrived
 * gets it here; one that was already mounted got it through `onRevealFolder`.
 */
export function consumeRevealFolder(): string | null {
  const folderId = pending

  pending = null

  return folderId
}

/** Ask whichever chat list is mounted — or the next one — to show that folder. */
export function requestRevealFolder(folderId: string): void {
  pending = folderId

  for (const handler of [...handlers]) {
    try {
      pending = null
      handler(folderId)
    } catch {
      // One list throwing must not stop another, and a scroll that failed is
      // not a reason to lose the tap. The request is already cleared: a handler
      // that threw HAD it, and replaying into the next mount would scroll a
      // list the reader has since moved away from.
    }
  }
}
