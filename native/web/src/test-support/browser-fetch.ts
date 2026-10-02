/**
 * Node's `fetch` with the one browser behaviour the cookie session depends on:
 * a cookie jar for the page's origin.
 *
 * A browser stores what `Set-Cookie` says (an `HttpOnly` cookie included; the
 * page just cannot read it) and attaches it to every request to that origin
 * whose `credentials` mode allows it. `same-origin`, the client's mode and the
 * Fetch default, sends it only to the page's own origin; `omit` never does.
 * Node's `fetch` has no jar, so without this the integration test could not
 * tell a client that rides the session from one that does not.
 *
 * Deliberately small: one origin, name and value only, `Max-Age=0` deletes.
 * Paths, expiry dates and `Secure` are not modelled (the fake sets `Path=/` and
 * runs over plain HTTP).
 */
import type { FetchLike } from '@hermie/gateway-client'

export interface BrowserFetch {
  fetch: FetchLike
  /** The jar, by cookie name. The client never sees this; the test may. */
  cookies: Map<string, string>
  /** `credentials` mode of every request, in order. */
  modes: (RequestCredentials | undefined)[]
}

export function browserFetch(pageOrigin: string): BrowserFetch {
  const cookies = new Map<string, string>()
  const modes: (RequestCredentials | undefined)[] = []

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const mode = init.credentials ?? 'same-origin'
    const sameOrigin = url.origin === pageOrigin
    const attach = mode === 'include' || (mode === 'same-origin' && sameOrigin)
    const headers = new Headers(init.headers)

    modes.push(init.credentials)

    if (attach && cookies.size > 0) {
      headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    }

    const response = await globalThis.fetch(url, { ...init, headers })

    if (attach) {
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';').map(part => part.trim())
        const at = pair.indexOf('=')
        const name = pair.slice(0, at)
        const value = pair.slice(at + 1)
        const expired = attributes.some(attribute => /^max-age=0$/iu.test(attribute))

        if (expired || value === '') {
          cookies.delete(name)
        } else {
          cookies.set(name, value)
        }
      }
    }

    return response
  }

  return { fetch, cookies, modes }
}
