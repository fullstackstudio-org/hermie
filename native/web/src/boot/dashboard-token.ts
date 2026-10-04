/**
 * The session token of a gateway without sign-in, read from the dashboard's own
 * bootstrap (plan W5, W-23).
 *
 * An ungated gateway authenticates every `/api/*` call with one shared session
 * token, and hands it to the pages it serves by writing it into the dashboard's
 * `index.html`: `window.__HERMES_SESSION_TOKEN__="<token>";`
 * (`web_server_dashboard.py::_serve_index`). This client is served by the same
 * gateway on the same origin, so it does what the dashboard does: it fetches
 * `{prefix}/` and reads the value out of the page's text. Nothing in that page
 * is run, and nothing else is read from it.
 *
 * Said plainly, because it is the whole security story of this mode: **this
 * reads the dashboard's own bootstrap, and the token is exactly as public as the
 * dashboard on that gateway.** Whoever can open the dashboard there can read it;
 * the client adds no exposure and no protection of its own. A gateway that wants
 * the token to stay with one person has to put sign-in (or a proxy) in front of
 * the dashboard, and then this path is not taken at all: a gated gateway writes
 * no token into the page.
 *
 * The read is strict, so a page that is not the bootstrap we know gives nothing
 * rather than something:
 *
 *  - same origin (`{prefix}/` under the page's own base URL), `cache: 'no-store'`
 *    (the page is never kept by the browser's HTTP cache), the same-origin
 *    credentials mode, and no redirect followed (`redirect: 'error'`): a gated
 *    gateway's `302 /login` is a failure here, not a page to read;
 *  - a 200 with an HTML content type, at most `MAX_PAGE_CHARS` long;
 *  - the value is a double-quoted string of URL-safe characters (RFC 3986's
 *    unreserved set: letters, digits, `-`, `.`, `_`, `~`), 1 to `MAX_TOKEN_LENGTH`
 *    long, followed by `;`. `secrets.token_urlsafe` gives exactly that alphabet. An
 *    escape, a quote of another kind, an expression or anything else is refused;
 *  - every assignment on the page is such a string, and they all say the same;
 *  - a page that says `window.__HERMES_AUTH_REQUIRED__=true` carries no token
 *    this client may use, whatever else it says.
 *
 * Anything else is `null`, and the caller asks the person for the token instead
 * (`features/shell/TokenPrompt.tsx`). The value goes from here into
 * `SessionTokenCredentials` and nowhere else: never a store, a log line, an
 * error message or a URL other than the socket's `?token=` (plan, "Token
 * storage"). Nothing here logs, and no error carries the page's text.
 */
import type { FetchLike } from '@hermie/gateway-client'

/** The longest token this client takes from the page. `token_urlsafe(32)` is 43 characters. */
export const MAX_TOKEN_LENGTH = 512

/** The longest page read: the dashboard's `index.html` is a few kilobytes. */
export const MAX_PAGE_CHARS = 1_000_000

/** How long the read may take before it counts as a failure. */
export const DASHBOARD_TOKEN_TIMEOUT_MS = 10_000

/** Any assignment to the global, whatever its value: what the strict pattern must account for. */
const ANY_ASSIGNMENT = /\bwindow\.__HERMES_SESSION_TOKEN__\s*=(?!=)/gu

/** The one form taken: a double-quoted string of URL-safe characters, then `;`. */
const STRICT_ASSIGNMENT = new RegExp(
  String.raw`\bwindow\.__HERMES_SESSION_TOKEN__\s*=\s*"([A-Za-z0-9._~-]{1,${MAX_TOKEN_LENGTH}})"\s*;`,
  'gu'
)

/** The bootstrap of a gated gateway. */
const AUTH_REQUIRED = /\bwindow\.__HERMES_AUTH_REQUIRED__\s*=\s*true\b/u

/**
 * The token in a dashboard page's text, or `null` when the page carries none
 * this client may use (see the rules above).
 */
export function extractDashboardToken(page: string): string | null {
  if (page.length > MAX_PAGE_CHARS || AUTH_REQUIRED.test(page)) {
    return null
  }

  const assignments = page.match(ANY_ASSIGNMENT)?.length ?? 0
  const values = Array.from(page.matchAll(STRICT_ASSIGNMENT), match => match[1] ?? '')

  if (assignments === 0 || values.length !== assignments) {
    return null
  }

  const [first] = values

  return first && values.every(value => value === first) ? first : null
}

/** `{baseUrl}/`: the dashboard's own index under the gateway's prefix. */
export const dashboardIndexUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/u, '')}/`

const isHtml = (response: Response): boolean => /^text\/html\b/iu.test(response.headers.get('content-type') ?? '')

/**
 * Fetch the dashboard's index at `{baseUrl}/` and read the token out of it.
 * Never throws: a failed request, a refusal, a redirect, a page of another kind
 * or a malformed value are all `null`.
 */
export async function readDashboardToken(
  baseUrl: string,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  timeoutMs = DASHBOARD_TOKEN_TIMEOUT_MS
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(dashboardIndexUrl(baseUrl), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { accept: 'text/html' },
      signal: controller.signal
    })

    if (response.status !== 200 || response.redirected || !isHtml(response)) {
      return null
    }

    return extractDashboardToken(await response.text())
  } catch {
    // Offline, refused, a redirect (`redirect: 'error'`), a timeout: no token from the page.
    return null
  } finally {
    clearTimeout(timer)
  }
}
