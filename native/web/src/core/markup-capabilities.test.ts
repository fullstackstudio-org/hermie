import { describe, expect, it } from 'vitest'

import { WEB_MARKUP } from './markup-capabilities'

describe('the blocks the page advertises', () => {
  it('are exactly chart, cards and alerts, sorted as the gateway echoes them', () => {
    // A name goes here the day its renderer ships, and comes out the day a block misbehaves: this test is the review.
    expect([...WEB_MARKUP]).toEqual(['alerts', 'cards', 'chart'])
  })

  it('are well-formed names, as the gateway accepts them', () => {
    expect(WEB_MARKUP.length).toBeLessThanOrEqual(16)

    for (const name of WEB_MARKUP) {
      expect(name).toMatch(/^[a-z][a-z-]*$/u)
      expect(name.length).toBeLessThanOrEqual(32)
    }
  })

  it('cannot be changed by whoever imports it', () => {
    expect(Object.isFrozen(WEB_MARKUP)).toBe(true)
  })
})
