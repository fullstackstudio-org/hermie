/**
 * Contrast on the COMPOSITED surface — the arithmetic, once.
 *
 * `scripts/check-contrast.ts` is the gate that fails a build; the theme editor is
 * a guard that refuses a colour while somebody is typing it. Those have to be the
 * same rule or one of them is lying, and the way to make them the same rule is for
 * them to be the same code. This is that code, and it lives in the app rather than
 * in the script because the app is the side that cannot import a script.
 *
 * Everything is read from the token set. A copy of the palette in a checker is a
 * second palette, and the first thing a second palette does is disagree.
 *
 * The thresholds are WCAG AA: 4.5 : 1 for anything that has to be read as text,
 * 3 : 1 for a mark that only has to be seen — a status dot, an avatar ring.
 */
import { glassFor, bubblesFor, colorsForFace, type ResolvedThemeFace } from './themes'
import {
  DANGER_SOFT,
  darkColors,
  lightColors,
  OK_SOFT,
  TINT_SUNK,
  type BubbleVariant,
  type ColorScale,
  type ElevationScale,
  type GlassVariant,
  type Scheme,
  type TextColorRole
} from './tokens'

export const AA_TEXT = 4.5
export const AA_MARK = 3

export type Rgb = [number, number, number]

/**
 * Inks that carry words. `ok` and `accent` are NOT here: they are FILLS — a status
 * dot, a button — and what has to be readable on one is `onAccent`, which is
 * measured against the outgoing bubble instead.
 *
 * `accentText` is in the list and is now a different colour per THEME, because
 * `colorsForFace` derives it from the theme's accent. That is what makes this a
 * check rather than a formality: a link, a chevron and the navigator's tint all
 * read that role, so a preset whose accent ink is unreadable on its own glass
 * fails here instead of in a screenshot.
 */
export const TEXT_ROLES = [
  'text',
  'textMuted',
  'textFaint',
  'accentText',
  'dangerText',
  'okText',
  'warnText'
] as const satisfies readonly TextColorRole[]

/**
 * Every ink a `Text` can be given is either measured on every surface below or is
 * `onAccent`, which has a row of its own against the bubble it is drawn on.
 *
 * A type rather than a note. `TextColorRole` is what `Text` accepts; adding a
 * role to it without adding it to `TEXT_ROLES` makes this line fail to compile,
 * which is the difference between a table that is complete and a table that
 * happens to be complete today. The owner's Graphite report was the other half of
 * the same hole — a FILL reaching a `Text` — and that half is closed by the type.
 */
type UnmeasuredTextRole = Exclude<TextColorRole, (typeof TEXT_ROLES)[number] | 'onAccent'>

export const EVERY_TEXT_ROLE_IS_MEASURED: [UnmeasuredTextRole] extends [never] ? true : false = true

/** Inks that only have to be SEEN: today that is the cron status dot's fill. */
export const MARK_ROLES = ['ok'] as const

export function parseColor(color: string): { rgb: Rgb; alpha: number } {
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

/** `top` composited over an opaque `bottom`. */
export function over(top: string, bottom: Rgb): Rgb {
  const { rgb, alpha } = parseColor(top)

  return rgb.map((channel, at) => channel * alpha + (bottom[at] ?? 0) * (1 - alpha)) as Rgb
}

function channelLuminance(channel: number): number {
  const scaled = channel / 255

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

export function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue)
}

/** The ratio, rounded to two places, of an ink against an opaque background. */
export function contrastRatio(ink: string, background: Rgb): number {
  const [lighter, darker] = [luminance(parseColor(ink).rgb), luminance(background)].sort((a, b) => b - a) as [
    number,
    number
  ]

  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

export const colorsFor = (scheme: Scheme): ColorScale => (scheme === 'dark' ? darkColors : lightColors)

export interface Surface {
  name: string
  /** The composited background this surface's ink actually sits on. */
  background: Rgb
  /**
   * The inks drawn on this surface, where that is narrower than "any of them".
   *
   * A panel carries whatever a screen puts on it, so it has no list. A CONTROL
   * carries exactly one label and is sized to it, so holding it to every ink in
   * the scale would rule out a colour on the strength of a combination that
   * cannot occur. Only `e4` has one; see `surfacesFor`.
   */
  roles?: readonly TextColorRole[]
}

/**
 * Every surface an ink is drawn on, for one theme face.
 *
 * The glass variants are measured BLURRED — the wash over the background itself,
 * which is the real case on iOS and the harsher of the two; the opaque fallback is
 * strictly easier to read on, so it cannot be what fails. A bubble is not glass
 * (§7.4): it paints its own opaque rung, so the background never reaches its ink.
 */
export function surfacesFor(scheme: Scheme, elevation: ElevationScale, background: string): Surface[] {
  const glass = glassFor(scheme, elevation)
  const bubbles = bubblesFor(scheme, elevation)
  const floor = parseColor(background).rgb
  const out: Surface[] = []

  for (const variant of ['panel', 'sheet', 'card', 'control'] as GlassVariant[]) {
    out.push({ name: variant, background: over(glass[variant].fill, floor) })
  }

  /*
    The two ROW surfaces, which are a wash over a rung rather than over the floor.

    `row` is what a pointer leaves under itself and `rowSelected` is the filled
    pill under the open one — the chat list's selected bot, and since the Settings
    skin the selected category in the sidebar. Both carry a label and a line of
    state, and neither was in this table: a reader could lose the name of the row
    they are standing on and every ratio here would still be green.

    Untinted on purpose. `GlassSurface` takes a `tint` for a CHAT's own colour, and
    what that composites to depends on a colour the reader picked, which is not a
    property of the theme and cannot be floored here. The Settings sidebar
    therefore draws its selected row without one — see `CategoryRow`.
  */
  out.push({ name: 'row', background: over(glass.row.fill, over(elevation.e2, floor)) })
  out.push({ name: 'row selected', background: over(glass.rowSelected.fill, over(elevation.e2s, floor)) })

  for (const variant of ['in', 'inRead', 'dm', 'dmRead'] as BubbleVariant[]) {
    const recipe = bubbles[variant]

    out.push({ name: `bubble ${variant}`, background: over(recipe.fill, parseColor(recipe.solid).rgb) })
  }

  out.push({ name: 'sunk tint', background: over(TINT_SUNK[scheme], over(glass.panel.fill, floor)) })

  /*
    The OPAQUE rungs, which are not glass and were not in this table.

    `elevation.e3c` is the inset card every Settings row sits on, the tool card,
    the error card and the licence list; `e1` and `e2` are the navigator's own
    background and a pressed row, and `e2s` is what a selected row falls back to
    where there is no blur. None of them composite a wash over a wallpaper —
    they are a flat colour — so nothing in the glass loop reaches them, and a role
    could be unreadable on an entire screen with every row here green. That is the
    surface the owner's Graphite report was actually about.

    `e0` is the wallpaper rung and is deliberately absent: `Screen` paints it only
    where there is no panel, and the ink on it comes off the panel above.
  */
  for (const rung of ['e1', 'e2', 'e2s', 'e3', 'e3c'] as const) {
    out.push({ name: `elevation ${rung}`, background: over(elevation[rung], floor) })
  }

  /*
    `e4` is the ladder's top rung and the one surface on it that is not a panel:
    the SELECTED segment of a segmented control (`ui/sheets/controls.tsx`), which
    is a pill the width of its own label. The only ink on it is `text` — an
    unselected segment is transparent and reads off the sunk tint above — so that
    is the only ink measured. Putting another one there without widening this is
    the one gap left, and it is a single call site wide.
  */
  out.push({ name: 'elevation e4', background: over(elevation.e4, floor), roles: ['text'] })

  /*
    The two soft fills, on the surface they are actually used on: a `Deny` button,
    a scheduler-down banner, a locked-answer chip. Each is a low-alpha wash over a
    SHEET with `dangerText` / `okText` on it, and the wash shifts the sheet toward
    the ink's own hue, which is the direction that costs contrast.
  */
  out.push({ name: 'danger tint', background: over(DANGER_SOFT[scheme], over(glass.sheet.fill, floor)) })
  out.push({ name: 'ok tint', background: over(OK_SOFT[scheme], over(glass.sheet.fill, floor)) })

  return out
}

export interface ContrastRow {
  theme: string
  scheme: Scheme
  surface: string
  role: string
  ratio: number
  floor: number
}

/** Every ink against every surface of one theme face. */
export function measureFace(theme: string, scheme: Scheme, face: ResolvedThemeFace): ContrastRow[] {
  const colors = colorsForFace(scheme, face)
  const rows: ContrastRow[] = []

  for (const surface of surfacesFor(scheme, face.elevation, face.background)) {
    const inks = surface.roles ?? [...TEXT_ROLES, ...MARK_ROLES]

    for (const role of inks) {
      rows.push({
        theme,
        scheme,
        surface: surface.name,
        role,
        ratio: contrastRatio(colors[role], surface.background),
        floor: (TEXT_ROLES as readonly string[]).includes(role) ? AA_TEXT : AA_MARK
      })
    }
  }

  /*
    White on the outgoing bubble, and the theme's accent as INK.

    The bubble is the one place a fill's own readability is the question: it is the
    chat's accent and the body on it is `onAccent`, which this round keeps as ONE
    value rather than making it per theme.

    The accent's `fill` is deliberately NOT in this table. It is a ring, a swatch
    and a soft wash — never a background for text — and holding it to a ratio would
    rule out both the Graphite accent on its own dark panel (1.55 : 1) and the
    studio's lime on a white one (1.14 : 1), which are the two accents the themes
    that need them were built around. Where a fill used to sit under white ink, the
    ink now comes off the bubble or is chosen against the fill; see `Composer`'s
    send button, `Button`'s primary and `AccentSwatches`.

    The accent as INK has no row of its own any more, and that is a widening rather
    than a loss: it is `accentText` in `TEXT_ROLES`, so it is measured on every
    surface in the table instead of on the panel alone.
  */
  rows.push({
    theme,
    scheme,
    surface: 'accent bubble',
    role: 'onAccent',
    ratio: contrastRatio(colors.onAccent, parseColor(face.accentSwatch.bubble).rgb),
    floor: AA_TEXT
  })

  return rows
}

/** The three colours a reader may edit on a theme of their own. */
export type ThemeColourField = 'background' | 'accentFill' | 'accentBubble'

export type ColourVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: ThemeColourField; ratio: number; floor: number }

const HEX = /^#[0-9a-f]{6}$/iu

/**
 * Would this colour survive `npm run contrast:check`?
 *
 * The editor asks this per keystroke and the build asks the same question of the
 * whole table, which is why the rule is here and not in either of them. What each
 * field is measured against:
 *
 *  - **background** — the floor, so every ink in `TEXT_ROLES` has to clear AA on
 *    the panel and the sheet composited over it. That is the strictest reading
 *    and it is the right one: a background is not a decoration, it is what all the
 *    words are read on.
 *  - **accentBubble** — white on it, at the text floor, because `onAccent` is one
 *    value for the whole app.
 *  - **accentFill** — nothing. It is a ring, a swatch and a wash, never a
 *    background for text, so there is no AA rule that applies to it. Saying so is
 *    better than inventing a floor: a made-up 3 : 1 here would refuse the studio's
 *    own lime and the Graphite accent that the presets are built on.
 */
export function judgeThemeColour(
  field: ThemeColourField,
  value: string,
  scheme: Scheme,
  face: ResolvedThemeFace
): ColourVerdict {
  if (!HEX.test(value.trim())) {
    return { ok: false, reason: 'malformed' }
  }

  const colour = value.trim()

  if (field === 'accentBubble') {
    const ratio = contrastRatio(colorsFor(scheme).onAccent, parseColor(colour).rgb)

    return ratio >= AA_TEXT ? { ok: true } : { ok: false, reason: field, ratio, floor: AA_TEXT }
  }

  if (field === 'accentFill') {
    // No ratio applies. See the note in `measureFace`: the accent's fill never
    // carries text, and every AA floor is about something that is read.
    return { ok: true }
  }

  const colors = colorsForFace(scheme, face)
  let worst = Number.POSITIVE_INFINITY

  for (const surface of surfacesFor(scheme, face.elevation, colour)) {
    // The same narrowing the table uses, for the same reason: a control that
    // carries one label must not be judged on an ink it never draws.
    for (const role of surface.roles ?? TEXT_ROLES) {
      worst = Math.min(worst, contrastRatio(colors[role], surface.background))
    }
  }

  return worst >= AA_TEXT ? { ok: true } : { ok: false, reason: field, ratio: worst, floor: AA_TEXT }
}
