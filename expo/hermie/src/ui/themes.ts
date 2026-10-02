/**
 * Themes: the part of the token set that a reader is allowed to choose.
 *
 * `tokens.ts` holds everything that is the same whatever theme is on — the type
 * scale, the spacing, the ink roles, the per-chat accent swatches. This file
 * holds the rest, and the split is the point: a theme is a SMALL amount of data,
 * and everything else about a surface falls out of it.
 *
 * ### A preset is three things
 *
 * A preset, per scheme, is a **background**, an **elevation ladder** and a
 * **default accent**. Nothing else is stored, because nothing else has to be:
 *
 *  - every glass surface is a per-scheme wash over a rung of that ladder, so
 *    `glassFor` composes the two;
 *  - a native Liquid Glass tint is the rung at an alpha — `withAlpha(solid, α)`,
 *    which is the relation the hand-written dark tints already satisfied to the
 *    byte before they were derived;
 *  - a bubble is the same idea (§7.4: a bubble is not a `GlassSurface`), and its
 *    TAIL is the bubble's own composite, which with flat fills is exact rather
 *    than approximate — the hand-tuned tail colours were leftovers from the
 *    two-stop gradients that were removed a round ago.
 *
 * So adding a theme is adding a background, eight rungs and one accent name, and
 * there is no second place for it to be half-added.
 *
 * ### `theme.wallpaper` is still the surface
 *
 * The floor a preset names reaches the app as `theme.wallpaper.fill`, unchanged.
 * That is not nostalgia: `Wallpaper` paints it, every glass recipe composites
 * against it and the contrast check measures against it, and renaming the one
 * field they share would have been a diff across the whole app to say the same
 * thing.
 *
 * ### What was retired
 *
 * `warm` and `slate` were wallpapers, and the set is presets now: Blue, Graphite
 * and Lime in both schemes. Graphite absorbs what Slate was FOR — a matte,
 * desaturated composition whose panels sit a step above their floor rather than a
 * chasm above it — at a neutral grey rather than a grey-blue, which is what makes
 * it the counterpart to Blue rather than a second Blue. The `slate` and
 * `graphite` ACCENT swatches are untouched: they are per-chat colours, and a
 * conversation's colour was never a function of the wallpaper.
 */
import {
  ACCENTS,
  darkColors,
  lightColors,
  withAlpha,
  type AccentName,
  type AccentSwatch,
  type BubbleRecipe,
  type BubbleVariant,
  type ColorScale,
  type ElevationScale,
  type GlassRecipe,
  type GlassScale,
  type GlassVariant,
  type Scheme
} from './tokens'

export type ThemePresetName = 'blue' | 'graphite' | 'lime'

/** One preset, for one scheme. */
export interface PresetFace {
  /** The floor. One flat colour — the Liquid Glass direction has no gradients. */
  background: string
  /** The opaque ladder every surface on this floor composites onto or falls back to. */
  elevation: ElevationScale
  /** What "Default" resolves to while this preset is on. */
  accent: AccentName
}

export type PresetSpec = Record<Scheme, PresetFace>

/**
 * Blue, light: the palest end of the original ramp, and the ladder Part 1 shipped.
 */
const BLUE_LIGHT: ElevationScale = {
  e0: '#DCE8FB',
  e1: '#F4F8FE',
  e2: '#EAF1FC',
  e2s: '#E2EDFD',
  e3: '#FFFFFF',
  e3c: '#F7FAFE',
  e3f: '#FDFEFF',
  e4: '#FFFFFF'
}

/**
 * Blue, dark: the ladder every dark ink in `tokens.ts` was calibrated against.
 *
 * It is the reference the other two dark ladders are built to MATCH in luminance
 * rung for rung, which is what lets one ink set serve all three — see the note on
 * `GRAPHITE_DARK`.
 */
const BLUE_DARK: ElevationScale = {
  e0: '#0A1830',
  e1: '#1C2A45',
  e2: '#28385A',
  e2s: '#334670',
  e3: '#3E5480',
  e3c: '#2F4066',
  e3f: '#425A88',
  e4: '#50699A'
}

const GRAPHITE_LIGHT: ElevationScale = {
  e0: '#E4E6EA',
  e1: '#F7F8FA',
  e2: '#EFF1F4',
  e2s: '#E8EAEE',
  e3: '#FFFFFF',
  e3c: '#F9FAFB',
  e3f: '#FEFEFF',
  e4: '#FFFFFF'
}

/**
 * Graphite, dark: the same ladder with the blue taken out.
 *
 * Every rung sits within about one percent of the Blue rung it replaces, and that
 * is a constraint rather than a coincidence. The ink set (`darkColors`) is NOT
 * per theme — the briefing for this round is explicit that `onAccent` in
 * particular stays one value — so a ladder that drifted brighter would take every
 * ratio in `npm run contrast:check` with it. The rungs were computed from Blue's
 * relative luminance and then given a whisper of cool cast back, small enough that
 * the green channel, which carries 72 % of the luminance, barely moves.
 */
const GRAPHITE_DARK: ElevationScale = {
  e0: '#17181A',
  e1: '#282A2E',
  e2: '#36393F',
  e2s: '#444750',
  e3: '#50545D',
  e3c: '#3E4149',
  e3f: '#565A64',
  e4: '#656974'
}

const LIME_LIGHT: ElevationScale = {
  e0: '#E6EFD3',
  e1: '#F8FBF1',
  e2: '#F0F5E5',
  e2s: '#E9F0DA',
  e3: '#FFFFFF',
  e3c: '#FAFCF5',
  e3f: '#FEFFFB',
  e4: '#FFFFFF'
}

/** Lime, dark: the Graphite ladder pushed toward the lime, at the same values. */
const LIME_DARK: ElevationScale = {
  e0: '#141A0D',
  e1: '#252D18',
  e2: '#323C20',
  e2s: '#404B2A',
  e3: '#4C5932',
  e3c: '#3A4525',
  e3f: '#525F36',
  e4: '#606E40'
}

export const THEME_PRESETS: Record<ThemePresetName, PresetSpec> = {
  blue: {
    light: { background: '#EAF3FF', elevation: BLUE_LIGHT, accent: 'default' },
    dark: { background: '#070F1D', elevation: BLUE_DARK, accent: 'default' }
  },
  /**
   * Graphite's dark floor is deliberately NOT near-black.
   *
   * `#2E3138` is around five times the luminance of Blue's `#070F1D`, and that is
   * the whole difference between the two compositions: on a near-black floor every
   * panel is a pale shape floating in the dark and the loudest thing on screen is
   * the gap between the window and its contents, whereas here the panels sit one
   * step above their background and the window reads as one matte grey object.
   * That rendering is the one the owner picked when it was called Slate; it is
   * neutral now, which is what makes it Blue's counterpart rather than a second
   * Blue.
   */
  graphite: {
    light: { background: '#F0F1F3', elevation: GRAPHITE_LIGHT, accent: 'graphite' },
    dark: { background: '#2E3138', elevation: GRAPHITE_DARK, accent: 'graphite' }
  },
  lime: {
    light: { background: '#F3FAE4', elevation: LIME_LIGHT, accent: 'lime' },
    dark: { background: '#0B1206', elevation: LIME_DARK, accent: 'lime' }
  }
}

export const THEME_PRESET_ORDER: readonly ThemePresetName[] = ['blue', 'graphite', 'lime']

export const DEFAULT_THEME_PRESET: ThemePresetName = 'blue'

export const isThemePresetName = (value: unknown): value is ThemePresetName =>
  typeof value === 'string' && (THEME_PRESET_ORDER as readonly string[]).includes(value)

/**
 * A theme a reader made, stored app-wide (ADR-0016's `hermie-app` section).
 *
 * It is a preset plus a small number of overrides per SCHEME, and it is stored
 * that way rather than as a full palette for one reason: a theme has a light face
 * and a dark face, and a reader editing one of them in the evening must not wake
 * up to a light face nobody chose. Everything not overridden keeps following the
 * preset, so a preset that improves improves every theme built on it.
 */
export interface UserThemeFace {
  /** The floor. */
  background?: string
  /** The accent's solid fill: rings, swatches, the send button. */
  accentFill?: string
  /** The outgoing bubble. `onAccent` — white — has to stay readable on it. */
  accentBubble?: string
}

export interface UserTheme {
  id: string
  name: string
  base: ThemePresetName
  light?: UserThemeFace
  dark?: UserThemeFace
}

/** What is on: a preset by name, or one of the reader's own themes by id. */
export type ThemeChoice = { kind: 'preset'; name: ThemePresetName } | { kind: 'user'; id: string }

export const DEFAULT_THEME_CHOICE: ThemeChoice = { kind: 'preset', name: DEFAULT_THEME_PRESET }

/** One theme resolved for one scheme: everything `buildTheme` needs and no more. */
export interface ResolvedThemeFace {
  background: string
  elevation: ElevationScale
  /** The name the default accent goes by, for a picker that wants to say it. */
  accentName: AccentName
  /** The swatch itself, which a user theme may have replaced parts of. */
  accentSwatch: AccentSwatch
}

/**
 * Resolve a choice against the themes that exist.
 *
 * A user theme whose id is not in the list resolves to its base preset, and a
 * choice naming nothing at all resolves to the default: a theme deleted on one
 * device must leave the other one with a window it can still read, not with a
 * blank one.
 */
export function resolveThemeFace(
  choice: ThemeChoice | undefined,
  scheme: Scheme,
  userThemes: readonly UserTheme[] = []
): ResolvedThemeFace {
  const user = choice?.kind === 'user' ? userThemes.find(theme => theme.id === choice.id) : undefined
  const presetName = user?.base ?? (choice?.kind === 'preset' ? choice.name : DEFAULT_THEME_PRESET)
  const preset = THEME_PRESETS[isThemePresetName(presetName) ? presetName : DEFAULT_THEME_PRESET][scheme]
  const face = user?.[scheme]
  const base = ACCENTS[preset.accent] ?? ACCENTS.default

  return {
    background: face?.background ?? preset.background,
    elevation: preset.elevation,
    accentName: preset.accent,
    accentSwatch: {
      fill: face?.accentFill ?? base.fill,
      bubble: face?.accentBubble ?? base.bubble,
      text: base.text
    }
  }
}

/**
 * The ink scale for one theme face: the scheme's roles, with the two accent roles
 * replaced by the theme's own.
 *
 * `accent` and `accentText` in `tokens.ts` are one blue per scheme, and they were
 * read directly by every `Text color="accent"`, every link, the back chevron and
 * the navigator's tint — so under Lime the window was lime and the words in it
 * were blue. They are not a third thing beside a preset's accent; they ARE the
 * preset's accent, seen as a fill and as ink, which is why they are derived here
 * rather than stored twice.
 *
 * It is one function because two callers need the same answer: the theme every
 * surface reads, and the contrast check that decides whether the answer is
 * legible. A second copy of this merge in the checker would be a checker that
 * measures a palette the app does not draw.
 *
 * A chat that carries its OWN colour is untouched — that is `theme.accent(name)`,
 * and a conversation's colour was never a function of the window it is in.
 */
export function colorsForFace(scheme: Scheme, face: ResolvedThemeFace): ColorScale {
  return {
    ...(scheme === 'dark' ? darkColors : lightColors),
    accent: face.accentSwatch.fill,
    accentText: face.accentSwatch.text[scheme]
  }
}

/**
 * The per-scheme half of a glass recipe: the wash, the hairline, and the alpha the
 * native material's tint is the rung at.
 *
 * `nativeTint` is dark-only, exactly as the hand-written table was: on a light
 * scheme `UIGlassEffect` is left to its own devices, which is what the platform
 * material is for.
 */
interface GlassWash {
  fill: string
  blurIntensity: number
  hairline: string
  /** Alpha for `withAlpha(solid, α)`. Absent means no tint is handed over. */
  tintAlpha?: number
}

const LIGHT_WASH: Record<GlassVariant, GlassWash> = {
  panel: { fill: 'rgba(255,255,255,0.48)', blurIntensity: 80, hairline: 'rgba(16,38,78,0.08)' },
  float: { fill: 'rgba(255,255,255,0.58)', blurIntensity: 60, hairline: 'rgba(16,38,78,0.08)' },
  sheet: { fill: 'rgba(255,255,255,0.72)', blurIntensity: 95, hairline: 'rgba(16,38,78,0.08)' },
  card: { fill: 'rgba(255,255,255,0.52)', blurIntensity: 50, hairline: 'rgba(16,38,78,0.08)' },
  row: { fill: 'rgba(255,255,255,0.34)', blurIntensity: 0, hairline: 'transparent' },
  rowSelected: { fill: 'rgba(255,255,255,0.52)', blurIntensity: 0, hairline: 'rgba(16,38,78,0.08)' },
  control: { fill: 'rgba(255,255,255,0.58)', blurIntensity: 45, hairline: 'rgba(16,38,78,0.08)' },
  chip: { fill: 'rgba(255,255,255,0.52)', blurIntensity: 0, hairline: 'rgba(16,38,78,0.08)' }
}

const DARK_WASH: Record<GlassVariant, GlassWash> = {
  panel: { fill: 'rgba(255,255,255,0.03)', blurIntensity: 80, hairline: 'rgba(190,212,255,0.13)', tintAlpha: 0.8 },
  float: { fill: 'rgba(255,255,255,0.05)', blurIntensity: 60, hairline: 'rgba(190,212,255,0.13)', tintAlpha: 0.74 },
  sheet: { fill: 'rgba(255,255,255,0.04)', blurIntensity: 95, hairline: 'rgba(190,212,255,0.13)', tintAlpha: 0.92 },
  card: { fill: 'rgba(255,255,255,0.035)', blurIntensity: 50, hairline: 'rgba(190,212,255,0.13)', tintAlpha: 0.86 },
  row: { fill: 'rgba(255,255,255,0.07)', blurIntensity: 0, hairline: 'transparent' },
  rowSelected: { fill: 'rgba(255,255,255,0.06)', blurIntensity: 0, hairline: 'rgba(190,212,255,0.13)' },
  control: { fill: 'rgba(255,255,255,0.05)', blurIntensity: 45, hairline: 'rgba(190,212,255,0.13)', tintAlpha: 0.7 },
  chip: { fill: 'rgba(255,255,255,0.12)', blurIntensity: 0, hairline: 'rgba(190,212,255,0.13)' }
}

/** Which rung each variant collapses to where there is no blur. */
const GLASS_RUNG: Record<GlassVariant, keyof ElevationScale> = {
  panel: 'e1',
  float: 'e3f',
  sheet: 'e2s',
  card: 'e3c',
  row: 'e2',
  rowSelected: 'e2s',
  control: 'e4',
  chip: 'e4'
}

/**
 * The glass scale for one scheme over one ladder.
 *
 * Light's sheet collapses to `e3` rather than to `e2s`, which is the one place the
 * two schemes disagree about a rung and the reason the table is not simply
 * `GLASS_RUNG` for both: a light sheet is the brightest surface in the app and
 * `e2s` in light is a tint, not a card.
 */
export function glassFor(scheme: Scheme, elevation: ElevationScale): GlassScale {
  const wash = scheme === 'dark' ? DARK_WASH : LIGHT_WASH
  const out = {} as GlassScale

  for (const variant of Object.keys(wash) as GlassVariant[]) {
    const recipe = wash[variant]
    const rung = scheme === 'light' && variant === 'sheet' ? 'e3' : GLASS_RUNG[variant]
    const solid = elevation[rung]

    const built: GlassRecipe = {
      fill: recipe.fill,
      solid,
      blurIntensity: recipe.blurIntensity,
      hairline: recipe.hairline,
      ...(recipe.tintAlpha === undefined ? {} : { nativeTint: withAlpha(solid, recipe.tintAlpha) })
    }

    out[variant] = built
  }

  return out
}

/**
 * Bubbles. Four variants, and only two of them follow the ladder.
 *
 * `in` / `inRead` are the bot's own speech and belong to the theme, so they are
 * the scheme's wash over the theme's `e3`. `dm` / `dmRead` are bot-to-bot, and
 * the violet in them is not decoration — it is what says "this is not addressed to
 * you" at a glance, in every theme. So the dispatch bubble keeps a fixed solid per
 * scheme while its wash follows the scheme like the rest.
 *
 * The TAIL is derived rather than tuned: with the gradients gone, a bubble is one
 * flat wash over one opaque colour, and the tail has to be exactly that composite
 * or the seam shows. `compositeHex` is that composite.
 */
export const DM_SOLID: Record<Scheme, string> = { light: '#FFFFFF', dark: '#413470' }

interface BubbleWash {
  in: string
  inRead: string
  dm: string
  dmRead: string
}

const LIGHT_BUBBLE_WASH: BubbleWash = {
  in: 'rgba(244,248,255,0.64)',
  inRead: 'rgba(243,247,255,0.88)',
  dm: 'rgba(235,229,253,0.80)',
  dmRead: 'rgba(235,229,253,0.94)'
}

const DARK_BUBBLE_WASH: BubbleWash = {
  in: 'rgba(255,255,255,0.035)',
  inRead: 'rgba(255,255,255,0.03)',
  dm: 'rgba(140,110,255,0.08)',
  dmRead: 'rgba(140,110,255,0.07)'
}

export function bubblesFor(scheme: Scheme, elevation: ElevationScale): Record<BubbleVariant, BubbleRecipe> {
  const wash = scheme === 'dark' ? DARK_BUBBLE_WASH : LIGHT_BUBBLE_WASH
  const dm = DM_SOLID[scheme]
  const own = elevation.e3

  const recipe = (fill: string, solid: string): BubbleRecipe => ({
    fill,
    solid,
    tail: compositeHex(fill, solid)
  })

  return {
    in: recipe(wash.in, own),
    inRead: recipe(wash.inRead, own),
    dm: recipe(wash.dm, dm),
    dmRead: recipe(wash.dmRead, dm)
  }
}

type Rgb = [number, number, number]

function parseColor(color: string): { rgb: Rgb; alpha: number } {
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(color)

  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4])
    }
  }

  const hex = color.replace('#', '')
  const full = hex.length === 3 ? [...hex].map(char => char + char).join('') : hex

  return { rgb: [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16)) as Rgb, alpha: 1 }
}

/** `top` composited over `bottom`, as `#RRGGBB`. Both may be `rgba()` or hex. */
export function compositeHex(top: string, bottom: string): string {
  const over = parseColor(top)
  const under = parseColor(bottom)
  const channel = (at: 0 | 1 | 2): string =>
    Math.round(over.rgb[at] * over.alpha + under.rgb[at] * (1 - over.alpha))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()

  return `#${channel(0)}${channel(1)}${channel(2)}`
}
