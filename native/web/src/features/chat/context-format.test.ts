import type { ContextUsage } from '@hermie/transcript'
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { contextCounts, contextSummary, formatTokens } from './context-format'

afterEach(() => resetActiveLocale())

const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  used: 164_200,
  limit: 200_000,
  fraction: 0.821,
  percent: 82,
  estimated: false,
  ...over
})

describe('formatTokens', () => {
  it('is exact under a thousand, thousands under a million and millions with a decimal only under ten', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(850.4)).toBe('850')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(164_200)).toBe('164k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(12_400_000)).toBe('12M')
  })

  it('writes the decimal the reader’s language does', () => {
    setActiveLocale('nl')
    expect(formatTokens(1_200_000)).toBe('1,2M')
  })
})

describe('the context reading as words', () => {
  it('is the used and the window, and the percentage with them', () => {
    expect(contextCounts(usage())).toBe('164k / 200k')
    expect(contextSummary(usage())).toBe('82% · 164k / 200k')
  })

  it('carries the gateway’s own caveat when the count is an estimate', () => {
    expect(contextSummary(usage({ estimated: true }))).toBe('82% · 164k / 200k (estimated)')
  })
})
