// @vitest-environment node
/**
 * What a source row is drawn from (`sources-model.ts`) and the twelve colours of the monograms (`sources.css`).
 *
 * The host is the part a person trusts, so it is tested the hard way: whole, with its port, never shortened, never
 * a different name from the one the address spells.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Source } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { displayHost, MONOGRAM_HUES, monogramOf, rowOf, tiersOf } from './sources-model'

const here = dirname(fileURLToPath(import.meta.url))

describe('displayHost', () => {
  it('is the authority exactly as the address spells it, port included, nothing trimmed', () => {
    expect(displayHost('https://example.org/guide/install')).toBe('example.org')
    expect(displayHost('https://www.example.org/x')).toBe('www.example.org')
    expect(displayHost('http://example.net:8080/a?b=c#d')).toBe('example.net:8080')
    expect(displayHost('https://[2001:db8::1]:8443/page')).toBe('[2001:db8::1]:8443')
    expect(displayHost('HTTPS://Docs.Example.com/')).toBe('Docs.Example.com')
    expect(displayHost('https://a.very.long.sub.domain.of.some.site.example.org/')).toBe(
      'a.very.long.sub.domain.of.some.site.example.org'
    )
  })

  it('shows punycode as stored, and turns a name that is not ASCII into punycode rather than showing it', () => {
    expect(displayHost('https://xn--bcher-kva.example/')).toBe('xn--bcher-kva.example')
    // A lookalike (Cyrillic а) must not pass for the Latin name.
    expect(displayHost('https://аpple.com/')).toBe('xn--pple-43d.com')
  })

  it('is empty for an address with no authority', () => {
    expect(displayHost('')).toBe('')
    expect(displayHost('https:///path')).toBe('')
    expect(displayHost('ftp://example.org/')).toBe('')
  })

  it('does not take the host from the path or the query of a misleading address', () => {
    expect(displayHost('https://evil.example/https://bank.example/')).toBe('evil.example')
    expect(displayHost('https://evil.example?https://bank.example')).toBe('evil.example')
    expect(displayHost('https://evil.example#@bank.example')).toBe('evil.example')
  })
})

describe('monogramOf', () => {
  it('is the first letter of the host after www., upper case', () => {
    expect(monogramOf('https://www.example.org/').letter).toBe('E')
    expect(monogramOf('https://docs.example.com/').letter).toBe('D')
    expect(monogramOf('http://example.net:8080/').letter).toBe('E')
  })

  it('is a digit for an address, and # for a host with neither a letter nor a digit', () => {
    expect(monogramOf('http://192.168.1.1/').letter).toBe('1')
    expect(monogramOf('https://[2001:db8::1]/').letter).toBe('2')
    expect(monogramOf('https:///x').letter).toBe('#')
  })

  it('is one colour for one host, on every visit and for every page of it', () => {
    const a = monogramOf('https://example.org/one')
    const b = monogramOf('https://www.example.org/two?x=1')

    expect(a).toEqual(b)
    expect(a.hue).toBeGreaterThanOrEqual(0)
    expect(a.hue).toBeLessThan(MONOGRAM_HUES)
  })

  it('spreads hosts over the colours', () => {
    const hues = new Set(Array.from({ length: 200 }, (_, index) => monogramOf(`https://site-${index}.example/`).hue))

    expect(hues.size).toBe(MONOGRAM_HUES)
  })
})

describe('rowOf and tiersOf', () => {
  const read: Source = { url: 'https://example.org/a', title: 'A', via: 'read' }
  const found: Source = { url: 'https://docs.example.com/b', title: '', via: 'found' }

  it('gives a row a link only where the link policy allows one', () => {
    expect(rowOf(read)).toEqual({ source: read, host: 'example.org', href: 'https://example.org/a' })
    expect(rowOf({ ...read, url: 'https://[' }).href).toBeNull()
  })

  it('lists read before found, each only when it has entries, in the order given', () => {
    const another: Source = { url: 'https://third.example/', title: 'C', via: 'read' }

    expect(tiersOf([found, read, another]).map(tier => [tier.via, tier.rows.map(row => row.source.url)])).toEqual([
      ['read', ['https://example.org/a', 'https://third.example/']],
      ['found', ['https://docs.example.com/b']]
    ])
    expect(tiersOf([found]).map(tier => tier.via)).toEqual(['found'])
    expect(tiersOf([])).toEqual([])
  })
})

describe('the monogram colours', () => {
  const css = readFileSync(join(here, 'sources.css'), 'utf8')

  /** WCAG relative luminance of an sRGB colour (0..1 per channel). */
  const luminance = (rgb: [number, number, number]): number => {
    const [r, g, b] = rgb.map(channel =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ) as [number, number, number]

    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  /** CSS `hsl(h s% l%)` to sRGB. */
  const hsl = (h: number, s: number, l: number): [number, number, number] => {
    const a = s * Math.min(l, 1 - l)
    const f = (n: number): number => {
      const k = (n + h / 30) % 12

      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    }

    return [f(0), f(8), f(4)]
  }

  const fill = /background:\s*hsl\(var\(--hm-mono-hue\)\s+(\d+)%\s+(\d+)%\)/u.exec(css)
  const hues = [...css.matchAll(/\.hm-mono\[data-hue='(\d+)'\]\s*\{\s*--hm-mono-hue:\s*(\d+);/gu)].map(match => ({
    bucket: Number(match[1]),
    hue: Number(match[2])
  }))

  it('has one colour for each bucket the model can answer', () => {
    expect(hues.map(entry => entry.bucket)).toEqual(Array.from({ length: MONOGRAM_HUES }, (_, index) => index))
  })

  it('puts a white letter on every one with at least 4.5:1', () => {
    expect(fill).not.toBeNull()

    const saturation = Number(fill?.[1]) / 100
    const lightness = Number(fill?.[2]) / 100

    for (const { hue } of hues) {
      const ratio = 1.05 / (luminance(hsl(hue, saturation, lightness)) + 0.05)

      expect(ratio, `hue ${hue}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
