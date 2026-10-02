/**
 * `<Markdown text />` — the incremental renderer.
 *
 * The text is preprocessed, split into top-level blocks, and each block is
 * rendered by a component memoized on its own source slice. While a reply
 * streams, every block but the last keeps byte-identical source, so only the
 * last one re-lexes and re-renders.
 *
 * Nothing marks the tail, so a settled block renders exactly ONCE over a whole
 * reply rather than once per delta — which is the bound
 * `__tests__/chat-ui/markdown-blocks.test.tsx` asserts. It used to be twice,
 * because the tail carried a streaming caret and rendered again when the caret
 * moved on; there is no caret now, and `Block.tsx` says why.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { Linking, View, type LayoutChangeEvent, type ViewStyle } from 'react-native'

import { HAS_NATIVE_CONTEXT_MENU } from '../platform/context-menu'
import { useTheme } from '../ui/theme'
import type { ColorRole } from '../ui/tokens'
import { MarkdownBlock } from './Block'
import { splitBlocks } from './blocks'
import { isOpenableLink, type MarkdownContext, type MarkdownImageSource } from './context'
import { preprocessMarkdown } from './preprocess'

export interface MarkdownProps {
  text: string
  /** Body colour role. Blue bubbles pass `onAccent`. */
  color?: ColorRole
  mutedColor?: ColorRole
  /** Link colour, when the body colour makes the accent unreadable. */
  linkColor?: string
  /** Surface that code blocks and tables paint on. */
  surface?: string
  /**
   * How much room a BLOCK has, in points.
   *
   * A table and a fenced listing are the two things in a reply that can be
   * wider than the box they land in, and neither can find that out for itself:
   * a bubble's body is `alignItems: 'flex-start'`, so everything under it is
   * sized by this very content. `OverflowScroll` has the measurement and the
   * consequence — without a number from outside, a horizontal scroll view comes
   * out as wide as its content and does not scroll at all.
   *
   * A caller inside a bubble computes it from `useBubbleWidth` minus its own
   * padding. A caller that genuinely does not know leaves it out, and the two
   * blocks keep the behaviour they had.
   */
  maxContentWidth?: number
  /**
   * The colour BEHIND a block, for the edge fade on a table that scrolls.
   *
   * The same value a `Fold` takes as `fadeTo`, and for the same reason: a
   * table's cells are transparent, so only the caller knows what its last
   * column dissolves into. No fade without it.
   */
  fadeTo?: string
  /**
   * Surface an inline code chip paints on. Defaults to the theme's sunk tint,
   * which is translucent and therefore correct on any bubble; `surface` does not
   * reach the chip, because the code-block surface is opaque and a near-black
   * slab behind three words in a sentence reads as a redaction bar.
   */
  inlineCodeBackground?: string
  /** Hairline around an inline code chip. Defaults to the theme's hairline. */
  inlineCodeBorderColor?: string
  borderColor?: string
  fontSize?: number
  selectable?: boolean
  /** Replaces the default `Linking.openURL`; the gallery uses it to log taps. */
  onLinkPress?: (href: string) => void
  /**
   * Where a relative image resolves and what its request carries.
   *
   * Pass a STABLE object: it lands in the context every block is memoized on,
   * and a fresh one per render re-renders the whole reply on every delta.
   */
  images?: MarkdownImageSource
  style?: ViewStyle
  /**
   * Where each top-level block sits, and whether it may be cut through.
   *
   * Only the fold asks for this, and only it can use it: a fold whose clip lands
   * inside a table or a fenced code block slices a row of cells or a line of code
   * in half, and no amount of gradient makes that read as a fade rather than as
   * damage. The renderer is the only thing that knows where the blocks are, so it
   * reports them and the fold decides.
   *
   * Absent means no wrapper views and no callbacks, which is what every other
   * caller gets.
   */
  onBlockLayout?: (block: { index: number; top: number; height: number; atomic: boolean }) => void
}

/**
 * The body leading, from the body size. 1.45 × the font size, rounded.
 *
 * Exported because the FOLD needs the same number: it clips at a whole multiple
 * of the leading, and a second copy of this factor is a fold that cuts half a
 * line the day either one is tuned.
 */
export function markdownLeading(fontSize: number): number {
  return Math.round(fontSize * 1.45)
}

/**
 * A block a fold must not cut through: a fenced code block, a table, or a
 * displayed equation.
 *
 * Cheap and deliberately shallow — it runs per block, not per delta, and the
 * cost of a false positive is one block faded whole instead of clipped.
 *
 * A `$$…$$` block is here for the same reason the other two are, and it is the
 * strongest case of the three: half a fraction under a gradient is not a fraction
 * that fades out, it is a numerator with no denominator — which SAYS something,
 * and says the wrong thing. A `mermaid` fence is already covered by the fence
 * test above, because a diagram is still a fenced block in the source.
 */
function isAtomicBlock(raw: string): boolean {
  const text = raw.trim()

  if (text.startsWith('```') || text.startsWith('~~~') || text.startsWith('$$')) {
    return true
  }

  // A table's delimiter row is the one line whose shape is unambiguous.
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|/m.test(text)
}

export function Markdown({
  text,
  color = 'text',
  mutedColor = 'textMuted',
  linkColor,
  surface,
  maxContentWidth,
  fadeTo,
  inlineCodeBackground,
  inlineCodeBorderColor,
  borderColor,
  fontSize,
  // Off where the platform's own context menu exists, on everywhere else.
  //
  // `Text selectable` is not a selection: it is a long-press `UIEditMenuInteraction`
  // whose only action copies the WHOLE paragraph (see the 2026-09-20 section of
  // docs/platform-notes.md). That was the best copy available before there was a
  // context menu. Now there is one, and it copies the same message with the choice
  // of words or markdown — so keeping both means a secondary click on a bubble
  // races two interactions for one gesture, which is the thing the owner reported
  // as "it also starts selecting".
  selectable = !HAS_NATIVE_CONTEXT_MENU,
  onLinkPress,
  images,
  style,
  onBlockLayout
}: MarkdownProps) {
  const theme = useTheme()

  // The caller may hand a fresh closure on every render; a block must never be
  // invalidated by that.
  const linkHandler = useRef(onLinkPress)

  linkHandler.current = onLinkPress

  const handleLink = useCallback((href: string) => {
    if (linkHandler.current) {
      linkHandler.current(href)

      return
    }

    // A path on the gateway's disk is not something this device can open; the
    // link stays inert rather than throwing. See `isOpenableLink`.
    if (isOpenableLink(href)) {
      void Linking.openURL(href).catch(() => undefined)
    }
  }, [])

  const body = fontSize ?? theme.type.body.fontSize

  /**
   * How wide the text lays out, for the one decision that needs it.
   *
   * An inline code chip cannot tell whether it is allowed to break without
   * knowing whether it COULD fit on a line — see `codeJoinFor`. Measured here
   * rather than guessed, and measured only for text that has a chip in it: this
   * is a state update on mount, which is one extra render of the block, and a
   * transcript is mostly prose with no backtick in it at all.
   */
  const measures = text.includes('`')
  const [lineWidth, setLineWidth] = useState(0)

  const measure = useCallback((event: LayoutChangeEvent) => {
    // Read OUT of the event here and not inside the updater below. React
    // Native's layout event is pooled, so by the time a state updater runs
    // `nativeEvent.layout` can already be null — which it was, as a render
    // error on the first reply that contained a chip.
    const next = event.nativeEvent.layout.width

    setLineWidth(current =>
      // Rounded, so a sub-pixel difference between two passes does not re-render
      // every chip in the reply for a decision it cannot change.
      Math.round(next) === Math.round(current) ? current : next
    )
  }, [])

  const context = useMemo<MarkdownContext>(
    () => ({
      blockBackground: surface ?? theme.tintSunk,
      inlineCodeBackground: inlineCodeBackground ?? theme.tintSunk,
      inlineCodeBorderColor: inlineCodeBorderColor ?? theme.hairline,
      borderColor: borderColor ?? theme.hairline,
      color,
      fontSize: body,
      lineHeight: markdownLeading(body),
      linkColor: linkColor ?? theme.colors.accentText,
      mutedColor,
      mutedTextColor: theme.colors[mutedColor],
      onLinkPress: handleLink,
      scheme: theme.scheme,
      selectable,
      textColor: theme.colors[color],
      ...(images ? { images } : {}),
      ...(lineWidth ? { lineWidth } : {}),
      ...(maxContentWidth ? { contentWidth: maxContentWidth } : {}),
      ...(fadeTo ? { fadeColor: fadeTo } : {})
    }),
    [
      body,
      borderColor,
      color,
      fadeTo,
      handleLink,
      images,
      lineWidth,
      maxContentWidth,
      inlineCodeBackground,
      inlineCodeBorderColor,
      linkColor,
      mutedColor,
      selectable,
      surface,
      theme
    ]
  )

  const blocks = useMemo(() => splitBlocks(preprocessMarkdown(text)), [text])

  // The callback may be a fresh closure per render; the wrapper must not be
  // rebuilt for that, and a block must never be invalidated by it.
  const blockLayout = useRef(onBlockLayout)

  blockLayout.current = onBlockLayout

  const reportLayout = useCallback((index: number, raw: string) => {
    const report = blockLayout.current

    if (!report) {
      return
    }

    return (event: LayoutChangeEvent) =>
      report({
        atomic: isAtomicBlock(raw),
        height: event.nativeEvent.layout.height,
        index,
        top: event.nativeEvent.layout.y
      })
  }, [])

  return (
    <View style={style} {...(measures ? { onLayout: measure } : {})}>
      {blocks.map((raw, index) => {
        const block = <MarkdownBlock context={context} key={index} raw={raw} />

        // No wrapper at all where nobody asked for the geometry: a view per block
        // on every reply in the transcript, for a measurement only one caller
        // wants, is a cost with no reader.
        return onBlockLayout ? (
          <View key={index} onLayout={reportLayout(index, raw)}>
            {block}
          </View>
        ) : (
          block
        )
      })}
    </View>
  )
}
