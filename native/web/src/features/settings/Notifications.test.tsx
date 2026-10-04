/**
 * Settings, Notifications: what it says when notifications cannot be offered,
 * the switch, the types and the preview, "Register again" and the test.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WebPluginAdvert } from '../../core/advert'
import type { PushBrowser, PushEnvironment, PushPermission } from '../../core/push/platform'
import { resetActiveLocale } from '../../i18n/active-locale'
import { createKeyValueStore } from '../../platform/key-value-store'
import { createPluginStore } from '../../state/plugin'
import { createPushStore, type PushController } from '../../state/push'
import { Notifications } from './Notifications'

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

const KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'

const DESKTOP: PushEnvironment = {
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  ios: false,
  standalone: false,
  chromium: true
}

const browserWith = (
  environment: Partial<PushEnvironment> = {},
  permission: PushPermission = 'default'
): PushBrowser => ({
  environment: () => ({ ...DESKTOP, ...environment }),
  permission: () => permission,
  requestPermission: async () => permission,
  worker: async () => {
    throw new Error('not in this test')
  },
  existingWorker: async () => null,
  onMessage: () => () => undefined
})

const advert = (capabilities = ['push.webpush', 'push.webpush.key', 'push.test']): WebPluginAdvert =>
  ({
    v: 1,
    version: '0.13.0',
    capabilities,
    modules: { push: 'on' },
    limits: {},
    relayOrigins: [],
    web: null,
    webPush: { publicKey: KEY }
  }) as unknown as WebPluginAdvert

function mount(options: { browser?: PushBrowser; advert?: WebPluginAdvert | null; enabled?: boolean } = {}) {
  const pluginState = createPluginStore()
  const pushState = createPushStore()
  const controller: PushController = {
    enable: vi.fn(async () => pushState.getState().setEnabled(true)),
    disable: vi.fn(async () => pushState.getState().setEnabled(false)),
    reregister: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => ({ kind: 'busy' as const, retryAfter: 7 }))
  }

  pluginState.getState().apply(options.advert === undefined ? advert() : options.advert)
  pushState.getState().hydrate(createKeyValueStore({ namespace: 'test', storage: null }))
  pushState.getState().bindController(controller)

  if (options.enabled) {
    pushState.getState().setEnabled(true)
    pushState.getState().setAddress(
      {
        transport: 'webpush',
        endpoint: 'https://push.example.test/1',
        keys: { p256dh: 'p', auth: 'a' },
        applicationServerKey: KEY
      },
      1
    )
  }

  render(<Notifications browser={options.browser ?? browserWith()} pluginState={pluginState} pushState={pushState} />)

  return { controller, pushState }
}

describe('the Notifications page', () => {
  it.each([
    ['plain http', { browser: browserWith({ secure: false }) }, /served over https/u],
    [
      'Safari on an iPhone in a tab',
      { browser: browserWith({ pushManager: false, ios: true }) },
      /Add to Home Screen/u
    ],
    ['a browser without Push', { browser: browserWith({ pushManager: false }) }, /does not offer push notifications/u],
    ['no plugin', { advert: null }, /has no Hermie plugin/u],
    ['a plugin too old', { advert: advert(['push.webpush']) }, /too old/u]
  ] as const)('says what is missing for %s, and offers no switch', (_label, options, text) => {
    mount(options)

    expect(screen.getByText(text)).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: 'Notify this browser' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('turns it on through the controller, from the switch', async () => {
    const { controller } = mount()
    const toggle = screen.getByRole('checkbox', { name: 'Notify this browser' })

    expect(screen.getByText('Off. This browser is not registered.')).toBeTruthy()

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(controller.enable).toHaveBeenCalledTimes(1)
  })

  it('says the browser blocks it when the permission was refused', () => {
    mount({ browser: browserWith({}, 'denied') })

    expect(screen.getByText(/blocked for this site/u)).toBeTruthy()
  })

  it('shows the types, the preview, Register again and the test once it is on', async () => {
    const { controller, pushState } = mount({ enabled: true })

    expect(screen.getByText('On. This browser is registered with the gateway.')).toBeTruthy()

    const cron = screen.getByRole('checkbox', { name: 'Routines' })

    fireEvent.click(cron)
    expect(pushState.getState().types.cron).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show a preview' }))
    expect(pushState.getState().preview).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Register again' }))
    expect(controller.reregister).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
    })

    expect(controller.sendTest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Wait 7 seconds before sending another.')).toBeTruthy()
  })

  describe('the preview', () => {
    it('is off until the reader says otherwise, and is described by what it changes', () => {
      mount({ enabled: true })

      const preview = screen.getByRole('checkbox', { name: 'Show a preview' }) as HTMLInputElement

      expect(preview.checked).toBe(false)
      expect(document.getElementById(preview.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
        /^Off, a notification says which bot and what happened/u
      )
    })

    it('follows the store, in both directions, and is its own choice beside the types', () => {
      const { pushState } = mount({ enabled: true })
      const preview = screen.getByRole('checkbox', { name: 'Show a preview' }) as HTMLInputElement

      fireEvent.click(preview)
      expect(preview.checked).toBe(true)
      expect(pushState.getState().types.cron).toBe(true)

      fireEvent.click(preview)
      expect(preview.checked).toBe(false)
      expect(pushState.getState().preview).toBe(false)

      // The other way in, a change from another device through `ui_meta`, is drawn without a click.
      act(() => pushState.getState().setPreview(true))
      expect(preview.checked).toBe(true)
    })

    it('is not offered while notifications are off for this browser', () => {
      mount({ enabled: false })

      expect(screen.queryByRole('checkbox', { name: 'Show a preview' })).toBeNull()
    })

    it('is read in Dutch and German', async () => {
      const { setLanguageChoice } = await import('../../i18n/locale')

      mount({ enabled: true })

      await act(() => setLanguageChoice('nl'))
      expect(screen.getByRole('checkbox', { name: 'Voorbeeld tonen' })).toBeTruthy()

      await act(() => setLanguageChoice('de'))
      expect(screen.getByRole('checkbox', { name: 'Vorschau zeigen' })).toBeTruthy()
    })
  })

  it('offers no test where the plugin has no test route', () => {
    mount({ enabled: true, advert: advert(['push.webpush', 'push.webpush.key']) })

    expect(screen.queryByRole('button', { name: 'Send a test notification' })).toBeNull()
  })

  it('says why registering failed, in the browser’s words', () => {
    const { pushState } = mount({ enabled: true })

    act(() => {
      pushState.getState().setAddress(null, 0)
      pushState.getState().setFailure('Registration failed - push service error')
    })

    expect(screen.getByText('Registering this browser failed: Registration failed - push service error')).toBeTruthy()
  })
})
