/**
 * Whether Web Push is offered, and the one reason it is not.
 */
import { describe, expect, it } from 'vitest'

import type { WebPluginAdvert } from '../advert'
import { browserProblem, environmentOf, type PushEnvironment, pushSupport, type PushWindow } from './platform'

const KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'

const desktop: PushEnvironment = {
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  ios: false,
  standalone: false
}

const advert = (capabilities: string[], withKey = true): WebPluginAdvert =>
  ({
    v: 1,
    version: '0.13.0',
    capabilities,
    modules: { push: 'on' },
    limits: {},
    relayOrigins: [],
    web: null,
    webPush: withKey ? { publicKey: KEY } : null
  }) as unknown as WebPluginAdvert

const read = (value: WebPluginAdvert | null) => ({ read: true, advert: value })

describe('pushSupport', () => {
  it('offers Web Push with the advert’s key when the plugin sends it and publishes the key', () => {
    expect(pushSupport(desktop, read(advert(['push.webpush', 'push.webpush.key'])))).toEqual({
      ok: true,
      publicKey: KEY
    })
  })

  it.each([
    ['plain http', { ...desktop, secure: false }, read(advert(['push.webpush', 'push.webpush.key'])), 'insecure'],
    [
      'a browser without Push',
      { ...desktop, pushManager: false },
      read(advert(['push.webpush', 'push.webpush.key'])),
      'browser'
    ],
    [
      'Safari on an iPhone in a tab',
      { ...desktop, pushManager: false, notification: false, ios: true },
      read(null),
      'ios-home-screen'
    ],
    [
      'an iPhone app on the Home Screen of an iOS without Push',
      { ...desktop, pushManager: false, ios: true, standalone: true },
      read(null),
      'browser'
    ],
    ['an advert not read yet', desktop, { read: false, advert: null }, 'unknown'],
    ['no plugin', desktop, read(null), 'no-plugin'],
    ['a plugin that sends no Web Push', desktop, read(advert(['push.expo'])), 'webpush-off'],
    ['a plugin that predates the key', desktop, read(advert(['push.webpush'], false)), 'plugin-too-old'],
    [
      'a key without its capability (the plugin withdrawing it)',
      desktop,
      read(advert(['push.webpush'], true)),
      'plugin-too-old'
    ],
    [
      'a capability without the key',
      desktop,
      read(advert(['push.webpush', 'push.webpush.key'], false)),
      'plugin-too-old'
    ]
  ] as const)('says why not for %s', (_label, environment, plugin, reason) => {
    expect(pushSupport(environment, plugin)).toEqual({ ok: false, reason })
  })

  it('asks about the browser before the gateway', () => {
    expect(browserProblem({ ...desktop, secure: false, pushManager: false })).toBe('insecure')
    expect(browserProblem(desktop)).toBeNull()
  })
})

describe('environmentOf', () => {
  const windowWith = (overrides: Partial<PushWindow> & { userAgent?: string; touch?: number; standalone?: boolean }) =>
    ({
      isSecureContext: true,
      navigator: {
        userAgent: overrides.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
        maxTouchPoints: overrides.touch ?? 0,
        ...(overrides.standalone === undefined ? {} : { standalone: overrides.standalone }),
        serviceWorker: {}
      },
      matchMedia: () => ({ matches: false }),
      Notification: function Notification() {},
      PushManager: function PushManager() {},
      ...overrides
    }) as unknown as PushWindow

  it('reads a desktop browser', () => {
    expect(environmentOf(windowWith({}))).toEqual(desktop)
  })

  it('tells an iPad that says it is a Mac by its touch screen', () => {
    const ipad = environmentOf(
      windowWith({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', touch: 5 })
    )
    const mac = environmentOf(
      windowWith({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' })
    )

    expect(ipad.ios).toBe(true)
    expect(mac.ios).toBe(false)
  })

  it('tells a Home Screen app from a tab', () => {
    expect(environmentOf(windowWith({ userAgent: 'iPhone', standalone: true })).standalone).toBe(true)
    expect(environmentOf(windowWith({ userAgent: 'iPhone', standalone: false })).standalone).toBe(false)
  })
})
