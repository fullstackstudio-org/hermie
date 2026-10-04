/**
 * The entry module, imported the way the browser runs it: once per page, with
 * whatever window it finds. Each case gets a fresh module graph and a fresh
 * `#root`, and the gateway is a fake `fetch`.
 */
import { configure, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeFetch, gatedRoutes, json, meRoute, ungatedRoutes, type Route } from './test-support/fake-fetch'
import { WEB_STRINGS_SOURCE } from './i18n/web-strings'
import type * as LoginBounceModule from './boot/login-bounce'
import type * as SessionModule from './features/shell/session'

// The entry module boots the whole app; on a loaded CI runner that takes longer than the one-second
// default of the async helpers.
configure({ asyncUtilTimeout: 5000 })
const waitLong = <T,>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 5000 })

const APP_PATH = '/dashboard-plugins/hermie/app/index.html'

let topDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  vi.resetModules()
  topDescriptor = Object.getOwnPropertyDescriptor(window, 'top')
  const root = document.createElement('div')
  root.id = 'root'
  document.body.replaceChildren(root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('./features/shell/session')
  vi.doUnmock('./boot/login-bounce')

  if (topDescriptor) {
    Object.defineProperty(window, 'top', topDescriptor)
  }

  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

/** Load the entry module on `pathname`, against a gateway that answers `routes`. */
async function load(pathname: string, routes: Record<string, Route>) {
  window.history.replaceState(null, '', pathname)
  const gateway = fakeFetch(routes)
  vi.stubGlobal('fetch', gateway.fetch)

  await import('./main')

  return gateway
}

describe('the entry module', () => {
  it('in a frame, shows one sentence and does nothing else: no request, no app', async () => {
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) })

    const gateway = await load(APP_PATH, { ...gatedRoutes, 'GET /api/auth/me': meRoute })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(document.body.textContent).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.en)
    expect(document.getElementById('root')).toBeNull()
    expect(gateway.calls).toEqual([])
  })

  it('names the path it expected when it is served from anywhere else, and asks nothing of a gateway', async () => {
    const gateway = await load('/somewhere/else.html', gatedRoutes)

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      WEB_STRINGS_SOURCE.basePath.misconfigured.en({ expected: APP_PATH })
    )
    expect(gateway.calls).toEqual([])
  })

  describe('on a gateway without sign-in', () => {
    const TOKEN = 'tok-Abc_123'
    const dashboard =
      (token: string | null): Route =>
      () =>
        new Response(
          `<!doctype html><html><head><script>${token === null ? '' : `window.__HERMES_SESSION_TOKEN__="${token}";`}` +
            'window.__HERMES_AUTH_REQUIRED__=false;</script></head><body></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
    const profiles: Route = call =>
      call.headers['x-hermes-session-token'] === TOKEN
        ? json(200, { profiles: [] })
        : json(401, { detail: 'Unauthorized' })

    it('reads the token from the dashboard’s bootstrap and opens the app, naming nobody', async () => {
      const gateway = await load(`${APP_PATH}#/chat/researcher`, {
        ...ungatedRoutes,
        'GET /': dashboard(TOKEN),
        'GET /api/profiles': profiles
      })

      expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Forget the token' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()

      const paths = gateway.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)

      expect(paths.slice(0, 3)).toEqual(['GET /api/status', 'GET /', 'GET /api/profiles'])
      expect(paths).not.toContain('GET /api/auth/me')
      // The token is in no address the page asked for.
      expect(gateway.calls.some(call => call.url.includes(TOKEN))).toBe(false)
      // And in no storage of the page.
      expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN)
      expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN)
    })

    it('asks for the token when the bootstrap has none: a wrong one is said once, the right one opens the app', async () => {
      await load(APP_PATH, { ...ungatedRoutes, 'GET /': dashboard(null), 'GET /api/profiles': profiles })

      const field = (await screen.findByLabelText('Session token', { selector: 'input' })) as HTMLInputElement

      expect(screen.getByText(/could not read the token from this gateway’s own dashboard page/u)).toBeTruthy()

      field.value = 'wrong'
      fireEvent.input(field)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

      await waitLong(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          'The gateway did not accept this token. Check it and try again.'
        )
      )

      field.value = TOKEN
      fireEvent.input(field)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

      expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()
    })

    it('forgets the token by stopping the session first, then asks for it again', async () => {
      const order: string[] = []

      vi.doMock('./features/shell/session', async importOriginal => {
        const real = await importOriginal<typeof SessionModule>()

        return {
          ...real,
          startSession: (options: Parameters<typeof real.startSession>[0]) => {
            const session = real.startSession(options)
            const stop = session.stop.bind(session)

            return {
              ...session,
              stop: () => {
                order.push('session stopped')
                stop()
              }
            }
          }
        }
      })
      vi.doMock('./boot/login-bounce', async importOriginal => {
        const real = await importOriginal<typeof LoginBounceModule>()

        return {
          ...real,
          forgetToken: async (options: Parameters<typeof real.forgetToken>[0]) => {
            await real.forgetToken(options)
            order.push('forgotten')
          }
        }
      })

      await load(APP_PATH, { ...ungatedRoutes, 'GET /': dashboard(TOKEN), 'GET /api/profiles': profiles })
      fireEvent.click(await screen.findByRole('button', { name: 'Forget the token' }))

      expect(await screen.findByText(/Hermie has forgotten the token/u)).toBeTruthy()
      expect(order).toEqual(['session stopped', 'forgotten'])
      expect(screen.getByLabelText('Session token', { selector: 'input' })).toBeTruthy()
    })

    it('tells the other tabs when the token is forgotten, and nothing more than that', async () => {
      const heard: unknown[] = []
      const otherTab = new BroadcastChannel('hermie:/:session')

      otherTab.onmessage = event => heard.push(event.data)

      try {
        await load(APP_PATH, { ...ungatedRoutes, 'GET /': dashboard(TOKEN), 'GET /api/profiles': profiles })
        fireEvent.click(await screen.findByRole('button', { name: 'Forget the token' }))

        await waitLong(() => expect(heard).toEqual([{ type: 'forget' }]))
      } finally {
        otherTab.close()
      }
    })

    it('stops and asks for the token when another tab forgot it, and clears what this one wrote', async () => {
      const otherTab = new BroadcastChannel('hermie:/:session')

      try {
        await load(APP_PATH, { ...ungatedRoutes, 'GET /': dashboard(TOKEN), 'GET /api/profiles': profiles })
        expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()
        window.localStorage.setItem('hermie:/:watermarks', '{"researcher":3}')

        otherTab.postMessage({ type: 'forget' })

        expect(await screen.findByText(/Hermie has forgotten the token/u)).toBeTruthy()
        expect(screen.queryByText('No sign-in on this gateway')).toBeNull()
        expect(window.localStorage.getItem('hermie:/:watermarks')).toBeNull()
      } finally {
        otherTab.close()
        window.localStorage.clear()
      }
    })

    describe('when the gateway refuses the token while the page is open', () => {
      /** A gateway whose dashboard and check follow `current.token`, as a restarted gateway's do. */
      const restartable = (current: { token: string }) => ({
        ...ungatedRoutes,
        'GET /': (call: Parameters<Route>[0]) => dashboard(current.token)(call),
        'GET /api/profiles': (call: Parameters<Route>[0]) =>
          call.headers['x-hermes-session-token'] === current.token
            ? json(200, { profiles: [] })
            : json(401, { detail: 'Unauthorized' })
      })

      const refuse = async () => {
        const { connectionStore } = await import('./state/connection')

        connectionStore.getState().setStatus('needs_signin', null)
      }

      it('reads the new token from the dashboard by itself, once, and starts over on it', async () => {
        const current = { token: TOKEN }
        const gateway = await load(APP_PATH, restartable(current))

        expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()

        current.token = 'tok-after-restart'
        await refuse()

        await waitLong(() =>
          expect(
            gateway.calls.some(
              call =>
                new URL(call.url).pathname === '/api/profiles' &&
                call.headers['x-hermes-session-token'] === 'tok-after-restart'
            )
          ).toBe(true)
        )
        expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()
        expect(gateway.calls.filter(call => new URL(call.url).pathname === '/')).toHaveLength(2)
      })

      it('leaves the line and its button when the dashboard still has the same token', async () => {
        const gateway = await load(APP_PATH, restartable({ token: TOKEN }))

        expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()
        await refuse()

        expect(await screen.findByRole('button', { name: 'Read it from the dashboard again' })).toBeTruthy()
        await waitLong(() => expect(gateway.calls.filter(call => new URL(call.url).pathname === '/')).toHaveLength(2))
        // The same token is not checked again, and the app was not restarted.
        expect(gateway.calls.filter(call => new URL(call.url).pathname === '/api/profiles')).toHaveLength(1)
      })

      it('goes to the gateway’s sign-in when the gateway turned sign-in on meanwhile', async () => {
        const routes: Record<string, Route> = { ...restartable({ token: TOKEN }) }

        await load(APP_PATH, routes)
        expect(await screen.findByText('No sign-in on this gateway')).toBeTruthy()

        Object.assign(routes, gatedRoutes, { 'GET /api/auth/me': () => json(401, {}) })
        await refuse()

        expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeTruthy()
      })
    })

    it('says a failure to start on a typed token on the prompt, instead of checking forever', async () => {
      vi.doMock('./features/shell/session', async importOriginal => ({
        ...(await importOriginal<typeof SessionModule>()),
        startSession: () => {
          throw new Error('boom')
        }
      }))

      await load(APP_PATH, { ...ungatedRoutes, 'GET /': dashboard(null), 'GET /api/profiles': profiles })

      const field = (await screen.findByLabelText('Session token', { selector: 'input' })) as HTMLInputElement

      field.value = TOKEN
      fireEvent.input(field)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

      await waitLong(() => expect(screen.getByRole('alert').textContent).toBe('Something went wrong.'))
      expect(screen.getByRole('status').textContent).toBe('')
    })
  })

  it('stops and says signed out when another tab signed out, and tells the other tabs when this one does', async () => {
    const heard: unknown[] = []
    const otherTab = new BroadcastChannel('hermie:/:session')

    otherTab.onmessage = event => heard.push(event.data)

    try {
      await load(APP_PATH, { ...gatedRoutes, 'GET /api/auth/me': meRoute })
      expect(await screen.findByText('Signed in as Tester')).toBeTruthy()

      otherTab.postMessage({ type: 'forget' })

      expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
      expect(heard).toEqual([])
    } finally {
      otherTab.close()
    }
  })

  it('offers to sign in again when the session has lapsed', async () => {
    await load(APP_PATH, {
      ...gatedRoutes,
      'GET /api/auth/me': () => json(401, { error: 'session_expired', login_url: '/login' })
    })

    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Signed out' })).toBeTruthy()
  })

  it('shows who is signed in', async () => {
    await load(`${APP_PATH}#/chat/researcher`, { ...gatedRoutes, 'GET /api/auth/me': meRoute })

    expect(await screen.findByText('Signed in as Tester')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(window.location.hash).toBe('#/chat/researcher')
  })

  it('mounts the app: the chat list, the connection, and the route the address names', async () => {
    await load(`${APP_PATH}#/chat/researcher`, { ...gatedRoutes, 'GET /api/auth/me': meRoute })

    expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeTruthy()
    expect(screen.getByRole('main')).toBeTruthy()
    // The page's own address is the router's: the heading is the route's.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('researcher')
    // The session was started: the connection is the page's, and says what it is doing, in
    // the connection line above the panes and again in the chat's header.
    expect((await screen.findAllByText(/Connecting…|Reconnecting…|Offline/)).length).toBeGreaterThan(0)
  })

  it('applies a stored colour scheme before the first screen', async () => {
    window.localStorage.setItem(`hermie:/:device.scheme`, 'dark')
    window.localStorage.setItem(`hermie:/:device.tint`, 'teal')

    try {
      await load(APP_PATH, { ...gatedRoutes, 'GET /api/auth/me': meRoute })

      expect(document.documentElement.getAttribute('data-scheme')).toBe('dark')
      expect(document.documentElement.getAttribute('data-tint')).toBe('teal')
    } finally {
      window.localStorage.clear()
      document.documentElement.removeAttribute('data-scheme')
      document.documentElement.removeAttribute('data-tint')
    }
  })

  it('signs out by stopping the session first and only then ending the gateway’s', async () => {
    const order: string[] = []

    // jsdom cannot navigate, which the real sign-out ends with; its own tests cover that.
    vi.doMock('./features/shell/session', async importOriginal => {
      const real = await importOriginal<typeof SessionModule>()

      return {
        ...real,
        startSession: (options: Parameters<typeof real.startSession>[0]) => {
          const session = real.startSession(options)
          const stop = session.stop.bind(session)

          return {
            ...session,
            stop: () => {
              order.push('session stopped')
              stop()
            }
          }
        }
      }
    })
    vi.doMock('./boot/login-bounce', async importOriginal => ({
      ...(await importOriginal<typeof LoginBounceModule>()),
      signOut: async () => void order.push('signed out')
    }))

    await load(APP_PATH, { ...gatedRoutes, 'GET /api/auth/me': meRoute })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    await waitLong(() => expect(order).toEqual(['session stopped', 'signed out']))
    expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says what failed when the gateway cannot be reached, with a way to try again', async () => {
    window.history.replaceState(null, '', APP_PATH)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))

    await import('./main')

    expect((await screen.findByRole('alert')).textContent).toContain(window.location.host)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
