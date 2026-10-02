// Design tokens. Everything visual resolves through here so that the compact
// and regular shells cannot drift apart, and so a future theme is a data change.
//
// The values are the Liquid Glass direction from `design/liquid-glass-tokens.md`
// and `design/liquid-glass.html`: floating glass panels over a coloured
// wallpaper, a dark elevation ladder whose rungs are measurably apart, and blue
// bubble shades deliberately deeper than the platform default so white body text
// keeps AA contrast.
//
// Two things in here are not decoration and should not be "tidied":
//
//  - The dark rungs (`elevation`) are what the solid fallback falls back TO. A
//    platform with no blur composites the same hierarchy out of flat colours, so
//    a card on a panel on a wallpaper is still three distinguishable tones.
//  - `danger` is the FILL and `dangerText` is the readable one. They are not
//    interchangeable and a `Text` always wants the second: the fill is chosen to
//    carry white, so as ink on glass it fails AA in light mode. The Part-1
//    aliases that blurred the two (and eight other Messenger-era colour names,
//    and five older type names) are gone — see the CHANGELOG for the mapping.

export type Scheme = 'light' | 'dark'

/**
 * The colour roles a `Text` can ask for by name.
 *
 * Exactly §1.1 of the token document, and nothing else. A surface colour is not
 * in here on purpose: it comes off the elevation ladder or a glass recipe, which
 * is what keeps a component from inventing a rung.
 */
export type ColorRole =
  | 'text'
  | 'textMuted'
  | 'textFaint'
  | 'onAccent'
  | 'accent'
  | 'accentText'
  | 'danger'
  | 'dangerText'
  | 'ok'
  | 'okText'
  | 'warnText'

export type ColorScale = Record<ColorRole, string>

/**
 * The subset a `Text` may be given.
 *
 * `accent`, `danger` and `ok` are FILLS — a send button, a status dot, a
 * destructive border — and they have no contrast floor of their own: the
 * Graphite accent sits at 1.55 : 1 on its own dark panel, which is correct for a
 * swatch and unreadable as a word. Every one of them has a floored `…Text`
 * sibling, and that sibling is what `scripts/check-contrast.ts` measures.
 *
 * This type is the whole of the guarantee. The Settings rows that the owner
 * reported as unreadable in Graphite — Sign out, Advanced, Licences — were
 * `<Text color="accent">`, which the check could not see because `accent` is not
 * an ink. Naming one here is now a type error rather than a screenshot.
 */
export type TextColorRole = Exclude<ColorRole, 'accent' | 'danger' | 'ok'>

export const lightColors: ColorScale = {
  text: '#12151C',
  textMuted: '#4B5462',
  textFaint: '#586171',
  onAccent: '#FFFFFF',
  accent: '#1668E3',
  accentText: '#0B57C4',
  danger: '#C0293A',
  dangerText: '#A81F30',
  ok: '#1C8547',
  okText: '#116038',
  warnText: '#865600'
}

export const darkColors: ColorScale = {
  text: '#F3F6FB',
  textMuted: '#C8D2E0',
  textFaint: '#CBD5E4',
  onAccent: '#FFFFFF',
  accent: '#2C7BEA',
  accentText: '#B4D6FF',
  danger: '#D8465A',
  dangerText: '#FFC2CD',
  ok: '#5CCB86',
  okText: '#8FE3B0',
  warnText: '#FFCB61'
}

/**
 * The elevation ladder's SHAPE. The rungs themselves belong to a theme.
 *
 * The first dark pass read as one flat black field. Every surface now sits on a
 * named rung of one ramp, each a measurable step lighter than the one below it,
 * and the names are shared across schemes and themes so a component never
 * branches to pick a surface.
 *
 * The values moved to `themes.ts` when a theme became a thing a reader picks:
 * a ladder is a third of what a preset IS, and a per-scheme constant here could
 * only ever have described one of them.
 */
export type ElevationRung = 'e0' | 'e1' | 'e2' | 'e2s' | 'e3' | 'e3c' | 'e3f' | 'e4'

export type ElevationScale = Record<ElevationRung, string>

/** 4pt scale. `space.md` is the default gap between unrelated blocks. */
export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /** The mockup's `--s5`: panel padding, one step above `lg`. */
  panel: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48
} as const

/**
 * The gap between a floating panel and the window edge, and between the two
 * panels. Deliberately off the 4pt scale — it is a window metric, not spacing
 * inside a surface.
 */
export const WINDOW_GAP = 14

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  /** Inset controls: a field, a segment, a tab slot. */
  inset: 12,
  lg: 12,
  thumb: 14,
  xl: 16,
  card: 18,
  /**
   * A speech bubble's outer corner.
   *
   * 18. It was 22 once, which on a bubble whose content box is 10pt tall left the
   * corner arc taller than the text it surrounds — a one-word message read as a
   * lozenge rather than as a bubble. 16 fixed that and undershot the reference
   * the owner is holding this against; 18 is the radius that goes with the
   * droplet tail below.
   */
  bubble: 18,
  sheet: 28,
  panel: 30,
  pill: 999,
  /**
   * The tail-side corner: where the tail meets the bubble, and where two bubbles
   * of one run meet each other.
   *
   * One number for both because they are the same corner seen from either end of
   * a run — see `Bubble`'s corner table.
   */
  tail: 4
} as const

export type TypeStyle = {
  fontSize: number
  lineHeight: number
  fontWeight: '400' | '500' | '600' | '700'
  letterSpacing?: number
}

/**
 * One scale, shared by phone and the wide layout.
 *
 * Body text is NOT scaled up on the wide layout — the same 17pt reads correctly
 * at both sizes and it is the same React Native code. Only the sidebar title has
 * a wide variant.
 *
 * Exactly §3 of the token document. The Part-1 aliases (`display`, `heading`,
 * `callout`, `caption`, `mono`) are gone: two names for one size is two names to
 * keep in step with the mockup, and `caption` in particular was being asked for
 * where `meta` and `micro` mean different things.
 */
export const type = {
  title: { fontSize: 28, lineHeight: 32, fontWeight: '700', letterSpacing: -0.62 },
  titleWide: { fontSize: 30, lineHeight: 34, fontWeight: '700', letterSpacing: -0.66 },
  sheetTitle: { fontSize: 21, lineHeight: 26, fontWeight: '700', letterSpacing: -0.34 },
  chatName: { fontSize: 18, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  name: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.17 },
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' },
  bodyRead: { fontSize: 17, lineHeight: 27, fontWeight: '400' },
  preview: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  meta: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600', letterSpacing: 0.6 },
  code: { fontSize: 13.5, lineHeight: 21, fontWeight: '400' }
} as const satisfies Record<string, TypeStyle>

export type TypeToken = keyof typeof type

/**
 * Presence: one bead, four states.
 *
 * Colour never carries the meaning alone — the SHAPE differs per state (filled,
 * filled with a still inner dot, filled with a notch, hollow ring) and the chat
 * header repeats the state in words.
 */
export type PresenceState = 'online' | 'working' | 'needsInput' | 'offline'

export type PresenceScale = Record<PresenceState, string>

export const lightPresence: PresenceScale = {
  online: '#20A24B',
  working: '#1668E3',
  needsInput: '#E09000',
  offline: '#8A93A3'
}

export const darkPresence: PresenceScale = {
  online: '#3ED374',
  working: '#5AA4FF',
  needsInput: '#FFB531',
  offline: '#7E8798'
}

/** Bead diameters. 14 on a 48pt avatar, 9 inline in a header or the gateway card. */
export const BEAD_SIZE = { avatar: 14, inline: 9, legend: 18 } as const

/**
 * Per-chat colour: eight curated swatches and Default.
 *
 * It tints exactly four things — the avatar ring, the selected row's glass, the
 * header accent and in-chat links, and the outgoing bubble gradient. The last
 * two are Part 2's; the gradient stops live here so Part 2 needs no second
 * table.
 *
 * `text` is a separate value per scheme because the fill is too dark to read on
 * glass in dark mode and too light in light mode. The dark variants are lighter
 * than they look like they need to be: they have to clear 4.5:1 on a reading
 * bubble, the lightest surface they ever sit on.
 */
export type AccentName =
  'default' | 'indigo' | 'violet' | 'magenta' | 'red' | 'orange' | 'teal' | 'green' | 'graphite' | 'slate' | 'lime'

export type AccentSwatch = {
  /** Solid fill: the avatar ring, the swatch itself. */
  fill: string
  /** Readable on glass. Scheme-dependent. */
  text: { light: string; dark: string }
  /**
   * The outgoing bubble's fill. ONE colour.
   *
   * It was a two-stop gradient and the owner's verdict on gradients is that they
   * look generated. Flat is also what every messenger he compared this to draws:
   * one saturated field, one ink on it. The value kept is the gradient's lighter
   * stop, which is the one `contrast:check` has always measured white against —
   * so the accent that was hardest to read on is now the whole bubble, and the
   * floor did not move.
   */
  bubble: string
}

export const ACCENTS: Record<AccentName, AccentSwatch> = {
  default: {
    fill: '#1668E3',
    text: { light: '#0B57C4', dark: '#B4D6FF' },
    bubble: '#2A72DC'
  },
  indigo: {
    fill: '#4B4CC8',
    text: { light: '#3F3FB4', dark: '#CCCDFF' },
    bubble: '#5556CE'
  },
  violet: {
    fill: '#7B3FC4',
    text: { light: '#6A2FB4', dark: '#E0C8FF' },
    bubble: '#8244CE'
  },
  magenta: {
    fill: '#B62F81',
    text: { light: '#A22270', dark: '#FFC2E2' },
    bubble: '#C0368A'
  },
  red: {
    fill: '#C5303A',
    text: { light: '#AE2029', dark: '#FFC2C7' },
    bubble: '#CF3B44'
  },
  orange: {
    fill: '#B04C08',
    text: { light: '#9A4106', dark: '#FFD0A8' },
    bubble: '#B8540C'
  },
  teal: {
    fill: '#0E7A84',
    text: { light: '#0A6670', dark: '#A6E8EE' },
    bubble: '#14828C'
  },
  green: {
    fill: '#16783C',
    text: { light: '#12652F', dark: '#A8ECBE' },
    bubble: '#1A8043'
  },
  graphite: {
    fill: '#485468',
    text: { light: '#3D4859', dark: '#D2DAE6' },
    bubble: '#54607A'
  },
  /**
   * Slate: the Slate wallpaper's own outgoing bubble.
   *
   * A desaturated BLUE, which is what makes it a different swatch from Graphite
   * rather than a second name for it: Graphite is grey with a hint of blue in it
   * (`#54607A`), and this is blue with most of the blue taken out (`#4F6B96`). Side
   * by side on the picker they read as two different answers to the same question,
   * which is the only reason to have both.
   *
   * The top stop IS the value the owner sampled, and it is the stop white has to be
   * readable on — so nothing lighter can be added above it without the contrast
   * check saying so.
   */
  slate: {
    fill: '#4F6B96',
    text: { light: '#3F5A83', dark: '#C6D8F2' },
    bubble: '#4F6B96'
  },
  /**
   * Lime: the Lime theme's own accent, and the studio's colour.
   *
   * It is built on the same pattern as Slate — a swatch whose three halves do
   * three different jobs — because the FullStack Studio lime, `#C7FF4A`, can only
   * do one of them. That value is a RING colour: it is brilliant enough to find a
   * selected row with at a glance, and white on it measures about 1.3 : 1, so an
   * outgoing bubble painted in it would be a message nobody can read.
   *
   * So `fill` is the studio lime and nothing else uses it as a background for
   * text; `bubble` is the same hue taken down until white clears AA on it, which
   * is what `npm run contrast:check` measures; and `text` is the ink form, dark
   * enough to read on light glass and pale enough to read on a dark bubble.
   */
  lime: {
    fill: '#C7FF4A',
    text: { light: '#3F6B12', dark: '#D6F59A' },
    bubble: '#4A7F15'
  }
}

/** Picker order: Default first, then the curated colours. */
export const ACCENT_ORDER: readonly AccentName[] = [
  'default',
  'indigo',
  'violet',
  'magenta',
  'red',
  'orange',
  'teal',
  'green',
  'graphite',
  'slate',
  'lime'
]

/**
 * The colours a group chat may ink a SENDER's name in — `ACCENT_ORDER` minus
 * `default`, `red` and `green` (HERM-83, D5).
 *
 * `default` stays reserved for the chat's own outgoing bubble, so a
 * teammate's ink is never mistaken for the chat's own accent. `red` and
 * `green` are excluded for the same reason `category-look.ts` excludes them
 * from `CATEGORY_TINTS`: in this app they are not colours, they are `danger`
 * and `ok`. A name inked in red reads as a warning about that person, not as
 * that person's colour, and that is true of a sender's name exactly as it is
 * true of a category mark. `lime` stays in — here it is a text ink read
 * against glass, not a white glyph painted on a lime fill, so the contrast
 * gate that rules it out for `CATEGORY_TINTS` has nothing to say against it
 * here, and `scripts/check-contrast.ts` measures it like any other sender ink.
 */
export const SENDER_INK_ORDER: readonly AccentName[] = ACCENT_ORDER.filter(
  name => name !== 'default' && name !== 'red' && name !== 'green'
)

/** The soft tint a chat's colour lays under a selected row or an icon well. */
export function accentSoft(name: AccentName, scheme: Scheme): string {
  return withAlpha(ACCENTS[name].fill, scheme === 'dark' ? 0.26 : 0.13)
}

/**
 * Glass, as a recipe rather than as a picture.
 *
 * A glass surface is a blur, one or two translucent gradients, a hairline and a
 * drop shadow. Alphas are what make it legible, so they are tokens. Each variant
 * also names the OPAQUE colour it collapses to where there is no blur —
 * Android, Reduce Transparency, and a test renderer — which is the reason the
 * elevation ladder exists.
 */
export type GlassVariant = 'panel' | 'float' | 'sheet' | 'card' | 'row' | 'rowSelected' | 'control' | 'chip'

export type GlassRecipe = {
  /**
   * The translucent wash over `solid`. ONE colour.
   *
   * It was a two- or three-stop gradient, and the owner's verdict on gradients
   * is that they look generated. The value kept is the THINNEST stop — the one
   * the wallpaper showed through most — because that is the stop
   * `contrast:check` has always measured the ink against, so making it the whole
   * surface cannot lower a single ratio in the table.
   */
  fill: string
  /** What the surface is where no blur is possible. A rung of the ladder. */
  solid: string
  /** `expo-blur` intensity, 0–100, mapped from the CSS blur radius. */
  blurIntensity: number
  /** Tint handed to the native Liquid Glass material, or none. */
  nativeTint?: string
  hairline: string
}

export type GlassScale = Record<GlassVariant, GlassRecipe>

/**
 * Bubbles.
 *
 * A bubble is NOT a `GlassSurface`. §7.4 of the token document is explicit: a
 * virtualised list with a blur view per row is the fastest way to make a long
 * report scroll badly, and on Android there are no per-bubble blur views at all.
 * So an incoming bubble is the glass RECIPE composited by hand — gradient over a
 * rung — and a long reply drops the gradient for the near-opaque `read` wash so
 * its contrast is a fixed number rather than a function of the wallpaper.
 *
 * `tail` is the flat colour the SVG tail is filled with. It has to match the
 * bubble's LOWER edge, which for a translucent gradient means the composite
 * rather than the stop: these are the stops resolved against the panel they sit
 * on, so the tail meets the bubble with no visible seam.
 */
export type BubbleVariant = 'in' | 'inRead' | 'dm' | 'dmRead'

export type BubbleRecipe = {
  /** The translucent wash over `solid`. One colour — see `GlassRecipe.fill`. */
  fill: string
  /** What the wash composites onto where nothing behind it shows through. */
  solid: string
  tail: string
}

/**
 * The tail, as ONE path that belongs to the bubble: the classic droplet.
 *
 * 20 × 14, drawn for the sender's side and mirrored with `scaleX(-1)` for the
 * other. It is offset `TAIL_OVERLAP` into the bubble, so within this box the
 * bubble's own edge stands at x = 13 and the tail reaches 7 past it.
 *
 * ### The height is 14 and NOT a comfortable round number
 *
 * It used to be 25, of which the top 11 was a plain rectangle sitting behind the
 * bubble and covering nothing. That rectangle is harmless under a paragraph and
 * wrong under the shortest bubble in the app: the typing indicator is 34pt tall
 * and its top corner arc is `radii.bubble` — 18 — so the bubble's own edge is
 * curving away for the top 18pt while the tail's rectangle stood straight up
 * behind 25 of them. What showed, measured on an iPhone 17 Pro in Graphite dark,
 * is a STEP in the left edge: crisp bubble colour out to the tail's edge for the
 * top 25pt and the corner's own arc above it. The bubble had two left edges.
 *
 * 14 is everything the shape does: 10 for the droplet's arc and 4 for the
 * bubble's own tail-side bottom corner, which the tail deliberately fills. Above
 * that the tail covered nothing and could only ever collide with the corner at
 * the other end. `bubble-geometry.test.tsx` holds it against `MIN_BUBBLE_HEIGHT`
 * so a taller tail or a tighter padding cannot bring the step back. There is
 * deliberately no separately positioned tail VIEW: the build before last drew the
 * tail as an absolutely positioned square with one rounded corner, and at certain
 * bubble heights the square's straight corners escaped the bubble's own rounding
 * and painted the stray block the owner reported. A path cannot do that.
 *
 * ### Where the numbers come from
 *
 * The shape is the one the well-known CSS construction produces, resolved to a
 * single closed outline because our backgrounds are glass and a
 * background-coloured mask over glass is a grey patch, not a cut. That
 * construction is two boxes 25 tall sitting on the bubble's bottom edge: a piece
 * of bubble colour reaching 7 past the edge, and a background-coloured piece
 * starting AT the edge whose 10pt bottom-left rounding cuts the curl. What
 * survives the cut is the only part that was ever visible, and it is this path:
 *
 *  - `13,4 → 20,14` is that 10pt cut, as an arc. It is the tail's whole visible
 *    silhouette — a concave edge leaving the bubble 10pt above its bottom,
 *    sweeping down and out to a point on the bubble's own bottom line, 7 out.
 *  - the rest is behind the bubble and exists only so the shape is closed and
 *    covers what it must.
 *
 * ### The underside is flat to x = 6, and that is not a simplification
 *
 * The colour piece's own bottom-left rounding is wide (16 × 14), which lifts the
 * outline off the bubble's bottom line well before the bubble's body is there to
 * hide it: the bubble's tail-side bottom corner is `radii.tail`, so between the
 * end of that corner arc and the bubble's bottom line there is a wedge the bubble
 * does NOT paint. With a wide curl the tail does not paint it either, and the gap
 * reads as a notch under the corner — which is the same artefact, by a different
 * route, that the positioned-square tail was replaced for. So the outline stays
 * on the bottom line until x = 6, which is comfortably inside the corner, and
 * tucks up from there where only the bubble can see it. That tuck is what sets
 * the box's height: the arc reaches the top edge at x = 0, and nothing in the
 * shape is above it.
 *
 * Every number is whole. The Mac renders the iPad build scaled, so a sub-point
 * offset that is invisible at 3x is a visible sliver there.
 */
export const TAIL = {
  width: 20,
  height: 14,
  path: 'M0 0 L13 0 L13 4 A10 10 0 0 0 20 14 L6 14 A6 14 0 0 1 0 0 Z'
} as const

/**
 * The shortest bubble the app draws, and why the number above has to clear it.
 *
 * The typing indicator: the dots' own row (8pt tall inside 3pt of padding) inside
 * the bubble's vertical padding (`space.sm + 2`, twice). Nothing in the transcript
 * is shorter, and `bubble-geometry.test.tsx` holds the tail against it.
 */
export const MIN_BUBBLE_HEIGHT = 8 + 3 * 2 + (space.sm + 2) * 2

export const TAIL_OVERLAP = 13

/**
 * Max bubble width — the rule that fixes edge-to-edge text walls.
 *
 * 68 % is too narrow to read at phone width, hence the override; the 640pt cap
 * is what keeps a long report from spanning a Mac window.
 *
 * **`widePoints` is a second ceiling, for a column wide enough that the first one
 * looks mean.** 640pt is a comfortable measure, and on a 13" iPad in landscape or
 * a full-screen Mac window the content column is around 1500pt — so a capped
 * bubble uses under half of it and the transcript reads as a narrow strip with a
 * large empty margin, which is what the owner reported. Above `wideColumnFrom`
 * the ceiling steps to 760: still a measure rather than a wall (about 85
 * characters at the reading size), and still far short of the column. The step is
 * deliberately a step and not a curve — a bubble that grows continuously with the
 * window changes width every time the sidebar is collapsed, and a measure that
 * moves while you read is worse than one that is slightly wrong.
 */
export const BUBBLE_MAX = {
  regular: { percent: 68, points: 640, widePoints: 760, wideColumnFrom: 1100 },
  compact: { percent: 78, points: 320 }
} as const

export type ResolvedBubbleWidth = (typeof BUBBLE_MAX)[keyof typeof BUBBLE_MAX]

/**
 * Where a long reply folds.
 *
 * Fourteen lines at the reading leading, which is the number the mockup folds
 * at. Expressed in POINTS because that is what `maxHeight` takes, and derived
 * from the leading so the two cannot drift: 14 × 27 ≈ 378 on the wide layout,
 * and the phone folds sooner because its bubble is narrower and therefore its
 * fourteen lines hold less.
 */
export const FOLD_HEIGHT = { regular: 378, compact: 300 } as const

/**
 * The same fold, as a LINE COUNT — which is the number that actually matters.
 *
 * A fold clipped to a height lands wherever that height falls, and half a line
 * of x-height under a gradient reads as a sliced row rather than as a fade. So
 * the clip is `lines × leading` and the leading is the one the caller is really
 * rendering at, which only the caller knows. `FOLD_HEIGHT` stays the fallback
 * for a body whose leading nobody has told us.
 */
export const FOLD_LINES = { regular: 14, compact: 11 } as const

/**
 * How many lines the fade covers.
 *
 * One line is not a fade, it is an edge; four is a wash that hides a paragraph
 * the reader could have read. Two and a half lines is long enough to be plainly
 * a gradient at both leadings.
 */
export const FOLD_FADE_LINES = 2.5

/**
 * How far apart two bubbles sit: within one sender's run, and between two turns.
 *
 * The ratio is what makes a run read as one block rather than as four separate
 * rounded rectangles — the small gap is "the same person, still talking" and the
 * separate one is "somebody else now".
 *
 * Both numbers moved this round, to the proportions the owner was comparing
 * against. 3pt was too tight to be a gap at all: two bubbles 3pt apart with a
 * 4pt tucked corner between them read as one bubble with a scratch across it, so
 * the run lost the thing the gap was for. And 12pt between two TURNS is the same
 * order of magnitude as the gap inside a run, which is why the grouping was hard
 * to see at a glance — 6 against 24 is a ratio a reader can resolve without
 * measuring, and 24 is what an author change needs to read as a paragraph break.
 */
export const BUBBLE_GAP = { grouped: 6, separate: 24 } as const

/**
 * The gap between a bubble's last text line and the time that sits on it.
 *
 * `space.sm`'s number, but its own token: this is a gap between two RUNS OF TEXT
 * sharing a line, not spacing between blocks, and the two have no reason to move
 * together. It is also the number a test has to be able to name.
 */
export const INLINE_META_GAP = 8

/**
 * Consecutive bot-to-bot lines, from §6.6.
 *
 * Deliberately its own number rather than a reuse of `BUBBLE_GAP.separate`. A
 * dispatch is a ledger line, not speech (§6.4): it has no tail and no corner to
 * tuck, so it neither groups like a bubble nor deserves the gap that separates
 * two turns of conversation. Nine is what sits between two of them.
 */
export const DM_LINE_GAP = 9

/** A sunk surface: a search field, a code well, the tab strip's track. */
export const TINT_SUNK: Record<Scheme, string> = {
  light: 'rgba(14,32,64,0.055)',
  dark: 'rgba(6,12,24,0.44)'
}

/**
 * The wash a pointer leaves on the control it is over.
 *
 * Its own token rather than `TINT_SUNK` re-used, because the two say opposite
 * things and only one of them can be a single colour. A sunk tint DARKENS in
 * both schemes, which is right for a well; a hover has to move the control
 * towards the reader, so it darkens on a light floor and lightens on a dark one.
 * Laid over whatever the control already is, so the same value works on a
 * neutral secondary, a tinted danger and a saturated accent bubble alike.
 *
 * Low on purpose. A hover is an answer to "can I press this", not emphasis, and
 * the dark value is deliberately well under `TINT_SUNK`'s 0.44 — a wash that
 * strong over an accent bubble reads as the button being disabled.
 */
export const TINT_HOVER: Record<Scheme, string> = {
  light: 'rgba(14,32,64,0.06)',
  dark: 'rgba(255,255,255,0.09)'
}

/**
 * The soft destructive fill, and the soft ok one beside it.
 *
 * §3's `.btn--danger` is a TINT carrying `dangerText`, not the saturated
 * `danger` fill. That is a hierarchy decision, not a shade: a sheet whose four
 * answers include one solid red block reads as a warning about itself rather
 * than as a choice between four buttons, and the solid fill is then competing
 * with the primary. `danger` stays what a status MARK is painted with.
 */
export const DANGER_SOFT: Record<Scheme, string> = {
  light: 'rgba(192,41,58,0.12)',
  dark: 'rgba(255,120,135,0.16)'
}

/**
 * The dark alpha is 0.12, not the 0.16 the danger tint uses.
 *
 * `ok` is the lightest of the status fills, so the same wash lifts a dark sheet
 * further — at 0.16 every light ink on it, `okText` included, measured 4.39–4.47
 * against the blue wallpaper's brightest bloom and `npm run contrast:check`
 * failed. Both tints are in that check now, which is how this was found at all.
 */
export const OK_SOFT: Record<Scheme, string> = {
  light: 'rgba(28,133,71,0.12)',
  dark: 'rgba(92,203,134,0.12)'
}

/** The full-strength hairline, for an edge that has to be visible. */
export const HAIRLINE: Record<Scheme, string> = {
  light: 'rgba(16,38,78,0.13)',
  dark: 'rgba(190,212,255,0.22)'
}

export const HAIRLINE_SOFT: Record<Scheme, string> = {
  light: 'rgba(16,38,78,0.08)',
  dark: 'rgba(190,212,255,0.13)'
}

/**
 * The specular inner edge that makes a surface read as glass rather than as a
 * flat translucent rectangle. React Native has no inset shadow, so it is drawn
 * as a 1pt border of the first stop's colour — the strongest of the three CSS
 * lines, and the only one that survives being flattened to a border.
 */
export const EDGE: Record<Scheme, string> = {
  light: 'rgba(255,255,255,0.92)',
  dark: 'rgba(255,255,255,0.34)'
}

export const EDGE_SOFT: Record<Scheme, string> = {
  light: 'rgba(255,255,255,0.80)',
  dark: 'rgba(255,255,255,0.24)'
}

export type ShadowToken = {
  shadowColor: string
  shadowOffset: { width: number; height: number }
  shadowOpacity: number
  shadowRadius: number
  /** Android has one number for all of it. */
  elevation: number
}

export type ShadowName = 'panel' | 'float' | 'card' | 'sheet'

export type ShadowScale = Record<ShadowName, ShadowToken>

export const lightShadows: ShadowScale = {
  panel: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.28,
    shadowRadius: 32,
    elevation: 16
  },
  float: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 15,
    elevation: 8
  },
  card: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 3
  },
  sheet: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.24,
    shadowRadius: 30,
    elevation: 20
  }
}

export const darkShadows: ShadowScale = {
  panel: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.62,
    shadowRadius: 35,
    elevation: 16
  },
  float: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8
  },
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.38,
    shadowRadius: 8,
    elevation: 3
  },
  sheet: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.55,
    shadowRadius: 30,
    elevation: 20
  }
}

/** The dimmed layer an overlay panel or a sheet puts over what it covers. */
export const SCRIM_COLOR = 'rgba(8,20,44,0.34)'

// Motion is not here. Durations, curves and the one spring are `ui/motion.ts`,
// because a duration is only half of a movement and the other half — which curve,
// which driver, what happens under Reduce Motion — cannot live in a table of
// numbers. This file kept five durations of which two were ever read, and the one
// named `sheet` belonged to the overlay panel rather than to the sheet.

/** Main controls are 44pt or taller, per the design board's touch-target rule. */
export const CONTROL_MIN_HEIGHT = 44

/** Round glass control: 38 on the wide layout, 40 on phone. */
export const CONTROL_SIZE = { regular: 38, compact: 40 } as const

export const AVATAR_SIZE = { list: 48, header: 38, inline: 26 } as const

/**
 * The rounded square a Settings category's mark sits in.
 *
 * Two sizes, because the mark does two jobs: `row` is the one in a list row,
 * where it has to be findable while the eye runs down twelve labels, and
 * `header` is the same mark on the card that opens the category's own page.
 *
 * The radii that go with them are `radii.md` and `radii.thumb` — 8 on 28 and 14
 * on 52, which is the same corner at both sizes rather than two different
 * squares. That pairing is the reason the numbers live together here instead of
 * in the component: a well whose corner does not scale with it reads as a
 * different shape per page.
 */
export const CATEGORY_MARK = { row: 28, header: 52 } as const

/** List row height: 74 on the wide layout, 72 on phone. */
export const ROW_HEIGHT = { regular: 74, compact: 72 } as const

/**
 * The slop that brings a small inline control up to a 44pt target.
 *
 * A caption-sized "Show more" or "Stop" is roughly 17pt tall. Growing the box
 * would push the card's layout around, so the touchable area is grown instead
 * — which is what `hitSlop` is for, and the only way these rows reach the
 * touch-target rule without being redrawn.
 */
export const TAP_SLOP = { bottom: 14, left: 12, right: 12, top: 14 } as const

/** The width at and above which the regular (sidebar + detail) shell is used. */
export const REGULAR_LAYOUT_MIN_WIDTH = 700

/**
 * Sidebar width in the regular shell, on a window wide enough to spare it.
 *
 * §4's number was 344 flat, which is a landscape number wearing no label. In
 * portrait it is a THIRD of an iPad Pro 13" (344 of 1032) and two fifths of an
 * 11" (344 of 834), and what it takes comes out of the one column that has to
 * hold prose.
 */
export const SIDEBAR_WIDTH = 340

/**
 * The same sidebar on a window that cannot spare it.
 *
 * A list row is an avatar, two lines of text and a stamp; at 300 the preview
 * loses a couple of words and nothing else, which is the cheapest 40pt the
 * layout has to give.
 */
export const SIDEBAR_WIDTH_NARROW = 300

/** Above this window width the sidebar takes `SIDEBAR_WIDTH`, below it the narrow one. */
export const SIDEBAR_WIDE_MIN_WIDTH = 1100

/**
 * Above this window width, the regular shell draws a `ConversationColumn`
 * (sub-chats, Task 7) beside the chat; below it the column is never drawn and
 * the chat header's conversations button opens `ConversationSheet` instead.
 *
 * Provisional (Owner Decision, 2026-09-22): the owner wants to look at both
 * numbers on an iPad and the Mac build before they are fixed, which is the
 * whole reason they are named constants rather than literals typed into the
 * breakpoint check and the column's own width.
 */
export const CONVERSATION_COLUMN_MIN_WINDOW = 1100

/** How wide the conversation column is drawn once there is room for one. Provisional; see `CONVERSATION_COLUMN_MIN_WINDOW`. */
export const CONVERSATION_COLUMN_WIDTH = 260

/**
 * The width band that decides whether the sidebar STARTS hidden.
 *
 * A THIRD breakpoint, and the reason it is its own number rather than a reuse of
 * either of the other two: 700 is "do two panels fit at all" and 1100 is "can the
 * wider sidebar be afforded", while this one is "is a 300pt list worth what it
 * costs the prose beside it". Measured, in the 2026-09-20 portrait pass: at 834pt
 * portrait the chat column keeps 492pt and the bubble cap lands around 335pt,
 * which is about 38 characters — short of a comfortable measure and the finding
 * that asked for a collapse in the first place. Above 900 there is enough left
 * over that starting hidden would be taking something away for nothing.
 *
 * It only ever answers for a window the owner has expressed NO opinion about; an
 * explicit Hide or Show wins at every width. See `resolveSidebarCollapsed`.
 */
export const SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH = 900

/**
 * The slim rail the collapsed sidebar leaves behind.
 *
 * Not zero, and that is the decision rather than an oversight: the rail keeps the
 * Show control and the three tab-strip destinations one tap away, so collapsing
 * the list costs the reader the list and nothing else. 56 is a 38pt round control
 * plus the panel's own hairline and breathing room on each side — narrow enough
 * that the swap is worth about 250pt of prose at the 834pt window this exists for.
 */
export const SIDEBAR_RAIL_WIDTH = 56

/**
 * Which of the two applies, as a function of the WINDOW.
 *
 * A function rather than a second constant at each call site: the shell, the
 * gallery's mimic of the shell and anything that parks itself beside the sidebar
 * have to agree, and three copies of one comparison is how they stop agreeing.
 */
export function sidebarWidth(windowWidth: number): number {
  return windowWidth >= SIDEBAR_WIDE_MIN_WIDTH ? SIDEBAR_WIDTH : SIDEBAR_WIDTH_NARROW
}

/** How wide the overlay panel grows before it starts leaving the sidebar room. */
export const OVERLAY_MAX_WIDTH = 520

/**
 * How wide a bottom sheet grows on the wide layout.
 *
 * A sheet spanning a 1366pt window puts "Allow once" and "Deny" a hand's width
 * apart, and lays its scrim over the chat list the reader is still using. It is
 * capped and parked over the content column instead — see `sheetBox` in
 * `src/ui/BottomSheet.tsx`.
 */
export const SHEET_MAX_WIDTH = 560

/**
 * An onboarding form never grows past this; a centred column reads better than
 * a full-width field on an iPad or a Mac window.
 */
export const FORM_MAX_WIDTH = 480

/**
 * How wide the onboarding card grows before it stops.
 *
 * Wider than `FORM_MAX_WIDTH` because the card carries its own padding, its
 * status lines and its actions rather than only a field: at 480 the same content
 * wrapped one line more on every step. It is the wizard's whole width on a
 * phone, where the card spans the window minus the gap instead.
 */
export const ONBOARDING_CARD_MAX_WIDTH = 520

/**
 * `#RRGGBB` plus an alpha, as `rgba()`.
 *
 * React Native accepts `#RRGGBBAA` on both platforms, but a token that is read
 * back and compared in a test is easier to reason about as an `rgba()` string,
 * and the mockup writes them that way too.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map(char => char + char)
          .join('')
      : value
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)

  return `rgba(${r},${g},${b},${alpha})`
}
