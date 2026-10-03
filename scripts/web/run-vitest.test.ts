import { describe, expect, it } from 'vitest'

import { acceptsNodeOption, withNodeOption } from '../../native/web/scripts/node-option.mjs'

describe('the web client’s test runner flag probe', () => {
  it('adds a flag to what NODE_OPTIONS already holds', () => {
    expect(withNodeOption('--no-webstorage', undefined)).toBe('--no-webstorage')
    expect(withNodeOption('--no-webstorage', '--max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096 --no-webstorage'
    )
  })

  it('says yes to a flag this Node starts with, and no to one it refuses to start with', () => {
    expect(acceptsNodeOption('--no-warnings')).toBe(true)
    // Node 22 does not know `--no-webstorage` and exits; the probe is how the runner stays a no-op there.
    expect(acceptsNodeOption('--no-such-flag-in-any-node')).toBe(false)
  })

  it('keeps what the caller already had in NODE_OPTIONS in the probe', () => {
    expect(acceptsNodeOption('--no-warnings', { env: { NODE_OPTIONS: '--no-such-flag-in-any-node' } })).toBe(false)
  })
})
