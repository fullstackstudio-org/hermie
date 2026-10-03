import { describe, expect, it } from 'vitest'

import { buildLabel, clientVersion, shortCommit, sourceCommit } from './build-info'

describe('build info', () => {
  it('shortens the commit to seven characters', () => {
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(shortCommit).toBe(sourceCommit.slice(0, 7))
  })

  it('reads as "<version> (<short commit>)"', () => {
    expect(buildLabel).toBe(`${clientVersion} (${shortCommit})`)
  })
})
