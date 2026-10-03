/**
 * What a message may link to and load.
 *
 * Message text is written by an agent (and by whatever the agent read), so
 * every URL in it is untrusted. These are the only two decisions the renderer
 * takes about one, and both are allow-lists: a link leaves the page through
 * `http:`, `https:` or `mailto:` and nothing else, and an image loads only from
 * the gateway's own origin. Everything else is shown as text.
 *
 * Ported from the Expo app's `isOpenableLink` and `resolveImageUri`
 * (`expo/hermie/src/markdown/context.ts`), tightened for a browser: `tel:` is
 * not on the list (a desktop browser has nothing to dial with), and an image
 * is checked against the gateway's origin instead of being handed to the
 * network as written.
 */

/** Where a link opens. */
export const LINK_TARGET = '_blank'

/** Without `noopener` the destination can reach back through `window.opener`; without `noreferrer` it learns the page's URL. */
export const LINK_REL = 'noopener noreferrer'

const OPENABLE = /^(https?|mailto):/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Whether a link in a message may be an anchor. The test is anchored at the
 * first character on purpose: ` javascript:x`, `java\tscript:x` and
 * `JAVASCRIPT:x` all fail it, and nothing that passes it can mean anything but
 * the scheme it spells.
 */
export function isOpenableLink(href: string): boolean {
  return OPENABLE.test(href)
}

/**
 * The `href` to put on an anchor, or `null` when the link is to be shown as
 * text. An `http(s)` address that the URL parser rejects is text as well, so
 * what reaches the DOM is always an address the browser reads the same way.
 */
export function openableHref(href: string): string | null {
  if (!isOpenableLink(href)) {
    return null
  }

  if (/^mailto:/i.test(href)) {
    return href
  }

  const parsed = parseUrl(href)

  return parsed && isWebUrl(parsed) ? parsed.href : null
}

/** What to draw for an image in a message. */
export type ImageSource =
  /** On the gateway's own origin: an `<img>` with this `src`. */
  | { kind: 'image'; src: string }
  /** Somewhere else on the web: a link, with the alt text as its label. Nothing is requested. */
  | { kind: 'link'; href: string }
  /** Not something that can be fetched: the alt text alone. */
  | { kind: 'text' }

function parseUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** Whether a path that is joined onto the base can only descend: no backslash, no `.` or `..` segment (encoded or not). */
function isPlainPath(path: string): boolean {
  if (path.includes('\\')) {
    return false
  }

  return path
    .split(/[?#]/u, 1)[0]!
    .split('/')
    .every(segment => {
      let decoded = segment

      try {
        decoded = decodeURIComponent(segment)
      } catch {
        return false
      }

      return decoded !== '.' && decoded !== '..' && !decoded.includes('\\') && !decoded.includes('/')
    })
}

/** Whether `path` is `base` or a path below it (`/hermes/a` is under `/hermes`; `/hermesx` is not). */
function isUnder(path: string, base: string): boolean {
  const root = base.replace(/\/+$/u, '')

  return path === root || path.startsWith(`${root}/`)
}

const isWebUrl = (url: URL): boolean => url.protocol === 'http:' || url.protocol === 'https:'

/**
 * Decide how an image `src` is drawn.
 *
 * A gateway writes its attachments into replies as `/api/...`, a path and not
 * a URL, so a path is joined onto the gateway's base URL exactly as the Expo
 * app does (the base may carry a prefix, `https://host/prefix`, that a rooted
 * path stays under). A URL with a scheme or a protocol-relative one is checked
 * against the base's origin. The result is an `<img>` only when it lands there
 * and stays under the base's path (so behind a prefix proxy, `../` cannot climb
 * out of the prefix to another service on the same origin, which would be asked
 * with the reader's cookie): a remote image is a request the reader did not
 * make, to a host the agent chose, carrying the page's address in the `Referer`.
 * A path is never allowed to hold a backslash or a dot segment, however it is
 * spelled; no attachment path has either.
 *
 * With no base URL a path has nothing to resolve against and comes back as
 * text; so does anything that is not `http(s)`, `data:` included.
 */
export function resolveImage(href: string, baseUrl?: string): ImageSource {
  const source = href.trim()

  if (!source) {
    return { kind: 'text' }
  }

  const base = baseUrl ? parseUrl(baseUrl) : null
  const gateway = base && isWebUrl(base) ? base : null

  let url: URL | null

  if (HAS_SCHEME.test(source)) {
    url = parseUrl(source)
  } else if (source.startsWith('//')) {
    url = parseUrl(`${gateway?.protocol ?? 'https:'}${source}`)
  } else if (gateway && baseUrl) {
    if (!isPlainPath(source)) {
      return { kind: 'text' }
    }

    url = parseUrl(`${baseUrl.replace(/\/+$/, '')}/${source.replace(/^\/+/, '')}`)
  } else {
    return { kind: 'text' }
  }

  if (!url || !isWebUrl(url)) {
    return { kind: 'text' }
  }

  if (gateway && url.origin === gateway.origin) {
    // The gateway's own origin, but below the base's path or not at all: another service behind the same host.
    if (!isUnder(url.pathname, gateway.pathname)) {
      return { kind: 'text' }
    }

    // A URL with credentials in it is never loaded, same origin or not.
    if (!url.username && !url.password) {
      return { kind: 'image', src: url.href }
    }
  }

  return { kind: 'link', href: url.href }
}
