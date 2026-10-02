/**
 * The render context a Markdown block needs.
 *
 * It is one frozen object so a memoized block has exactly two props — the raw
 * source and this — and a streaming reply cannot invalidate settled blocks by
 * handing them a fresh callback identity on every flush.
 */
import { Platform } from 'react-native'

import type { ColorRole } from '../ui/tokens'

export interface MarkdownContext {
  scheme: 'light' | 'dark'
  /** Body colour role; headings and code derive from it. */
  color: ColorRole
  /** Muted role, for rules, table headers and the code language label. */
  mutedColor: ColorRole
  /** Link colour; white-on-blue bubbles override it. */
  linkColor: string
  fontSize: number
  lineHeight: number
  selectable: boolean
  /** Surface a code block, table or blockquote paints on. */
  blockBackground: string
  /**
   * Surface an INLINE code chip paints on, separate from the code-block one.
   *
   * A chip sits on running text, on whatever surface that text is on — an
   * incoming bubble, a reading bubble, a tool card. The code-block surface is
   * opaque and near-black in dark mode, so borrowing it paints a redaction bar
   * through the middle of a sentence. This is a translucent sunk tint instead,
   * which steps one rung off its own background wherever it lands. Defaults to
   * the theme's `tintSunk`.
   */
  inlineCodeBackground?: string
  /** Hairline around a chip. See `codeStyle` in `Inline.tsx`: likely inert. */
  inlineCodeBorderColor?: string
  /**
   * The width the text lays out in, once it has.
   *
   * Only one thing reads it and only one thing needs it: an inline code chip
   * has to know whether it CAN fit on a line before it can decide whether it is
   * allowed to break (`codeJoinFor` in `Inline.tsx`). Absent on the first frame
   * and absent for good in any caller that does not measure, which is the case
   * the chip treats as "it fits".
   */
  lineWidth?: number
  /**
   * The width a BLOCK is allowed to occupy, in points.
   *
   * Separate from `lineWidth`, which is what running text laid out in and is
   * measured from inside. This one cannot be measured from inside: a bubble's
   * body is `alignItems: 'flex-start'`, so everything under it is sized BY its
   * content and asking the content how much room it has is circular. See
   * `OverflowScroll` for the layout rule and the measurement that found it.
   *
   * Absent in any caller that does not know — a gallery section, a test — and
   * a block that needs it then keeps the behaviour it had before it existed.
   */
  contentWidth?: number
  /**
   * The surface a block sits ON, for an edge fade to dissolve into.
   *
   * Not `blockBackground`, which is the surface a code block PAINTS. A table's
   * cells are transparent, so the colour behind its last column is the bubble's
   * own, and only the bubble knows it. No fade without it.
   */
  fadeColor?: string
  borderColor: string
  textColor: string
  mutedTextColor: string
  /** Stable for the lifetime of the renderer. */
  onLinkPress: (href: string) => void
  /**
   * What an image in the text needs to actually load.
   *
   * A gateway serves its attachments from its own origin, behind whatever
   * guards the rest of the API is behind, and it writes them into replies as
   * `/api/...` — a path, not a URL. Without a base an image like that resolves
   * against nothing and renders as a grey box; without the headers a gated
   * gateway answers 401 and it renders as the same grey box.
   */
  images?: MarkdownImageSource
}

export interface MarkdownImageSource {
  /** The gateway's base URL, for a relative `src`. */
  baseUrl?: string
  /** Sent with the image request; stable identity, or every block re-renders. */
  headers?: Record<string, string>
}

const ABSOLUTE_URI_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Turn an image `src` into something `Image` can fetch.
 *
 * Anything already carrying a scheme (`https:`, `data:`, `file:`) is left
 * exactly as written. A path is joined onto the gateway's base; without a base
 * it is handed back unchanged, so the renderer falls back to the alt text
 * rather than requesting a URL that cannot exist.
 */
export function resolveImageUri(href: string, baseUrl?: string): string {
  const src = href.trim()

  if (!src || ABSOLUTE_URI_RE.test(src)) {
    return src
  }

  if (!baseUrl) {
    return src
  }

  return `${baseUrl.replace(/\/+$/, '')}/${src.replace(/^\/+/, '')}`
}

/**
 * The schemes a link is allowed to leave the app through.
 *
 * An agent writes `/home/you/notes.md` and `file:///var/log/hermes.log` into
 * replies as often as it writes a URL, and a path on the GATEWAY's disk is not
 * something this device can open. A link outside this list stays inert: it is
 * still coloured and still underlined, because it is still a link in the
 * source, but nothing happens when it is pressed and — on the web — it renders
 * without an `href`, so the browser never offers to navigate to it either.
 *
 * Shared because two renderers need the same answer: `Markdown.tsx` guards its
 * `Linking.openURL` with it, and `Inline.tsx` decides from it whether the token
 * gets an anchor.
 */
const OPENABLE = /^(https?|mailto|tel):/i

export function isOpenableLink(href: string): boolean {
  return OPENABLE.test(href)
}

/**
 * Android has no Menlo and iOS has no family called `monospace`; naming
 * a font that does not exist falls back to the UI face, which is precisely what
 * a command or a diff must not render in.
 */
export const MONOSPACE = Platform.select({ android: 'monospace', default: 'Menlo' })

/**
 * How wide one monospace character is, as a fraction of the font size.
 *
 * Every monospace face this app can end up with — Menlo on iOS, whatever
 * `monospace` resolves to on Android, Courier as the last fallback — advances at
 * 0.6 em. That is a constant of the CLASS rather than a guess at one member of
 * it, which is why it is written down rather than measured: measuring costs a
 * hidden `Text` and a layout pass per use, and both readers feed it into a
 * comparison with a whole box's width where a few per cent decides nothing.
 *
 * Two things read it: an inline chip deciding whether it may break at all
 * (`codeJoinFor`), and a fenced block deciding how wide its listing wants to be
 * (`codeNaturalWidth`).
 */
export const MONO_ADVANCE = 0.6
