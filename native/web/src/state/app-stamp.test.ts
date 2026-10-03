/**
 * The date the app-wide section was last CHOSEN (the Expo app's
 * `store/app-stamp.ts`, whose rules the Expo app tested through
 * `app-settings-sync.test.ts`; the two-device cases are in
 * `core/ui-meta-sync.test.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import { APP_STAMP_KEY, createAppStampStore } from './app-stamp'

let stamp = createAppStampStore()
const store = () => stamp.getState()
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  stamp = createAppStampStore()
})

describe('the date', () => {
  it('is never older than the date this device already holds', () => {
    // Two devices do not share a clock: a page a minute behind would otherwise
    // date its owner's newest choice into the past.
    store().applyRemote(10_000)
    store().touch(5_000)

    expect(store().updatedAt).toBe(10_001)
  })

  it('takes the wall clock when that is later', () => {
    store().applyRemote(10_000)
    store().touch(20_000)

    expect(store().updatedAt).toBe(20_000)
  })

  it('adopts an undated section as undated', () => {
    store().touch(20_000)
    store().applyRemote(0)

    expect(store().updatedAt).toBe(0)
  })

  it('survives a reload, and is forgotten with the person on a sign-out', async () => {
    const disk = createKeyValueStore({ namespace: 'test', storage: null })

    await store().hydrate(disk)
    store().touch(20_000)
    await settle()

    const again = createAppStampStore()

    await again.getState().hydrate(disk)
    expect(again.getState().updatedAt).toBe(20_000)
    expect(again.getState().loaded).toBe(true)
    expect(disk.clearIdentityBound()).toContain(APP_STAMP_KEY)
  })
})
