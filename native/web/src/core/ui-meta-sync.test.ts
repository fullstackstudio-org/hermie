/**
 * The app-wide section on somebody's second page: the arrangement and the text
 * size, and the date that decides whose copy is newer.
 *
 * Ported from the Expo app's `__tests__/arrangement-sync.test.ts` (unchanged
 * cases, against per-page stores) and `__tests__/app-settings-sync.test.ts`
 * (the theme cases with the text size in the theme's place: this client keeps
 * no theme of its own, W11, and carries the gateway's raw; the last case here
 * pins that).
 *
 * What was reported on the Expo app, and is pinned here: a second device folded
 * the live roster into an arrangement it had not read yet, that fold was dated
 * as though somebody had dragged six rows, and it replaced the folders on the
 * gateway for every device. And: a theme picked on one machine was undone by
 * opening another. So a CHORE is sent undated, a CHOICE is dated, an arriving
 * copy is adopted with its date, and the newer date wins.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { APP_STAMP_KEY } from '../state/app-stamp'
import { TEXT_SIZE_KEY } from '../state/text-size'
import {
  APP_KEY,
  type HoldingGateway,
  holdingGateway,
  newDisk,
  openPage,
  type Page,
  settled
} from '../test-support/ui-meta-devices'
import type { WebKeyValueStore } from '../platform/key-value-store'

const ROSTER = ['researcher', 'writer']
const NOW = Math.floor(Date.now() / 1000)
const AN_HOUR_AGO = NOW - 3600
const A_MINUTE_AGO = NOW - 60

const pages: Page[] = []

afterEach(async () => {
  while (pages.length) {
    pages.pop()?.stop()
  }

  await settled()
  await settled()
})

function page(...args: Parameters<typeof openPage>): Page {
  const opened = openPage(...args)

  pages.push(opened)

  return opened
}

/** One page, connected, with a folder holding the writer. */
async function arrangeOnline(gateway: HoldingGateway): Promise<void> {
  const one = page(gateway)

  await one.watching
  await one.bridge.reconcile()
  one.layout.getState().reconcile(ROSTER)

  const folder = one.layout.getState().addFolder('Finance')

  one.layout.getState().moveToFolder('writer', folder)
  await settled()
  one.stop()
  await settled()
}

/** One page picking a text size while it is connected, and the gateway hearing it. */
async function chooseOnline(gateway: HoldingGateway, size: 'small' | 'large' | 'xlarge'): Promise<void> {
  const one = page(gateway)

  await one.bridge.reconcile()
  one.textSize.getState().setTextSize(size)
  await settled()
  one.stop()
  await settled()
}

/** A browser that has already chosen this size, at this moment, and was closed. */
async function diskHolding(size: string, chosenAt: number): Promise<WebKeyValueStore> {
  const disk = newDisk()

  disk.setSync(TEXT_SIZE_KEY, size)
  await disk.setJson(APP_STAMP_KEY, { updatedAt: chosenAt })

  return disk
}

const failing = { request: () => Promise.reject(new Error('gateway not connected')) }

describe('the folders, on a second page', () => {
  it('arrive, and are not replaced by that page’s own flat list', async () => {
    const gateway = holdingGateway()

    await arrangeOnline(gateway)
    expect(gateway.app()?.folders).toHaveLength(1)

    // An hour ago, so that nothing below can pass on a tie.
    gateway.dateApp(AN_HOUR_AGO)

    // The other page: nothing arranged on it, and the roster lands before the
    // reconcile does, as it can in the app.
    const phone = page(gateway)

    await phone.watching
    phone.layout.getState().reconcile(ROSTER)
    await phone.bridge.reconcile()
    await settled()

    expect(phone.layout.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
    expect(phone.layout.getState().folders[0]?.bots).toEqual(['writer'])
    // And the gateway still holds them, which is what made this a loss.
    expect(gateway.app()?.folders).toHaveLength(1)
  })

  it('arrive in the other connect order too', async () => {
    const gateway = holdingGateway()
    const disk = newDisk()
    const first = page(gateway, { disk })

    await first.watching
    first.layout.getState().reconcile(ROSTER)
    await first.bridge.reconcile()
    await settled()
    first.stop()
    await settled()

    expect(gateway.app()?.entries).toHaveLength(2)

    await arrangeOnline(gateway)
    expect(gateway.app()?.folders).toHaveLength(1)
    gateway.dateApp(AN_HOUR_AGO)

    // Back on the first page, whose own list was the flat one.
    const again = page(gateway, { disk })

    await again.watching
    again.layout.getState().reconcile(ROSTER)
    await again.bridge.reconcile()
    await settled()

    expect(again.layout.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
  })

  it('keeps a rearrangement made with no socket', async () => {
    const gateway = holdingGateway()

    await arrangeOnline(gateway)
    gateway.dateApp(AN_HOUR_AGO)

    // The other page, offline: it makes a folder of its own with nothing to
    // send it to, and that is a choice rather than a fold.
    const disk = newDisk()
    const offline = page(failing, { disk })

    await offline.watching
    offline.layout.getState().reconcile(ROSTER)
    await offline.bridge.reconcile()
    offline.layout.getState().addFolder('Travel')
    await settled()
    offline.stop()
    await settled()

    const back = page(gateway, { disk })

    await back.bridge.reconcile()
    await settled()

    expect((gateway.app()?.folders as { name: string }[]).map(folder => folder.name)).toEqual(['Travel'])
  })
})

describe('the roster folding itself in', () => {
  it('does not date the section, because nobody chose it', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().reconcile(ROSTER)
    await settled()

    expect(one.layout.getState().entries).toHaveLength(2)
    expect(one.appStamp.getState().updatedAt).toBe(0)
    expect(gateway.app()).not.toHaveProperty('updatedAt')
  })

  it('is still sent, because a bot that has appeared belongs in the list', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().reconcile(ROSTER)
    await settled()

    expect(gateway.app()?.entries).toEqual([
      { kind: 'chat', name: 'researcher' },
      { kind: 'chat', name: 'writer' }
    ])
  })

  it('does not date the sweep of mutes that have already lapsed either', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().setMute('researcher', 1_000)
    await settled()

    const chosenAt = one.appStamp.getState().updatedAt

    expect(chosenAt).toBeGreaterThan(0)

    one.layout.getState().dropExpiredMutes(2_000)
    await settled()

    expect(one.layout.getState().mutes).toEqual({})
    expect(one.appStamp.getState().updatedAt).toBe(chosenAt)
    // Still sent, so that the section stops collecting last spring's deadlines.
    expect(gateway.app()?.mutes).toEqual({})
  })

  it('leaves a drag straight after it dated, which is the case next to it', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().reconcile(ROSTER)
    one.layout.getState().addFolder('Finance')
    await settled()

    expect(one.appStamp.getState().updatedAt).toBeGreaterThan(0)
  })

  it('does not date a correction of which conversation a bot is on', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().setCurrent('researcher', 'sess-gone', { chore: true })
    await settled()

    expect(one.appStamp.getState().updatedAt).toBe(0)
    expect(gateway.app()?.current).toEqual({ researcher: 'sess-gone' })
  })
})

describe('the text size, on a second page', () => {
  it('follows the person rather than resetting to whatever that page had', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'xlarge')
    expect(gateway.app()?.textSize).toBe('xlarge')
    gateway.dateApp(AN_HOUR_AGO)

    // The other page has Small on it, from before.
    const phone = page(gateway, { disk: await diskHolding('small', AN_HOUR_AGO - 600) })

    await phone.bridge.reconcile()
    await settled()

    expect(phone.textSize.getState().textSize).toBe('xlarge')
    expect(gateway.app()?.textSize).toBe('xlarge')
  })

  it('carries in the other direction too, whichever page connected first', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'small')
    gateway.dateApp(AN_HOUR_AGO)

    const desktop = page(gateway, { disk: await diskHolding('xlarge', A_MINUTE_AGO) })

    await desktop.bridge.reconcile()
    await settled()

    expect(desktop.textSize.getState().textSize).toBe('xlarge')
    expect(gateway.app()?.textSize).toBe('xlarge')
  })

  it('keeps a change made with no socket, and lands it on the next connect', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'small')
    gateway.dateApp(AN_HOUR_AGO)

    const disk = await diskHolding('default', AN_HOUR_AGO - 600)
    const offline = page(failing, { disk })

    await offline.bridge.reconcile()
    offline.textSize.getState().setTextSize('large')
    await settled()
    offline.stop()

    // Dated by the choice, and the date is on the disk with it.
    expect(offline.appStamp.getState().updatedAt).toBeGreaterThan(AN_HOUR_AGO)

    const back = page(gateway, { disk })

    await back.bridge.reconcile()
    await settled()

    expect(gateway.app()?.textSize).toBe('large')
    expect(back.textSize.getState().textSize).toBe('large')
  })

  it('does not let a page that changed nothing win by reconnecting last', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'xlarge')
    gateway.dateApp(A_MINUTE_AGO)

    // This page has an unsent change of its own (a chore: the roster folded in
    // before the gateway answered) and an older size. Being dirty must not make
    // its size the newer one.
    const phone = page(gateway, { disk: await diskHolding('small', AN_HOUR_AGO) })

    await phone.watching
    phone.layout.getState().reconcile(ROSTER)
    await phone.bridge.reconcile()
    await settled()

    expect(phone.textSize.getState().textSize).toBe('xlarge')
    expect(gateway.app()?.textSize).toBe('xlarge')
    // The fold lost with the section it was in, and is simply made again by the
    // next roster (the page's wiring folds after every reconcile).
    expect(phone.layout.getState().entries).toEqual([])
  })
})

describe('the date the section carries', () => {
  it('moves when somebody chooses something', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.bridge.reconcile()
    expect(gateway.app()).not.toHaveProperty('updatedAt')

    one.textSize.getState().setTextSize('large')
    await settled()

    expect(gateway.app()?.updatedAt).toBeGreaterThan(0)
  })

  it('does not move for a section that only arrived', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'xlarge')
    gateway.dateApp(AN_HOUR_AGO)

    const phone = page(gateway)

    await phone.bridge.reconcile()
    await settled()

    expect(phone.appStamp.getState().updatedAt).toBe(AN_HOUR_AGO)
    expect(gateway.app()?.updatedAt).toBe(AN_HOUR_AGO)
  })

  it('survives the launch after it arrived', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'xlarge')
    gateway.dateApp(AN_HOUR_AGO)

    const disk = newDisk()
    const first = page(gateway, { disk })

    await first.bridge.reconcile()
    await settled()
    first.stop()
    await settled()

    // The same browser again, with nothing to reach.
    const again = page(failing, { disk })

    await again.watching

    expect(again.textSize.getState().textSize).toBe('xlarge')
    expect(again.appStamp.getState().updatedAt).toBe(AN_HOUR_AGO)
  })
})

describe('the section this all rides in', () => {
  it('leaves the other keys on the profile exactly where they were', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'large')

    expect(Object.keys(gateway.meta('researcher')).sort()).toEqual([APP_KEY, 'hermes-bots', 'hermie-plugin'].sort())
  })

  it('stays at version 1, with every additive field', async () => {
    const gateway = holdingGateway()

    await chooseOnline(gateway, 'large')

    expect(gateway.app()?.v).toBe(1)
    expect(gateway.app()).toHaveProperty('current')
    expect(gateway.app()).toHaveProperty('myChats')
    expect(gateway.app()).toHaveProperty('labels')
    expect(gateway.app()).toHaveProperty('pinned')
  })

  it('carries the theme another client chose, which this client keeps no copy of', async () => {
    const gateway = holdingGateway()

    // The Swift app picks Graphite and a theme of its own.
    await gateway.request('profiles.configure', {
      name: 'researcher',
      ui_meta: {
        [APP_KEY]: {
          v: 1,
          themeChoice: { kind: 'preset', name: 'graphite' },
          themes: [{ id: 't1', name: 'Studio', base: 'lime' }],
          botNameOrder: 'display',
          updatedAt: AN_HOUR_AGO
        }
      }
    })

    await chooseOnline(gateway, 'large')

    expect(gateway.app()).toMatchObject({
      themeChoice: { kind: 'preset', name: 'graphite' },
      themes: [{ id: 't1', name: 'Studio', base: 'lime' }],
      botNameOrder: 'display',
      textSize: 'large'
    })
  })
})
