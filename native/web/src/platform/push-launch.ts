/**
 * The two parts of Web Push the session needs before (or without) its chunk, kept
 * small on purpose because they are in the first load:
 *
 *  - the click this page was opened for by the service worker, once
 *    (`?hermiePush=`, `core/push/launch.ts`): read from the address and removed
 *    from it before anything else can act on it again, so the rest of Web Push
 *    can load after the session has started;
 *  - letting this browser's subscription go on sign-out, which must happen even
 *    when the chunk is still loading or failed to load.
 */
import { type PushResponse, takeLaunchResponse } from '../core/push/launch'

export function takePageLaunchResponse(): PushResponse | null {
  return typeof window === 'undefined' ? null : takeLaunchResponse(window.location, window.history)
}

/** Unsubscribe the subscription of the worker at the page's directory, if there is one. Rejects on a browser refusal. */
export async function unsubscribePageWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker) {
    return
  }

  const registration = await navigator.serviceWorker.getRegistration('./')
  const subscription = await registration?.pushManager?.getSubscription()

  await subscription?.unsubscribe()
}
