/**
 * The entry module, imported the way the browser runs it: once per page, with
 * whatever window it finds. Each case gets a fresh module graph and a fresh
 * `#root`, and the gateway is a fake `fetch`.
 */
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeFetch, gatedRoutes, json, meRoute, ungatedRoutes, type Route } from './test-support/fake-fetch'
import { WEB_STRINGS_SOURCE } from './i18n/web-strings'

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

  it('says a session-token gateway is for the native app', async () => {
    await load(APP_PATH, ungatedRoutes)

    expect(await screen.findByRole('heading', { name: 'This gateway cannot be used from a browser' })).toBeTruthy()
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

  it('says what failed when the gateway cannot be reached, with a way to try again', async () => {
    window.history.replaceState(null, '', APP_PATH)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))

    await import('./main')

    expect((await screen.findByRole('alert')).textContent).toContain(window.location.host)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
