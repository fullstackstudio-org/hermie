/**
 * Whether the page is on screen: the browser's stand-in for React Native's
 * `AppState`, which the connection lifecycle ported from the Expo app reads
 * (`attachLifecycle` in `src/gateway/client.ts` there).
 *
 * Three events, one answer:
 *
 *  - `visibilitychange` is the real signal: a tab in the background, a window
 *    minimised, a screen locked.
 *  - `pagehide` comes when the page is unloaded or frozen into the back/forward
 *    cache, where `visibilitychange` is not promised to fire first. It always
 *    means hidden.
 *  - `pageshow` is its counterpart for a page restored from that cache.
 *
 * A browser tab that is hidden may be throttled to a stop, so a hidden page
 * really is one whose socket should close after a grace period; the grace
 * period itself belongs to the lifecycle, not to this seam. Repeats are
 * dropped, so a listener hears a change and never the same answer twice.
 */

export type Visibility = 'visible' | 'hidden'

export interface VisibilityWatcher {
  /** The answer now. */
  current(): Visibility
  /** Called on every change (not at once). Returns the unsubscribe. */
  subscribe(onChange: (visibility: Visibility) => void): () => void
}

/** What the watcher reads, so a test can hand in its own. */
export interface VisibilityEnvironment {
  document: Pick<Document, 'addEventListener' | 'removeEventListener'> & { readonly visibilityState?: string }
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

const pageEnvironment = (): VisibilityEnvironment | null =>
  typeof window === 'undefined' || typeof document === 'undefined' ? null : { document, window }

export function createVisibilityWatcher(
  environment: VisibilityEnvironment | null = pageEnvironment()
): VisibilityWatcher {
  const read = (): Visibility => (environment?.document.visibilityState === 'hidden' ? 'hidden' : 'visible')

  return {
    current: read,
    subscribe(onChange) {
      if (!environment) {
        return () => {}
      }

      let last = read()

      const report = (next: Visibility) => {
        if (next !== last) {
          last = next
          onChange(next)
        }
      }

      const onVisibilityChange = () => report(read())
      const onPageHide = () => report('hidden')
      const onPageShow = () => report(read())

      environment.document.addEventListener('visibilitychange', onVisibilityChange)
      environment.window.addEventListener('pagehide', onPageHide)
      environment.window.addEventListener('pageshow', onPageShow)

      return () => {
        environment.document.removeEventListener('visibilitychange', onVisibilityChange)
        environment.window.removeEventListener('pagehide', onPageHide)
        environment.window.removeEventListener('pageshow', onPageShow)
      }
    }
  }
}

/** The page's own watcher. */
export const visibilityWatcher: VisibilityWatcher = createVisibilityWatcher()
