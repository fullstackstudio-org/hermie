/**
 * The highlighting palette, measured.
 *
 * `code-theme.ts` says every entry keeps AA contrast on `surfaceRaised`, which is
 * what a code block sits on. That claim is arithmetic, so it is held here as
 * arithmetic: every scope, both schemes, 4.5:1. The web client also draws the
 * palette over its own grounds (the text colour at 7% over the bubble and over the
 * page), so those are measured too.
 */
import { describe, expect, it } from 'vitest'

import { codeScopeColor } from './code-theme'

type Rgb = [number, number, number]

const SCOPES = [
  'addition',
  'attr',
  'attribute',
  'built_in',
  'bullet',
  'char',
  'class',
  'code',
  'comment',
  'deletion',
  'doctag',
  'emphasis',
  'formula',
  'function',
  'keyword',
  'link',
  'literal',
  'meta',
  'name',
  'number',
  'operator',
  'params',
  'property',
  'punctuation',
  'quote',
  'regexp',
  'section',
  'selector-tag',
  'strong',
  'string',
  'subst',
  'symbol',
  'tag',
  'title',
  'type',
  'variable'
]

function rgb(hex: string): Rgb {
  return [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as Rgb
}

function luminance([red, green, blue]: Rgb): number {
  const channel = (value: number): number => {
    const unit = value / 255

    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]

  return (light + 0.05) / (dark + 0.05)
}

/** `text` at 7% over `ground`: the code surface the web client paints. */
function surface(text: string, ground: string): Rgb {
  return rgb(text).map((value, index) => value * 0.07 + (rgb(ground)[index] as number) * 0.93) as Rgb
}

const GROUNDS: Record<'light' | 'dark', Record<string, Rgb>> = {
  light: {
    surfaceRaised: rgb('#E9E9ED'),
    'web bubble': surface('#1d1d1f', '#f4f5f8'),
    'web page': surface('#1d1d1f', '#ffffff')
  },
  dark: {
    surfaceRaised: rgb('#28282C'),
    'web bubble': surface('#f5f5f7', '#16181d'),
    'web page': surface('#f5f5f7', '#0c0d10')
  }
}

describe('the code palette', () => {
  it.each(
    (['light', 'dark'] as const).flatMap(scheme =>
      Object.keys(GROUNDS[scheme]).flatMap(ground => SCOPES.map(scope => [scheme, ground, scope] as const))
    )
  )('%s, on %s: %s reaches 4.5:1', (scheme, ground, scope) => {
    const color = codeScopeColor(scope, scheme)

    expect(color).toMatch(/^#[0-9A-F]{6}$/)
    expect(contrast(rgb(color as string), GROUNDS[scheme][ground] as Rgb)).toBeGreaterThanOrEqual(4.5)
  })

  it('has a colour for every scope this test lists, and the dotted ones by their first segment', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const scope of SCOPES) {
        expect(codeScopeColor(scope, scheme)).toBeDefined()
      }

      expect(codeScopeColor('title.function', scheme)).toBe(codeScopeColor('title', scheme))
    }

    expect(codeScopeColor(undefined, 'light')).toBeUndefined()
  })
})
