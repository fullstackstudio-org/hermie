/**
 * The entry module, imported the way the browser runs it: once per page, with
 * whatever window it finds. Each case gets a fresh module graph and a fresh
 * `#root`, and the gateway is a fake `fetch`.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeFetch, gatedRoutes, json, meRoute, ungatedRoutes, type Route } from './test-support/fake-fetch'
import { WEB_STRINGS_SOURCE } from './i18n/web-strings'
import type * as LoginBounceModule from './boot/login-bounce'
import type * as SessionModule from './features/shell/session'

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

      await vi.waitFor(() =>
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

    await vi.waitFor(() => expect(order).toEqual(['session stopped', 'signed out']))
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
