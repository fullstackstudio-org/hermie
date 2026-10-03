// @vitest-environment node
/**
 * The highlighting palette, measured. Reads `markdown-highlight.css` and the
 * package's `code-theme.ts` and holds them together:
 *
 *  - every scope the package colours has a class, a custom property in each
 *    scheme, and a place in `HIGHLIGHT_SCOPES`;
 *  - every value is the package's (`codeScopeColor`), except the few listed
 *    below, which are darker for the reason the stylesheet gives;
 *  - every value reaches 4.5:1 on the code block's surface (the text colour at
 *    7% over the ground), on the bubble and on the page, in both schemes.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { codeScopeColor } from '@hermie/markdown'
import { describe, expect, it } from 'vitest'

import { HIGHLIGHT_SCOPES, scopeClass } from './Highlight'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'markdown-highlight.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const theme = readFileSync(join(here, '../../../../packages/markdown/src/code-theme.ts'), 'utf8')

/** Light values the web client draws darker than the package, and why: the stylesheet says. */
const LIGHT_OVERRIDES: Record<string, string> = {
  addition: '#1e6e3e',
  attr: '#76601f',
  attribute: '#76601f',
  property: '#76601f'
}

/** The grounds a message sits on (`ui/theme.css`), and the text colour over them. */
const GROUNDS = {
  light: { text: '#1d1d1f', grounds: { bubble: '#f4f5f8', page: '#ffffff' } },
  dark: { text: '#f5f5f7', grounds: { bubble: '#16181d', page: '#0c0d10' } }
} as const

/** The keys of one palette object in `code-theme.ts`. */
function paletteKeys(name: string): string[] {
  const body = theme.split(`const ${name}`)[1]?.split('}')[0] ?? ''

  return [...body.matchAll(/'?([\w-]+)'?: '#[0-9A-Fa-f]{6}'/g)].map(match => match[1] as string)
}

/** The custom properties of the rule whose selector is exactly `selector`. */
function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  const vars: Record<string, string> = {}

  for (const declaration of (match?.[1] ?? '').split(';')) {
    const colon = declaration.indexOf(':')

    if (colon > 0) {
      vars[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
    }
  }

  return vars
}

const property = (scope: string): string => `--md-hl-${scope.replaceAll('_', '-')}`

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')

  return [0, 2, 4].map(at => parseInt(value.slice(at, at + 2), 16)) as [number, number, number]
}

function luminance([red, green, blue]: [number, number, number]): number {
  const channel = (value: number): number => {
    const unit = value / 255

    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]

  return (light + 0.05) / (dark + 0.05)
}

/** `color-mix(in srgb, text 7%, ground)`, which is what `--md-code-surface` paints over a ground. */
function surface(text: string, ground: string): [number, number, number] {
  const [t, g] = [rgb(text), rgb(ground)]

  return t.map((value, index) => value * 0.07 + (g[index] as number) * 0.93) as [number, number, number]
}

const LIGHT = declarations('.md')
const DARK_FOLLOWING = declarations(':root:not([data-scheme]) .md')
const DARK_CHOSEN = declarations(":root[data-scheme='dark'] .md")

describe('the highlighting palette', () => {
  it('has a scope for every colour of the package, and nothing else', () => {
    expect(paletteKeys('LIGHT').sort()).toEqual([...HIGHLIGHT_SCOPES].sort())
    expect(paletteKeys('DARK').sort()).toEqual([...HIGHLIGHT_SCOPES].sort())
  })

  it.each(HIGHLIGHT_SCOPES)('%s: a class that reads its property, and the package colours in both schemes', scope => {
    expect(css).toContain(`.md .md-hl-${scope.replaceAll('_', '-')} {\n  color: var(${property(scope)});\n}`)
    expect(LIGHT[property(scope)]).toBe(LIGHT_OVERRIDES[scope] ?? codeScopeColor(scope, 'light')?.toLowerCase())
    expect(DARK_FOLLOWING[property(scope)]).toBe(codeScopeColor(scope, 'dark')?.toLowerCase())
    expect(DARK_CHOSEN[property(scope)]).toBe(codeScopeColor(scope, 'dark')?.toLowerCase())
  })

  it.each(
    (['light', 'dark'] as const).flatMap(scheme =>
      (['bubble', 'page'] as const).flatMap(ground => HIGHLIGHT_SCOPES.map(scope => [scheme, ground, scope] as const))
    )
  )('%s, on the %s: %s reaches 4.5:1 on the code surface', (scheme, ground, scope) => {
    const values = scheme === 'light' ? LIGHT : DARK_CHOSEN
    const { text, grounds } = GROUNDS[scheme]
    const ratio = contrast(rgb(values[property(scope)] as string), surface(text, grounds[ground]))

    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('names a class only for a scope with a colour, the dotted ones by their first segment', () => {
    expect(scopeClass('keyword')).toBe('md-hl md-hl-keyword')
    expect(scopeClass('built_in')).toBe('md-hl md-hl-built-in')
    expect(scopeClass('title.function')).toBe('md-hl md-hl-title')
    expect(scopeClass('template-variable')).toBeUndefined()
    expect(scopeClass(undefined)).toBeUndefined()
    expect(scopeClass('" onclick="x')).toBeUndefined()
  })
})
