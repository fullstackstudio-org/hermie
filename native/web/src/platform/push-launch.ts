/**
 * The click this page was opened for by the service worker, once (`?hermiePush=`,
 * `core/push/actions.ts`): read from the address and removed from it before
 * anything else can act on it again. Read by the session as it starts, so the
 * rest of Web Push can be a chunk of its own; small on purpose, because it is in
 * the first load.
 */
import { type PushResponse, takeLaunchResponse } from '../core/push/launch'

export function takePageLaunchResponse(): PushResponse | null {
  return typeof window === 'undefined' ? null : takeLaunchResponse(window.location, window.history)
}
