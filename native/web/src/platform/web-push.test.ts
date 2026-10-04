/**
 * The browser seam's one rule about messages: a click is taken only from this
 * client's own service worker, never from another worker of the origin or from a
 * script that posts a look-alike.
 */
import { describe, expect, it, vi } from 'vitest'

import type { PushWindow } from '../core/push/platform'
import { createPushBrowser, isWorkerAt } from './web-push'

const APP = 'https://gw.example.test/dashboard-plugins/hermie/app/'
const OURS = `${APP}sw.js`

class FakeWorker {
  constructor(readonly scriptURL: string) {}
}

function pageWithWorkers() {
  let handler: ((event: { data: unknown; source: unknown }) => void) | undefined
  const container = {
    addEventListener: vi.fn((_type: string, listener: typeof handler) => {
      handler = listener
    }),
    removeEventListener: vi.fn(),
    startMessages: vi.fn()
  }
  const page = {
    isSecureContext: true,
    navigator: { userAgent: 'Chrome/140', maxTouchPoints: 0, serviceWorker: container },
    document: { baseURI: `${APP}index.html#/chat/scout` },
    ServiceWorker: FakeWorker
  } as unknown as PushWindow

  return { page, post: (event: { data: unknown; source: unknown }) => handler?.(event) }
}

describe('messages from the worker', () => {
  it('are taken only from the worker at the client’s own ./sw.js', () => {
    const { page, post } = pageWithWorkers()
    const heard = vi.fn()

    createPushBrowser(page).onMessage(heard)

    post({ data: 'ours', source: new FakeWorker(OURS) })
    // Another worker of the same origin: the dashboard's, another plugin's.
    post({ data: 'theirs', source: new FakeWorker('https://gw.example.test/dashboard-plugins/other/sw.js') })
    // A look-alike that is not a ServiceWorker at all, and a message with no source (a script's own dispatch).
    post({ data: 'forged', source: { scriptURL: OURS } })
    post({ data: 'sourceless', source: null })

    expect(heard.mock.calls).toEqual([['ours']])
  })

  it('compares the script’s address, prefix and all', () => {
    expect(isWorkerAt(new FakeWorker(OURS), OURS, { ServiceWorker: FakeWorker as never })).toBe(true)
    expect(isWorkerAt(new FakeWorker(`${APP}sw.js?v=2`), OURS, { ServiceWorker: FakeWorker as never })).toBe(false)
    expect(isWorkerAt(undefined, OURS, {})).toBe(false)
  })
})
