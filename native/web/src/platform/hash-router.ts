/**
 * The page's address fragment: where the client's routes live (plan W4).
 *
 * The gateway's static route has no single-page fallback, so a route cannot be
 * a path; it is the part after `#`. This seam is the only code outside `boot/`
 * that reads or writes `location.hash`, listens for `hashchange` or calls
 * `history.replaceState`. `features/shell/router.ts` turns the string it hands
 * back into a route and decides what an unknown one means.
 *
 *  - `navigate` is a link click: a history entry, and `hashchange` fires.
 *  - `replace` rewrites the entry in place (an unknown route sent to `#/`).
 *    `replaceState` fires no event of its own, so the seam tells its own
 *    listeners; a page that only ever listened to `hashchange` would keep
 *    showing the route it had just replaced.
 *
 * Every function takes its browser objects as an argument, so a test hands in
 * its own.
 */

/** What the router reads and writes, so a test can hand in its own. */
export interface HashRouterEnvironment {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>
  history: Pick<History, 'state' | 'replaceState'>
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export interface HashRouter {
  /** The fragment as the address holds it: `''` or `#…`. */
  current(): string
  /** Called on every change, from any cause (not at once). Returns the unsubscribe. */
  subscribe(onChange: (hash: string) => void): () => void
  /** Go to a fragment, adding a history entry. The same fragment is not an entry. */
  navigate(hash: string): void
  /** Rewrite the current history entry's fragment. */
  replace(hash: string): void
}

const pageEnvironment = (): HashRouterEnvironment | null =>
  typeof window === 'undefined' ? null : { location: window.location, history: window.history, window }

/**
 * `null` means "no window": an empty fragment, and nothing to listen to or
 * write. The fragment is kept in memory then, so the shell is testable on its
 * own.
 */
export function createHashRouter(environment: HashRouterEnvironment | null = pageEnvironment()): HashRouter {
  const listeners = new Set<(hash: string) => void>()
  let detached: (() => void) | undefined
  let memory = ''

  const read = (): string => (environment ? environment.location.hash : memory)

  const notify = (): void => {
    const hash = read()

    for (const listener of [...listeners]) {
      listener(hash)
    }
  }

  const attach = (): void => {
    if (!environment || detached) {
      return
    }

    environment.window.addEventListener('hashchange', notify)
    detached = () => environment.window.removeEventListener('hashchange', notify)
  }

  return {
    current: read,

    subscribe(onChange) {
      listeners.add(onChange)
      attach()

      return () => {
        listeners.delete(onChange)

        if (listeners.size === 0) {
          detached?.()
          detached = undefined
        }
      }
    },

    navigate(hash) {
      if (hash === read()) {
        return
      }

      if (environment) {
        // `hashchange` follows by itself.
        environment.location.hash = hash

        return
      }

      memory = hash
      notify()
    },

    replace(hash) {
      if (hash === read()) {
        return
      }

      if (environment) {
        const { location, history } = environment

        history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
      } else {
        memory = hash
      }

      notify()
    }
  }
}

/** The page's own router. */
export const pageHashRouter: HashRouter = createHashRouter()
