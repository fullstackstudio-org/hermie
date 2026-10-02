import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildLabel, clientVersion, shortCommit, sourceCommit } from './build-info'
import { Placeholder } from './Placeholder'

describe('build info', () => {
  it('shortens the commit to seven characters', () => {
    expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(shortCommit).toBe(sourceCommit.slice(0, 7))
  })

  it('reads as "<version> (<short commit>)"', () => {
    expect(buildLabel).toBe(`${clientVersion} (${shortCommit})`)
  })
})

describe('the smoke page', () => {
  it('renders the heading and the build without a gateway', () => {
    render(<Placeholder />)

    expect(screen.getByRole('heading', { level: 1, name: 'Hermie' })).toBeTruthy()
    expect(screen.getByText(buildLabel)).toBeTruthy()
  })

  it('makes no network request', () => {
    const calls: unknown[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args)
      return Promise.reject(new Error('the smoke page must not fetch'))
    }) as typeof fetch

    try {
      render(<Placeholder />)
    } finally {
      globalThis.fetch = original
    }

    expect(calls).toEqual([])
  })
})
