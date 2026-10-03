// @vitest-environment node
/**
 * The theme's colours, measured. jsdom has no layout, so axe cannot compute
 * contrast there; this reads `theme.css` itself, resolves the custom
 * properties the way the cascade would for every scheme and tint, and holds
 * every pair the client draws to WCAG 2.2: 4.5:1 for text, 3:1 for the shapes
 * that carry state.
 *
 * It does not need a browser, and it cannot drift from the stylesheet because
 * it reads it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TINTS } from '../state/settings'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'theme.css'), 'utf8')

interface Rule {
  media: string
  selector: string
  vars: Record<string, string>
}

/** Every rule that declares a custom property, with the media query it sits in. */
function parse(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const stack: { media?: string; selector?: string }[] = []
  let buffer = ''

  for (const char of text) {
    if (char === '{') {
      const head = buffer.trim()

      buffer = ''
      stack.push(head.startsWith('@media') ? { media: head } : { selector: head })
    } else if (char === '}') {
      const top = stack.pop()
      const media = stack.map(entry => entry.media ?? '').join(' ')

      if (top?.selector !== undefined) {
        const vars: Record<string, string> = {}

        for (const declaration of buffer.split(';')) {
          const colon = declaration.indexOf(':')

          if (colon > 0 && declaration.trim().startsWith('--')) {
            vars[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
          }
        }

        if (Object.keys(vars).length) {
          for (const selector of top.selector.split(',')) {
            rules.push({ media, selector: selector.trim(), vars })
          }
        }
      }

      buffer = ''
    } else {
      buffer += char
    }
  }

  return rules
}

const RULES = parse(css)

interface State {
  scheme: 'system' | 'light' | 'dark'
  osDark: boolean
  contrast: boolean
  tint: string
}

function mediaMatches(media: string, state: State): boolean {
  if (!media) {
    return true
  }

  return (
    (!media.includes('prefers-color-scheme: dark') || state.osDark) &&
    (!media.includes('prefers-contrast: more') || state.contrast) &&
    !media.includes('prefers-reduced-motion')
  )
}

/** Specificity as the number of `:root`s plus the number of attribute selectors. */
const specificity = (selector: string): number =>
  (selector.match(/:root/g)?.length ?? 0) + (selector.match(/\[/g)?.length ?? 0)

function selectorMatches(selector: string, state: State): boolean {
  const scheme = /\[data-scheme='(\w+)'\]/.exec(selector)?.[1]
  const tint = /\[data-tint='(\w+)'\]/.exec(selector)?.[1]

  if (selector.includes(':not([data-scheme])')) {
    return state.scheme === 'system'
  }

  return (!scheme || state.scheme === scheme) && (!tint || state.tint === tint)
}

/** The custom properties the cascade leaves on the root for `state`. */
function cascade(state: State): Record<string, string> {
  const winners: Record<string, { specificity: number; order: number; value: string }> = {}

  RULES.forEach((rule, order) => {
    if (!mediaMatches(rule.media, state) || !selectorMatches(rule.selector, state)) {
      return
    }

    for (const [name, value] of Object.entries(rule.vars)) {
      const mine = { specificity: specificity(rule.selector), order, value }
      const held = winners[name]

      if (
        !held ||
        mine.specificity > held.specificity ||
        (mine.specificity === held.specificity && order > held.order)
      ) {
        winners[name] = mine
      }
    }
  })

  return Object.fromEntries(Object.entries(winners).map(([name, winner]) => [name, winner.value]))
}

type Rgb = [number, number, number]

const hex = (value: string): Rgb => {
  const digits = value.replace('#', '')

  return [0, 2, 4].map(at => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb
}

const blend = (top: Rgb, bottom: Rgb, share: number): Rgb =>
  top.map((channel, at) => channel * share + bottom[at]! * (1 - share)) as Rgb

/** Resolve a value to a colour: a hex, `var()` of one, or `color-mix(in srgb, A p%, B)`. */
function colour(value: string, vars: Record<string, string>): Rgb {
  const trimmed = value.trim()
  const reference = /^var\((--[\w-]+)\)$/.exec(trimmed)

  if (reference) {
    const next = vars[reference[1]!]

    if (next === undefined) {
      throw new Error(`${reference[1]} is not defined`)
    }

    return colour(next, vars)
  }

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/.exec(trimmed)

  if (mix) {
    return blend(colour(mix[1]!, vars), colour(mix[3]!, vars), Number(mix[2]) / 100)
  }

  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return hex(trimmed)
  }

  throw new Error(`cannot read "${value}" as a colour`)
}

const luminance = ([r, g, b]: Rgb): number => {
  const [lr, lg, lb] = [r, g, b].map(channel => {
    const unit = channel / 255

    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }) as Rgb

  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

const ratio = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]

  return (light + 0.05) / (dark + 0.05)
}

const WHITE: Rgb = [255, 255, 255]

const STATES: { name: string; state: Omit<State, 'tint'> }[] = [
  { name: 'light', state: { scheme: 'light', osDark: false, contrast: false } },
  { name: 'light, browser dark', state: { scheme: 'light', osDark: true, contrast: false } },
  { name: 'dark', state: { scheme: 'dark', osDark: false, contrast: false } },
  { name: 'system, browser light', state: { scheme: 'system', osDark: false, contrast: false } },
  { name: 'system, browser dark', state: { scheme: 'system', osDark: true, contrast: false } },
  { name: 'light, more contrast', state: { scheme: 'light', osDark: false, contrast: true } },
  { name: 'system dark, more contrast', state: { scheme: 'system', osDark: true, contrast: true } }
]

describe('the theme’s custom properties', () => {
  it('declares a block for every tint the settings store offers', () => {
    for (const tint of TINTS) {
      if (tint !== 'blue') {
        expect(css, tint).toContain(`:root[data-tint='${tint}']`)
      }
    }
  })

  it('gives the dark values once under the media query and once under the attribute, and they agree', () => {
    const chosen = cascade({ scheme: 'dark', osDark: false, contrast: false, tint: 'blue' })
    const followed = cascade({ scheme: 'system', osDark: true, contrast: false, tint: 'blue' })

    expect(Object.keys(chosen).sort()).toEqual(Object.keys(followed).sort())

    for (const name of Object.keys(chosen)) {
      expect(followed[name], name).toBe(chosen[name])
    }

    // And the two differ from light, so the comparison above is not vacuous.
    expect(cascade({ scheme: 'light', osDark: false, contrast: false, tint: 'blue' })['--hm-bg']).not.toBe(
      chosen['--hm-bg']
    )
  })

  it('pins a scheme whatever the browser prefers', () => {
    const light = cascade({ scheme: 'light', osDark: true, contrast: false, tint: 'blue' })
    const plain = cascade({ scheme: 'light', osDark: false, contrast: false, tint: 'blue' })

    expect(light['--hm-bg']).toBe(plain['--hm-bg'])
  })
})

describe.each(STATES)('contrast, $name', ({ state }) => {
  for (const tint of TINTS) {
    it(`holds for the ${tint} tint`, () => {
      const vars = cascade({ ...state, tint })
      const at = (name: string): Rgb => colour(`var(${name})`, vars)
      const failures: string[] = []
      const require = (label: string, foreground: Rgb, background: Rgb, floor: number): void => {
        const found = ratio(foreground, background)

        if (found < floor) {
          failures.push(`${label}: ${found.toFixed(2)} < ${floor}`)
        }
      }

      for (const ground of ['--hm-bg', '--hm-surface', '--hm-selected']) {
        require(`text on ${ground}`, at('--hm-text'), at(ground), 4.5)
        require(`muted on ${ground}`, at('--hm-text-muted'), at(ground), 4.5)
        require(`faint on ${ground}`, at('--hm-text-faint'), at(ground), 4.5)
      }

      for (const ground of ['--hm-bg', '--hm-surface']) {
        require(`tint ink on ${ground}`, at('--hm-tint-text'), at(ground), 4.5)
        require(`warn ink on ${ground}`, at('--hm-warn-text'), at(ground), 4.5)
        require(`danger ink on ${ground}`, at('--hm-danger-text'), at(ground), 4.5)
      }

      require('on-tint on tint', at('--hm-on-tint'), at('--hm-tint'), 4.5)

      for (const bead of ['online', 'working', 'needs-input', 'offline']) {
        for (const ground of ['--hm-surface', '--hm-selected', '--hm-bg']) {
          require(`${bead} bead on ${ground}`, at(`--hm-presence-${bead}`), at(ground), 3)
        }
      }

      for (let index = 0; index < 8; index += 1) {
        require(`initials on avatar ${index}`, WHITE, at(`--hm-avatar-${index}`), 4.5)
      }

      expect(failures).toEqual([])
    })
  }
})
