/**
 * The push map in the app section (W-25): every other device's row and
 * heartbeat as the gateway holds them, this browser's row and heartbeat as the
 * push store holds them, and the person's per-chat overrides.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { APP_KEY, holdingGateway, openPage, type Page, settled } from '../test-support/ui-meta-devices'
import { registrationRowOf } from './push/row'

const KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'
const NOW = 1_790_000_000

const ADDRESS = {
  transport: 'webpush' as const,
  endpoint: 'https://push.example.test/send/1',
  keys: { p256dh: 'p256', auth: 'auth' },
  applicationServerKey: KEY
}

const PHONE = { v: 1, transport: 'expo', token: 'ExponentPushToken[phone]', platform: 'ios', updatedAt: 1, types: {} }

const pages: Page[] = []

afterEach(async () => {
  while (pages.length) {
    pages.pop()?.stop()
  }

  await settled()
})

/** A gateway whose person already has a section with a phone's row, a bare-number heartbeat and an override. */
function gatewayWithPhone(own?: Record<string, unknown>) {
  const gateway = holdingGateway()

  gateway.meta('researcher')[APP_KEY] = {
    v: 1,
    entries: [],
    updatedAt: NOW - 100,
    push: {
      registrations: { iphone: PHONE, ...(own ?? {}) },
      seen: { iphone: NOW - 10 },
      perBot: { researcher: { cron: false } }
    }
  }

  return gateway
}

function page(gateway: ReturnType<typeof holdingGateway>): Page {
  const opened = openPage(gateway, { now: () => NOW })

  pages.push(opened)

  return opened
}

/** This page's push store as the controller leaves it after the launch check. */
function registered(one: Page, phase: 'checking' | 'settled' = 'settled'): string {
  const push = one.push.getState()

  push.hydrate(one.disk)
  push.setGatewayKey('bf796761db84e312')
  push.setEnabled(true)
  push.setAddress(ADDRESS, NOW)
  push.setPhase(phase)

  return one.push.getState().installationId
}

const pushOf = (gateway: ReturnType<typeof holdingGateway>) =>
  gateway.app()?.push as { registrations: Record<string, unknown>; seen: Record<string, unknown>; perBot?: unknown }

describe('the push map', () => {
  it('goes back as it came while Web Push has not loaded', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().addFolder('Finance')
    await settled()

    expect(gateway.writes.length).toBeGreaterThan(0)
    expect(gateway.app()?.push).toEqual({
      registrations: { iphone: PHONE },
      seen: { iphone: NOW - 10 },
      perBot: { researcher: { cron: false } }
    })
  })

  it('takes the person’s per-chat overrides into the store', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    expect(one.push.getState().perBot).toEqual({ researcher: { cron: false } })
  })

  it('writes this browser’s row, with the key it was made with, beside the phone’s', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    const id = registered(one)

    await settled()

    const push = pushOf(gateway)

    expect(push.registrations.iphone).toEqual(PHONE)
    expect(push.registrations[id]).toEqual(
      registrationRowOf({
        installationId: id,
        gatewayKey: 'bf796761db84e312',
        address: ADDRESS,
        types: one.push.getState().types,
        preview: false,
        updatedAt: NOW
      })
    )
    expect(push.registrations[id]).toMatchObject({ applicationServerKey: KEY, clears: true, requestMethods: true })
    // The phone's heartbeat in the shape the plugin says it reads.
    expect(push.seen.iphone).toEqual({ bot: '', at: NOW - 10 })
  })

  it('puts the row back after a take of a copy that lacks it', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    const id = registered(one)

    await settled()
    expect(pushOf(gateway).registrations[id]).toBeDefined()

    // Another device wrote the section from a copy that predates this browser's row.
    gateway.meta('researcher')[APP_KEY] = { ...(gateway.app() ?? {}), push: { registrations: { iphone: PHONE } } }
    await one.bridge.reconcile()

    expect(pushOf(gateway).registrations[id]).toMatchObject({ applicationServerKey: KEY })
  })

  it('carries the row the gateway holds for this browser until the launch check has run', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    const push = one.push.getState()

    push.hydrate(one.disk)

    const id = one.push.getState().installationId
    const held = {
      v: 1,
      transport: 'webpush',
      endpoint: 'https://push.example.test/old',
      keys: { p256dh: 'x', auth: 'y' }
    }

    gateway.meta('researcher')[APP_KEY] = {
      ...(gateway.app() ?? {}),
      push: { registrations: { iphone: PHONE, [id]: held } }
    }
    await one.bridge.reconcile()
    one.push.getState().setPhase('checking')
    one.layout.getState().addFolder('Finance')
    await settled()

    expect(pushOf(gateway).registrations[id]).toEqual(held)

    // Checked, and off: the row goes.
    one.push.getState().setPhase('settled')
    await settled()

    expect(pushOf(gateway).registrations[id]).toBeUndefined()
    expect(pushOf(gateway).registrations.iphone).toEqual(PHONE)
  })

  it('takes the row out when switched off', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    const id = registered(one)

    await settled()
    one.push.getState().setEnabled(false)
    await settled()

    expect(pushOf(gateway).registrations).toEqual({ iphone: PHONE })
    expect(pushOf(gateway).registrations[id]).toBeUndefined()
  })

  it('writes the heartbeat as a chore, and the per-chat overrides as a choice', async () => {
    const gateway = gatewayWithPhone()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()

    const id = registered(one)

    await settled()

    const datedBefore = gateway.app()?.updatedAt

    one.push.getState().beat('researcher', NOW + 5)
    await settled()

    expect(pushOf(gateway).seen[id]).toEqual({ bot: 'researcher', at: NOW + 5 })
    expect(gateway.app()?.updatedAt).toBe(datedBefore)

    one.push.getState().setBotType('writer', 'message', false)
    await settled()

    expect(pushOf(gateway).perBot).toEqual({ researcher: { cron: false }, writer: { message: false } })
    expect(gateway.app()?.updatedAt).toBe(NOW)
  })
})
