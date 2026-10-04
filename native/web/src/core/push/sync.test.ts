/**
 * The controller against a browser of our own making: turning Web Push on and
 * off, the launch check that keeps the subscription on the advert's key, the
 * sign-out, the test route, and clicks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createKeyValueStore } from '../../platform/key-value-store'
import type { WebPluginAdvert } from '../advert'
import { createPluginStore } from '../../state/plugin'
import { createPushStore } from '../../state/push'
import { PUSH_ACTION_ALLOW, PUSH_ACTION_DENY, PUSH_MESSAGE_SOURCE } from './actions'
import type { GatewayClock } from './clock'
import type {
  BrowserSubscription,
  PushBrowser,
  PushEnvironment,
  PushPermission,
  PushWorker,
  ShownNotificationHandle
} from './platform'
import { applicationServerKeyBytes, base64UrlOf } from './row'
import { PushSync, type PushTapPorts, PUSH_TEST_PATH } from './sync'

const KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'
const OTHER_KEY = base64UrlOf(
  (() => {
    const bytes = applicationServerKeyBytes(KEY) as Uint8Array

    bytes[20] = (bytes[20] as number) ^ 0x55

    return bytes
  })()
)

const BASE = 'https://gw.example.test'
const NOW_MS = 1_790_000_000_000

/** Let every promise the controller started settle. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

class FakeSubscription implements BrowserSubscription {
  readonly unsubscribe = vi.fn(async () => {
    this.browser.current = this.browser.current === this ? null : this.browser.current

    return true
  })

  constructor(
    private readonly browser: FakeBrowser,
    readonly endpoint: string,
    private readonly made: string,
    private readonly reports = true
  ) {}

  key(): string {
    return this.reports ? this.made : ''
  }

  json(): unknown {
    return { endpoint: this.endpoint, keys: { p256dh: `p256-${this.endpoint}`, auth: 'auth' } }
  }
}

class FakeBrowser implements PushBrowser {
  env: PushEnvironment = {
    secure: true,
    serviceWorker: true,
    pushManager: true,
    notification: true,
    ios: false,
    standalone: false,
    chromium: true
  }
  granted: PushPermission = 'default'
  /** What the prompt answers. */
  answer: PushPermission = 'granted'
  current: FakeSubscription | null = null
  readonly subscribed: string[] = []
  readonly asked = vi.fn()
  private minted = 0
  private readonly listeners = new Set<(data: unknown) => void>()
  readonly shown: ShownNotificationHandle[] = []

  readonly worker_: PushWorker = {
    getSubscription: async () => this.current,
    subscribe: async key => {
      const made = base64UrlOf(key)

      if (this.current && this.current.key() && this.current.key() !== made) {
        throw new DOMException(
          'A subscription with a different applicationServerKey already exists.',
          'InvalidStateError'
        )
      }

      this.subscribed.push(made)
      this.minted += 1
      this.current = new FakeSubscription(this, `https://push.example.test/${this.minted}`, made)

      return this.current
    },
    notifications: async () => this.shown
  }

  /** Stage a subscription the browser already holds. */
  holds(key: string, reports = true): FakeSubscription {
    this.minted += 1
    this.current = new FakeSubscription(this, `https://push.example.test/held-${this.minted}`, key, reports)

    return this.current
  }

  environment(): PushEnvironment {
    return this.env
  }

  permission(): PushPermission {
    return this.granted
  }

  async requestPermission(): Promise<PushPermission> {
    this.asked()

    if (this.granted === 'default') {
      this.granted = this.answer
    }

    return this.granted
  }

  async worker(): Promise<PushWorker> {
    return this.worker_
  }

  async existingWorker(): Promise<PushWorker | null> {
    return this.worker_
  }

  onMessage(listener: (data: unknown) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  post(data: unknown): void {
    for (const listener of this.listeners) {
      listener(data)
    }
  }
}

const advertWith = (publicKey: string | null, capabilities = ['push.webpush', 'push.webpush.key']): WebPluginAdvert =>
  ({
    v: 1,
    version: '0.13.0',
    capabilities: [...capabilities, 'push.test'],
    modules: { push: 'on' },
    limits: {},
    relayOrigins: [],
    web: null,
    webPush: publicKey ? { publicKey } : null
  }) as unknown as WebPluginAdvert

const clock: GatewayClock = { now: () => NOW_MS, measure: async () => undefined, offset: 0 }

interface Setup {
  browser?: FakeBrowser
  enabled?: boolean
  subscribedKey?: string
  advert?: WebPluginAdvert | null | 'unread'
  taps?: Partial<PushTapPorts>
  fetch?: typeof fetch
  now?: () => number
}

const running: PushSync[] = []

afterEach(() => {
  while (running.length) {
    running.pop()?.stop()
  }
})

function setup(options: Setup = {}) {
  const browser = options.browser ?? new FakeBrowser()
  const disk = createKeyValueStore({ namespace: 'test', storage: null })

  if (options.enabled) {
    disk.setSync(
      'push.settings',
      JSON.stringify({ enabled: true, types: {}, preview: false, subscribedKey: options.subscribedKey ?? '' })
    )
  }

  const store = createPushStore()

  store.getState().hydrate(disk)

  const plugin = createPluginStore()

  if (options.advert !== 'unread') {
    plugin.getState().apply(options.advert === undefined ? advertWith(KEY) : options.advert)
  }

  const taps: PushTapPorts = {
    show: vi.fn(() => true),
    attachedSession: vi.fn(async () => '8a1b2c3d'),
    openApprovals: vi.fn(async () => [{ request_id: 'appr-1', choices: ['once', 'session', 'deny'] }]),
    respondApproval: vi.fn(async () => undefined),
    ...options.taps
  }
  const sync = new PushSync({
    browser,
    store,
    plugin,
    clock: options.now ? { ...clock, now: options.now } : clock,
    baseUrl: BASE,
    headers: async () => ({ 'X-Test': 'yes' }),
    taps,
    ...(options.fetch ? { fetch: options.fetch } : {})
  })

  running.push(sync)

  return { browser, store, plugin, taps, sync }
}

describe('turning it on', () => {
  it('asks, subscribes with the advert’s key, and holds the address and a fresh stamp for the row', async () => {
    const { browser, store, sync } = setup()

    sync.start()
    await settle()
    await sync.enable()

    expect(browser.asked).toHaveBeenCalledTimes(1)
    expect(browser.subscribed).toEqual([KEY])
    expect(store.getState().enabled).toBe(true)
    expect(store.getState().address).toEqual({
      transport: 'webpush',
      endpoint: 'https://push.example.test/1',
      keys: { p256dh: 'p256-https://push.example.test/1', auth: 'auth' },
      applicationServerKey: KEY
    })
    expect(store.getState().updatedAt).toBe(NOW_MS / 1000)
    expect(store.getState().subscribedKey).toBe(KEY)
    // Every type on, for a reader who has just turned it on.
    expect(Object.values(store.getState().types).every(Boolean)).toBe(true)
  })

  it('subscribes afresh when the browser already holds a subscription, even one made with the same key', async () => {
    // Somebody else's, signed in on this browser before, or one whose row the plugin retired.
    const browser = new FakeBrowser()
    const old = browser.holds(KEY)
    const { store, sync } = setup({ browser })

    sync.start()
    await settle()
    await sync.enable()

    expect(old.unsubscribe).toHaveBeenCalledTimes(1)
    expect(browser.subscribed).toEqual([KEY])
    expect(store.getState().address?.endpoint).toBe('https://push.example.test/2')
  })

  it('asks for clearing pushes in a Chromium-based browser only', async () => {
    const chromium = setup()

    chromium.sync.start()
    expect(chromium.store.getState().clears).toBe(true)

    const other = new FakeBrowser()

    other.env = { ...other.env, chromium: false }

    const safari = setup({ browser: other })

    safari.sync.start()
    expect(safari.store.getState().clears).toBe(false)
  })

  it('stays off when the browser refuses', async () => {
    const browser = new FakeBrowser()

    browser.answer = 'denied'

    const { store, sync } = setup({ browser })

    sync.start()
    await sync.enable()

    expect(store.getState().enabled).toBe(false)
    expect(browser.subscribed).toEqual([])
  })

  it('does not ask at all where it cannot be offered', async () => {
    const { browser, store, sync } = setup({ advert: null })

    sync.start()
    await sync.enable()

    expect(browser.asked).not.toHaveBeenCalled()
    expect(store.getState().enabled).toBe(false)
  })

  it('keeps the browser’s words when subscribing fails', async () => {
    const browser = new FakeBrowser()

    browser.worker_.subscribe = async () => {
      throw new DOMException('Registration failed - push service error', 'AbortError')
    }

    const { store, sync } = setup({ browser })

    sync.start()
    await sync.enable()

    expect(store.getState().enabled).toBe(true)
    expect(store.getState().address).toBeNull()
    expect(store.getState().failure).toBe('Registration failed - push service error')
    expect(store.getState().busy).toBe(false)
  })
})

describe('the launch check', () => {
  it('keeps a subscription made with the advert’s key, and writes the row again with a fresh stamp', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'
    browser.holds(KEY)

    const { store, sync } = setup({ browser, enabled: true })

    expect(store.getState().phase).toBe('idle')

    sync.start()
    await settle()

    expect(browser.subscribed).toEqual([])
    expect(store.getState().address?.endpoint).toBe('https://push.example.test/held-1')
    expect(store.getState().updatedAt).toBe(NOW_MS / 1000)
    expect(store.getState().phase).toBe('settled')
  })

  it('unsubscribes a subscription made with another key and subscribes again with the advert’s', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'

    const old = browser.holds(OTHER_KEY)
    const { store, sync } = setup({ browser, enabled: true })

    sync.start()
    await settle()

    expect(old.unsubscribe).toHaveBeenCalledTimes(1)
    expect(browser.subscribed).toEqual([KEY])
    expect(store.getState().address?.endpoint).toBe('https://push.example.test/2')
    expect(store.getState().address?.applicationServerKey).toBe(KEY)
  })

  it('trusts the key it remembers for a browser that does not say, and replaces one it cannot tell', async () => {
    const remembered = new FakeBrowser()

    remembered.granted = 'granted'
    remembered.holds(KEY, false)

    const first = setup({ browser: remembered, enabled: true, subscribedKey: KEY })

    first.sync.start()
    await settle()
    expect(remembered.subscribed).toEqual([])

    const unknown = new FakeBrowser()

    unknown.granted = 'granted'
    unknown.holds(KEY, false)

    const second = setup({ browser: unknown, enabled: true })

    second.sync.start()
    await settle()
    expect(unknown.subscribed).toEqual([KEY])
  })

  it('subscribes again when the advert’s key changes while the page is open', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'
    browser.holds(KEY)

    const { plugin, store, sync } = setup({ browser, enabled: true })

    sync.start()
    await settle()
    expect(browser.subscribed).toEqual([])

    // The same advert read again changes nothing.
    plugin.getState().apply(advertWith(KEY))
    await settle()
    expect(browser.subscribed).toEqual([])

    plugin.getState().apply(advertWith(OTHER_KEY))
    await settle()
    expect(browser.subscribed).toEqual([OTHER_KEY])
    expect(store.getState().address?.applicationServerKey).toBe(OTHER_KEY)
  })

  it('waits for the advert before it checks anything', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'

    const { plugin, store, sync } = setup({ browser, enabled: true, advert: 'unread' })

    sync.start()
    await settle()
    expect(store.getState().phase).toBe('idle')
    expect(browser.subscribed).toEqual([])

    plugin.getState().apply(advertWith(KEY))
    await settle()
    expect(browser.subscribed).toEqual([KEY])
    expect(store.getState().phase).toBe('settled')
  })

  it('writes no row where the gateway cannot send, and says the check is done', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'

    const { store, sync } = setup({ browser, enabled: true, advert: advertWith(null, ['push.webpush']) })

    sync.start()
    await settle()

    expect(browser.subscribed).toEqual([])
    expect(store.getState().address).toBeNull()
    expect(store.getState().phase).toBe('settled')
  })

  it('turns the switch off when the permission was withdrawn in the browser', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'denied'
    browser.holds(KEY)

    const { store, sync } = setup({ browser, enabled: true })

    sync.start()
    await settle()

    expect(store.getState().enabled).toBe(false)
    expect(browser.subscribed).toEqual([])
  })

  it('writes the row again on the way back into view once it has not been written for a while', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'
    browser.holds(KEY)

    let now = NOW_MS
    const { store, sync } = setup({ browser, enabled: true, now: () => now })

    sync.start()
    await settle()
    expect(store.getState().updatedAt).toBe(NOW_MS / 1000)

    now = NOW_MS + 60_000
    sync.onVisible()
    await settle()
    expect(store.getState().updatedAt).toBe(NOW_MS / 1000)

    now = NOW_MS + 7 * 3_600_000
    sync.onVisible()
    await settle()
    expect(store.getState().updatedAt).toBe(now / 1000)
  })
})

describe('turning it off, registering again, and signing out', () => {
  const on = async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'

    const held = browser.holds(KEY)
    const context = setup({ browser, enabled: true })

    context.sync.start()
    await settle()

    return { ...context, held }
  }

  it('takes the row out and unsubscribes when switched off', async () => {
    const { held, store, sync } = await on()

    await sync.disable()

    expect(store.getState().enabled).toBe(false)
    expect(store.getState().address).toBeNull()
    expect(held.unsubscribe).toHaveBeenCalled()
  })

  it('subscribes afresh with the advert’s key on Register again, even when the key is the same', async () => {
    const { browser, held, store, sync } = await on()

    await sync.reregister()

    expect(held.unsubscribe).toHaveBeenCalled()
    expect(browser.subscribed).toEqual([KEY])
    expect(store.getState().address?.endpoint).toBe('https://push.example.test/2')
  })

  it('takes the row out of the write it sends, and lets the subscription go whatever becomes of that write', async () => {
    const { held, store, sync } = await on()
    const seen: string[] = []

    // A write that never lands: the gateway stopped answering.
    void sync.signOut(() => {
      seen.push(
        `flush enabled=${store.getState().enabled} address=${store.getState().address === null ? 'none' : 'set'}`
      )

      return new Promise<void>(() => {})
    })
    await settle()

    expect(seen).toEqual(['flush enabled=false address=none'])
    expect(held.unsubscribe).toHaveBeenCalledTimes(1)
    // The installation id stays: signing back in writes the same row, not a second one.
    expect(store.getState().installationId).toMatch(/^i[0-9a-f]{16}$/u)
  })

  it('lets a subscription go on sign-out even where the switch was off', async () => {
    const browser = new FakeBrowser()
    const held = browser.holds(KEY)
    const { sync } = setup({ browser })

    sync.start()
    await sync.signOut(async () => {})

    expect(held.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('runs on, off and Register again one after the other, never overlapping', async () => {
    const browser = new FakeBrowser()

    browser.granted = 'granted'

    const { store, sync } = setup({ browser })
    const busy: boolean[] = []

    store.subscribe(state => busy.push(state.busy))
    sync.start()
    await settle()

    const on = sync.enable()
    const off = sync.disable()

    await Promise.all([on, off])

    // The subscription made by the first is let go by the second, never left behind by a race.
    expect(browser.subscribed).toEqual([KEY])
    expect(browser.current).toBeNull()
    expect(store.getState()).toMatchObject({ enabled: false, address: null, busy: false })
    expect(busy).toContain(true)
  })
})

describe('the test notification', () => {
  const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))

  it('posts this browser’s installation id, authenticated, as JSON', async () => {
    const fetch = respond(200, { v: 1, transport: 'webpush', outcome: 'sent', status: 201 })
    const { store, sync } = setup({ fetch })

    expect(await sync.sendTest()).toEqual({ kind: 'sent' })
    expect(fetch).toHaveBeenCalledWith(`${BASE}${PUSH_TEST_PATH}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Test': 'yes', 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: store.getState().installationId })
    })
  })

  it.each([
    [respond(200, { outcome: 'gone' }), { kind: 'refused', outcome: 'gone' }],
    [respond(404, { detail: 'no such row' }), { kind: 'not-registered' }],
    [respond(429, { detail: 'slow down' }, { 'Retry-After': '7' }), { kind: 'busy', retryAfter: 7 }],
    [respond(409, { detail: 'off' }), { kind: 'failed', status: 409 }],
    [
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
      { kind: 'failed', status: 0 }
    ]
  ] as const)('says what the route answered (%#)', async (fetch, outcome) => {
    const { sync } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })

    expect(await sync.sendTest()).toEqual(outcome)
  })
})

describe('clicks', () => {
  const APPROVAL = {
    type: 'request',
    bot: 'scout',
    sessionId: '8a1b2c3d',
    sessionKey: 'stored',
    sessionKind: 'canonical',
    method: 'approval',
    requestId: 'appr-1'
  }

  const click = (actionIdentifier: string, data: Record<string, unknown> = APPROVAL) => ({
    source: PUSH_MESSAGE_SOURCE,
    response: { actionIdentifier, data }
  })

  it('opens the conversation of a plain click and answers nothing', async () => {
    const { browser, taps, sync } = setup()

    sync.start()
    browser.post(click('default'))
    await settle()

    expect(taps.show).toHaveBeenCalledWith(expect.objectContaining({ bot: 'scout', action: 'open' }))
    expect(taps.openApprovals).not.toHaveBeenCalled()
    expect(taps.respondApproval).not.toHaveBeenCalled()
  })

  it('answers Allow once, after the gateway confirmed the request is still open', async () => {
    const { browser, taps, sync } = setup()

    sync.start()
    browser.post(click(PUSH_ACTION_ALLOW))
    await settle()

    expect(taps.attachedSession).toHaveBeenCalledWith('scout', expect.any(Number))
    expect(taps.openApprovals).toHaveBeenCalledWith('scout')
    expect(taps.respondApproval).toHaveBeenCalledWith('scout', 'appr-1', 'once')
  })

  it('answers Deny with deny', async () => {
    const { browser, taps, sync } = setup()

    sync.start()
    browser.post(click(PUSH_ACTION_DENY))
    await settle()

    expect(taps.respondApproval).toHaveBeenCalledWith('scout', 'appr-1', 'deny')
  })

  it('answers nothing for a request the gateway no longer lists', async () => {
    const { browser, taps, sync } = setup({ taps: { openApprovals: vi.fn(async () => []) } })

    sync.start()
    browser.post(click(PUSH_ACTION_ALLOW))
    await settle()

    expect(taps.show).toHaveBeenCalled()
    expect(taps.respondApproval).not.toHaveBeenCalled()
  })

  it('answers nothing where the click lands outside the bot’s chat, or before the chat attaches', async () => {
    const elsewhere = setup({ taps: { show: vi.fn(() => false) } })

    elsewhere.sync.start()
    elsewhere.browser.post(click(PUSH_ACTION_ALLOW))
    await settle()
    expect(elsewhere.taps.attachedSession).not.toHaveBeenCalled()

    const detached = setup({ taps: { attachedSession: vi.fn(async () => '') } })

    detached.sync.start()
    detached.browser.post(click(PUSH_ACTION_ALLOW))
    await settle()
    expect(detached.taps.openApprovals).not.toHaveBeenCalled()
    expect(detached.taps.respondApproval).not.toHaveBeenCalled()
  })

  it('opens the conversation of the click the page was opened for, and never answers from the address', async () => {
    // Anyone who can make this browser follow a link can write that address.
    const { taps, sync } = setup()

    sync.start({ actionIdentifier: PUSH_ACTION_ALLOW, data: APPROVAL })
    await settle()

    expect(taps.show).toHaveBeenCalledWith(expect.objectContaining({ bot: 'scout', action: 'open' }))
    expect(taps.openApprovals).not.toHaveBeenCalled()
    expect(taps.respondApproval).not.toHaveBeenCalled()
  })

  it('handles one click at a time, so a double click cannot answer twice at once', async () => {
    let release: () => void = () => undefined
    const respondApproval = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const { browser, taps, sync } = setup({ taps: { respondApproval } })

    sync.start()
    browser.post(click(PUSH_ACTION_ALLOW))
    browser.post(click(PUSH_ACTION_ALLOW))
    await settle()

    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(taps.show).toHaveBeenCalledTimes(1)

    release()
    await settle()
    expect(taps.show).toHaveBeenCalledTimes(2)
  })

  it('ignores a message that is not the worker’s, and a clearing push', async () => {
    const { browser, taps, sync } = setup()

    sync.start()
    browser.post({ source: 'other', response: { data: APPROVAL } })
    browser.post(click('default', { ...APPROVAL, clear: true }))
    await settle()

    expect(taps.show).not.toHaveBeenCalled()
  })

  it('stops listening when stopped', async () => {
    const { browser, store, taps, sync } = setup()

    sync.start()
    expect(store.getState().controller).toBe(sync)

    sync.stop()
    browser.post(click('default'))
    await settle()

    expect(taps.show).not.toHaveBeenCalled()
    expect(store.getState().controller).toBeNull()
  })
})
