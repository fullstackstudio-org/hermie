/**
 * The preset model, as the three claims it rests on.
 *
 * `npm run contrast:check` already measures every ink against every surface of
 * every theme and fails a build under 4.5 : 1 — that is the gate, and it is not
 * repeated here. What this pins is the STRUCTURE the gate depends on:
 *
 *  1. a preset is a background, a ladder and an accent, and nothing else is
 *     needed to build a whole token set from it;
 *  2. the derived surfaces really are derived — the native tint is
 *     `withAlpha(solid, α)` and the tail is the bubble's own composite — so
 *     nothing can be tuned in one theme and forgotten in the next;
 *  3. the three dark ladders sit at the SAME luminance rung for rung, which is
 *     the reason one ink set can serve all three and the first thing that would
 *     quietly stop being true if somebody nudged a rung by eye.
 */
import { describe, expect, it } from '@jest/globals'

import {
  bubblesFor,
  colorsForFace,
  compositeHex,
  glassFor,
  resolveThemeFace,
  THEME_PRESET_ORDER,
  THEME_PRESETS,
  type ThemePresetName
} from '../src/ui/themes'
import { ACCENTS, darkColors, withAlpha, type ElevationRung, type Scheme } from '../src/ui/tokens'

const RUNGS: ElevationRung[] = ['e0', 'e1', 'e2', 'e2s', 'e3', 'e3c', 'e3f', 'e4']

const channel = (value: number): number => {
  const scaled = value / 255

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string): number => {
  const raw = hex.replace('#', '')
  const [red, green, blue] = [0, 2, 4].map(at => channel(parseInt(raw.slice(at, at + 2), 16))) as [
    number,
    number,
    number
  ]

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

describe('the preset set', () => {
  it('is Blue, Graphite and Lime, in both schemes', () => {
    expect(THEME_PRESET_ORDER).toEqual(['blue', 'graphite', 'lime'])

    for (const name of THEME_PRESET_ORDER) {
      for (const scheme of ['light', 'dark'] as Scheme[]) {
        const face = THEME_PRESETS[name][scheme]

        expect(face.background).toMatch(/^#[0-9A-F]{6}$/iu)
        expect(face.accent in ACCENTS).toBe(true)

        for (const rung of RUNGS) {
          expect(face.elevation[rung]).toMatch(/^#[0-9A-F]{6}$/iu)
        }
      }
    }
  })

  it('gives each preset its own default accent, so Default follows the theme', () => {
    expect(THEME_PRESETS.blue.dark.accent).toBe('default')
    expect(THEME_PRESETS.graphite.dark.accent).toBe('graphite')
    expect(THEME_PRESETS.lime.dark.accent).toBe('lime')
  })

  it('keeps the three dark ladders at one luminance, rung for rung', () => {
    // The ink set is per scheme, not per theme. A ladder that drifted brighter
    // would take every ratio in the contrast check with it, and the check would
    // then be reporting a number nobody chose.
    for (const rung of RUNGS) {
      const blue = luminance(THEME_PRESETS.blue.dark.elevation[rung])

      for (const name of ['graphite', 'lime'] as ThemePresetName[]) {
        const other = luminance(THEME_PRESETS[name].dark.elevation[rung])

        expect(Math.abs(other - blue) / blue).toBeLessThan(0.03)
      }
    }
  })
})

describe('what a preset does NOT have to carry', () => {
  it('derives the native glass tint as the rung at an alpha', () => {
    for (const name of THEME_PRESET_ORDER) {
      const { elevation } = THEME_PRESETS[name].dark
      const glass = glassFor('dark', elevation)

      expect(glass.panel.nativeTint).toBe(withAlpha(glass.panel.solid, 0.8))
      expect(glass.sheet.nativeTint).toBe(withAlpha(glass.sheet.solid, 0.92))
      // Light has no tint to hand over: `UIGlassEffect` is left to the platform.
      expect(glassFor('light', THEME_PRESETS[name].light.elevation).panel.nativeTint).toBeUndefined()
    }
  })

  it('derives a bubble tail as the bubble it has to meet', () => {
    for (const name of THEME_PRESET_ORDER) {
      for (const scheme of ['light', 'dark'] as Scheme[]) {
        const bubbles = bubblesFor(scheme, THEME_PRESETS[name][scheme].elevation)

        for (const variant of ['in', 'inRead', 'dm', 'dmRead'] as const) {
          const recipe = bubbles[variant]

          expect(recipe.tail).toBe(compositeHex(recipe.fill, recipe.solid))
        }
      }
    }
  })
})

describe('a theme of the reader’s own', () => {
  const user = {
    id: 't1',
    name: 'Studio',
    base: 'graphite' as const,
    dark: { background: '#101112', accentFill: '#C7FF4A' }
  }

  it('follows its base for everything it does not override', () => {
    const face = resolveThemeFace({ kind: 'user', id: 't1' }, 'dark', [user])

    expect(face.background).toBe('#101112')
    expect(face.accentSwatch.fill).toBe('#C7FF4A')
    // Not overridden, so still Graphite's.
    expect(face.accentSwatch.bubble).toBe(ACCENTS.graphite.bubble)
    expect(face.elevation).toEqual(THEME_PRESETS.graphite.dark.elevation)
  })

  it('leaves the other face alone', () => {
    const face = resolveThemeFace({ kind: 'user', id: 't1' }, 'light', [user])

    expect(face.background).toBe(THEME_PRESETS.graphite.light.background)
  })

  it('falls back to a readable window when the theme is gone', () => {
    // A theme deleted on a second device leaves a choice pointing at nothing.
    // Painting nothing is not an option; painting the default is.
    const face = resolveThemeFace({ kind: 'user', id: 'missing' }, 'dark', [])

    expect(face.background).toBe(THEME_PRESETS.blue.dark.background)
  })
})

/**
 * The accent roles are the THEME's accent.
 *
 * `colors.accent` and `colors.accentText` used to be one blue per scheme however
 * the window was coloured, and everything that draws the accent as a fill or as
 * ink reads one of those two roles: `Text color="accentText"`, a markdown link,
 * the back chevron, the navigator's tint. So under Lime the window was lime and
 * the words in it were blue. These pin the derivation rather than the values, so
 * a fourth preset is covered the day it is added.
 */
describe('the accent roles follow the theme', () => {
  for (const name of THEME_PRESET_ORDER) {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      it(`${name} / ${scheme} resolves both accent roles from the preset's own accent`, () => {
        const face = resolveThemeFace({ kind: 'preset', name }, scheme)
        const colors = colorsForFace(scheme, face)
        const swatch = ACCENTS[THEME_PRESETS[name][scheme].accent]

        expect(colors.accent).toBe(swatch.fill)
        expect(colors.accentText).toBe(swatch.text[scheme])
      })
    }
  }

  it('leaves every role that is not the accent alone', () => {
    const face = resolveThemeFace({ kind: 'preset', name: 'lime' }, 'dark')
    const colors = colorsForFace('dark', face)

    for (const role of Object.keys(darkColors) as (keyof typeof darkColors)[]) {
      if (role !== 'accent' && role !== 'accentText') {
        expect(colors[role]).toBe(darkColors[role])
      }
    }
  })

  it('takes a user theme’s own accent fill, and keeps the ink readable', () => {
    const face = resolveThemeFace({ kind: 'user', id: 'mine' }, 'light', [
      { id: 'mine', name: 'Mine', base: 'graphite', light: { accentFill: '#123456' } }
    ])

    expect(colorsForFace('light', face).accent).toBe('#123456')
    expect(colorsForFace('light', face).accentText).toBe(ACCENTS.graphite.text.light)
  })
})
