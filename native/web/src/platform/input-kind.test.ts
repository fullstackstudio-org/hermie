import { describe, expect, it } from 'vitest'

import { hasFinePointer } from './input-kind'

describe('whether a keyboard is likely there', () => {
  it('says yes where a mouse or a trackpad is attached', () => {
    const asked: string[] = []

    expect(
      hasFinePointer({
        matchMedia: query => {
          asked.push(query)

          return { matches: true }
        }
      })
    ).toBe(true)
    expect(asked).toEqual(['(any-pointer: fine)'])
  })

  it('says no on a device that has only a finger', () => {
    expect(hasFinePointer({ matchMedia: () => ({ matches: false }) })).toBe(false)
  })

  it('assumes a keyboard where it cannot tell', () => {
    expect(hasFinePointer(null)).toBe(true)
    expect(hasFinePointer({})).toBe(true)
    expect(
      hasFinePointer({
        matchMedia: () => {
          throw new Error('refused')
        }
      })
    ).toBe(true)
  })
})
