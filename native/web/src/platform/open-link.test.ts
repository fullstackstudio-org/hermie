import { describe, expect, it, vi } from 'vitest'

import { openInNewTab } from './open-link'

describe('opening a link in a new tab', () => {
  it('opens it in a tab of its own, with no opener and no referrer', () => {
    const open = vi.fn(() => null)

    openInNewTab('https://auth.example/connect', open)

    expect(open).toHaveBeenCalledWith('https://auth.example/connect', '_blank', 'noopener,noreferrer')
  })
})
