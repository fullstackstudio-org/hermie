/**
 * Where the gateway is, read from where the page is.
 *
 * The client is served by the gateway's own static route at
 * `<origin><prefix>/dashboard-plugins/hermie/app/index.html` (plan W2, W4), so
 * the gateway's base URL is the page's origin plus whatever stands in front of
 * that suffix. The prefix is there when a reverse proxy publishes the gateway
 * under a path; it is empty otherwise.
 *
 * The same path without `index.html` (`.../app/` or `.../app`) is accepted for
 * an alias a fork or a proxy may add (plan F-1). Anything else is not a page
 * this client can find its gateway from, and the error names the path it
 * expected rather than guessing.
 */

/** The page's path under a gateway, prefix not included. */
export const APP_DOCUMENT_PATH = '/dashboard-plugins/hermie/app/index.html'

/** The directory the page and its assets live in. */
export const APP_DIRECTORY_PATH = '/dashboard-plugins/hermie/app/'

const SUFFIXES = [APP_DOCUMENT_PATH, APP_DIRECTORY_PATH, APP_DIRECTORY_PATH.slice(0, -1)] as const

export interface ResolvedBasePath {
  ok: true
  /** `''`, or a path such as `/hermes` with no trailing slash. */
  prefix: string
  /** The gateway's base URL: origin plus prefix, no trailing slash. */
  baseUrl: string
  /**
   * The page's own path as the browser sees it, prefix included. A sign-in
   * returns here (`next`), so it must be the path the browser can load again,
   * not the one the gateway sees behind a proxy that strips the prefix.
   */
  appPath: string
  /**
   * What browser storage for this gateway is keyed by (`hermie:<namespace>:`
   * in `localStorage`, the row namespace in IndexedDB). The prefix, or `/`
   * when there is none; it never holds a colon, which the cache keys split on.
   */
  namespace: string
}

export interface MisconfiguredBasePath {
  ok: false
  /** The path the page should have been served at, for the error screen. */
  expected: string
  /** The path it was served at. */
  pathname: string
}

export type BasePath = ResolvedBasePath | MisconfiguredBasePath

/** The storage namespace of a prefix: see `ResolvedBasePath.namespace`. */
export const storageNamespace = (prefix: string): string => (prefix === '' ? '/' : prefix.replaceAll(':', '%3A'))

/**
 * Derive the gateway from a location. `origin` and `pathname` are what
 * `window.location` has; the pathname is used as the browser gives it
 * (percent-encoded), because it goes back into URLs.
 */
export function deriveBasePath(location: { origin: string; pathname: string }): BasePath {
  const { origin, pathname } = location
  const suffix = SUFFIXES.find(candidate => pathname.endsWith(candidate))

  // An opaque origin (`null`, a `file:` page) has no gateway behind it.
  const usableOrigin = /^https?:\/\/[^/]+$/u.test(origin)

  if (!suffix || !usableOrigin) {
    return { ok: false, expected: APP_DOCUMENT_PATH, pathname }
  }

  const prefix = pathname.slice(0, pathname.length - suffix.length).replace(/\/+$/u, '')

  // `//host/...` in a prefix would read as another host to anything that
  // builds a URL from it; a gateway is never published like that.
  if (prefix.startsWith('//')) {
    return { ok: false, expected: APP_DOCUMENT_PATH, pathname }
  }

  return {
    ok: true,
    prefix,
    baseUrl: `${origin}${prefix}`,
    appPath: pathname,
    namespace: storageNamespace(prefix)
  }
}

/** `deriveBasePath` of the page's own location. */
export const pageBasePath = (): BasePath => deriveBasePath(window.location)
