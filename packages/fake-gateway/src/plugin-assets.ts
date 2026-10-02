import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep, extname } from 'node:path'

/**
 * The dashboard's static route for a plugin, and the pages that sit around it.
 *
 * `GET /dashboard-plugins/{plugin_name}/{file_path:path}` is
 * `hermes_cli/web_routers/dashboard_ui.py::serve_plugin_asset`. The semantics
 * here are copied from it rather than improved, because the reason to serve a
 * built client from the fake is to meet the route's limits before a gateway does:
 * no SPA fallback, a directory is a 404, a suffix outside the allow-list is a
 * 404 whatever the file, and every answer is `no-store`.
 */

/** `_PLUGIN_ASSET_CONTENT_TYPES`, verbatim. Everything else is a 404 so a plugin's `.py` never leaks. */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json'
}

/** The one header the route sets besides the type and the length. */
export const PLUGIN_ASSET_CACHE_CONTROL = 'no-store, no-cache, must-revalidate'

export type PluginAssetAnswer =
  { status: 200; contentType: string; body: Buffer } | { status: 403 | 404; detail: string }

/**
 * Whether `target` is `base` or sits under it, as `Path.is_relative_to` says.
 *
 * `relative()` answers `..` or `../x` for an escape; a file whose own name starts
 * with two dots (`..hidden`) is inside and must not be mistaken for one.
 */
function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)

  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** `Path.resolve()`: follow symlinks as far as the path exists, then normalise the rest. */
function resolveLoosely(path: string): string {
  const absolute = resolve(path)

  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * One file out of the plugin's dashboard directory, by the route's rules.
 *
 * `filePath` is already percent-decoded, which is what an ASGI server hands the
 * route: `..%2F` therefore arrives as `../`, and an absolute `filePath` replaces
 * the base the way `Path(base) / "/etc/passwd"` does. Both end up outside the
 * base and are refused with 403, which is a different answer from a missing
 * file and is the one a test for a traversal looks for.
 */
export function readPluginAsset(root: string, filePath: string): PluginAssetAnswer {
  if (filePath.includes('\0')) {
    return { status: 404, detail: 'File not found' }
  }

  const base = resolveLoosely(root)
  const target = resolveLoosely(resolve(base, filePath))

  if (!isInside(base, target)) {
    return { status: 403, detail: 'Path traversal blocked' }
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    return { status: 404, detail: 'File not found' }
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()]

  if (type === undefined) {
    return { status: 404, detail: 'File not found' }
  }

  return {
    status: 200,
    // Starlette appends the charset to every `text/*` type and to nothing else.
    contentType: type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    body: readFileSync(target)
  }
}

const NEXT_DENY_PREFIXES = ['/login', '/auth/', '/api/auth/']

/**
 * `request_utils.is_safe_next_path`: a same-origin path that is not protocol
 * relative, not one of the auth routes, and not under `/api`.
 */
export function isSafeNextPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }

  if (NEXT_DENY_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix))) {
    return false
  }

  return !(path === '/api' || path.startsWith('/api/'))
}

/** Python's `urllib.parse.quote(value, safe="")`: everything but letters, digits and `_.-~`. */
export function quoteComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Where an unauthenticated request is sent to sign in, as
 * `middleware._unauth_response` builds it: `/login?next=<path and query>` when
 * the path may be returned to, bare `/login` otherwise. Every `/api` path is
 * the "otherwise", which is why the JSON 401 an API call gets names no `next`.
 */
export function loginUrlFor(pathname: string, search: string): string {
  if (!pathname || !isSafeNextPath(pathname)) {
    return '/login'
  }

  const query = search.startsWith('?') ? search.slice(1) : search

  return `/login?next=${quoteComponent(query ? `${pathname}?${query}` : pathname)}`
}

/**
 * The gateway's own sign-in page in cookie mode.
 *
 * A form that posts to `/auth/password-login` and then goes where `next` says,
 * when `next` is a same-origin path the gateway itself would accept (the same
 * rule as `isSafeNextPath`, restated in the page because it runs in a browser).
 * Anything else lands on `/`. The page is the thing a client's sign-in bounce
 * returns from, so it has to behave like the one it stands in for: sign in,
 * then leave.
 */
export const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<form id="f"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>
<p id="e" role="alert"></p>
<script>
const safe = path =>
  path.startsWith('/') && !path.startsWith('//') &&
  !['/login', '/auth/', '/api/auth/'].some(prefix => path === prefix || path.startsWith(prefix)) &&
  path !== '/api' && !path.startsWith('/api/')
const form = document.getElementById('f')
form.addEventListener('submit', async event => {
  event.preventDefault()
  const next = new URLSearchParams(location.search).get('next') || '/'
  const response = await fetch('/auth/password-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username: form.username.value, password: form.password.value, next })
  })
  if (response.ok) {
    location.assign(safe(next) ? next : '/')
  } else {
    document.getElementById('e').textContent = 'Invalid credentials'
  }
})
</script>`

/**
 * `GET /` on a gateway with a session token and no sign-in: the dashboard's
 * `index.html` with the token written into it, in the form `_serve_index` writes
 * it (`window.__HERMES_SESSION_TOKEN__="<token>";` first, then the other
 * bootstrap globals). This is how a page served from the gateway's own origin
 * learns the token it has to send. `</` is escaped so a hostile value cannot
 * close the script element.
 */
export function tokenIndexHtml(token: string): string {
  const quoted = JSON.stringify(token).replace(/<\//gu, '<\\/')

  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Hermes</title><script>' +
    `window.__HERMES_SESSION_TOKEN__=${quoted};` +
    'window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=false;' +
    'window.__HERMES_BASE_PATH__="";' +
    'window.__HERMES_AUTH_REQUIRED__=false;' +
    'window.__HERMES_INITIAL_PROFILE__="";' +
    'window.__HERMES_DASHBOARD_PROFILE__="";' +
    '</script></head><body><div id="root"></div></body></html>'
  )
}
