import { describe, expect, it, vi } from 'vitest'

import { copyToClipboard, writeClipboard } from './clipboard'

describe('the clipboard', () => {
  it('fires the write and says it tried', () => {
    const writeText = vi.fn(() => Promise.resolve())

    expect(copyToClipboard('hello', { clipboard: { writeText } })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('swallows a refused write in the fire-and-forget form', async () => {
    const writeText = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))

    expect(copyToClipboard('hello', { clipboard: { writeText } })).toBe(true)
    await Promise.resolve()
  })

  it('says no for empty text, or a browser without the API', async () => {
    expect(copyToClipboard('', { clipboard: { writeText: vi.fn() } })).toBe(false)
    expect(copyToClipboard('hello', {})).toBe(false)
    expect(copyToClipboard('hello', null)).toBe(false)
    expect(await writeClipboard('hello', {})).toBe(false)
  })

  it('reports whether the awaited write was taken', async () => {
    expect(await writeClipboard('hello', { clipboard: { writeText: () => Promise.resolve() } })).toBe(true)
    expect(
      await writeClipboard('hello', {
        clipboard: { writeText: () => Promise.reject(new DOMException('no gesture', 'NotAllowedError')) }
      })
    ).toBe(false)
  })
})
