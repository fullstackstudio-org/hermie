/**
 * The transcript's text size: the helpers ported from the Expo app's
 * `store/text-size.ts`, and the store this client keeps it in.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import {
  asTextSize,
  bindTextSize,
  createTextSizeStore,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_KEY,
  TEXT_SIZE_ORDER,
  textSizeScale
} from './text-size'

let sizes = createTextSizeStore()
const store = () => sizes.getState()

beforeEach(() => {
  sizes = createTextSizeStore()
})

describe('the helpers', () => {
  it('lists the sizes smallest first', () => {
    expect(TEXT_SIZE_ORDER).toEqual(['small', 'default', 'large', 'xlarge'])
  })

  it('reads a size defensively', () => {
    expect(asTextSize('large')).toBe('large')
    expect(asTextSize('huge')).toBeUndefined()
    expect(asTextSize(3)).toBeUndefined()
  })

  it('multiplies by one for anything it does not know', () => {
    expect(textSizeScale('xlarge')).toBe(1.3)
    expect(textSizeScale(undefined)).toBe(1)
  })
})

describe('the store', () => {
  it('starts at the default and remembers a pick across a reload', () => {
    const disk = createKeyValueStore({ namespace: 'test', storage: null })

    store().hydrate(disk)
    expect(store().textSize).toBe(DEFAULT_TEXT_SIZE)

    store().setTextSize('large')

    const again = createTextSizeStore()

    again.getState().hydrate(disk)
    expect(again.getState().textSize).toBe('large')
  })

  it('keeps the size on this browser across a sign-out', () => {
    const disk = createKeyValueStore({ namespace: 'test', storage: null })

    store().hydrate(disk)
    store().setTextSize('small')

    expect(disk.clearIdentityBound()).not.toContain(TEXT_SIZE_KEY)
  })

  it('takes a gateway’s size, and ignores one it does not know', () => {
    store().setTextSize('large')
    store().applyRemote('huge')
    expect(store().textSize).toBe('large')

    store().applyRemote('small')
    expect(store().textSize).toBe('small')
  })

  it('does not notify for the size it already has', () => {
    let notified = 0

    sizes.subscribe(() => (notified += 1))
    store().setTextSize('default')
    store().applyRemote('default')

    expect(notified).toBe(0)
  })
})

describe('bindTextSize', () => {
  it('applies the size now and on every change, and only on a change', () => {
    const applied: string[] = []
    const stop = bindTextSize(sizes, size => applied.push(size))

    store().setTextSize('large')
    store().setTextSize('large')
    store().applyRemote('small')
    stop()
    store().setTextSize('xlarge')

    expect(applied).toEqual(['default', 'large', 'small'])
  })
})

describe('the stylesheet', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'theme.css'), 'utf8')

  it.each(TEXT_SIZE_ORDER)('multiplies by the factor the store says for %s', size => {
    const rule = new RegExp(`:root\\[data-text-size='${size}'\\]\\s*\\{\\s*--hm-chat-scale:\\s*([0-9.]+);`).exec(css)

    expect(rule, `theme.css has no rule for ${size}`).not.toBeNull()
    expect(Number(rule?.[1])).toBe(textSizeScale(size))
  })
})
