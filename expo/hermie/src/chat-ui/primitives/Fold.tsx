/**
 * The reading fold: a long body clipped with a gradient mask and a
 * `Show more` / `Show less` control.
 *
 * Three rules the mockup states:
 *
 *  - Past roughly fourteen lines the body folds (§6.3).
 *  - The state belongs to the LIST, not to this component — see `expanded.tsx`.
 *    A fold that lived here would re-collapse every time the row was virtualised
 *    out and back.
 *  - **The fold engages WHILE the reply streams**, at the cap, and never
 *    afterwards. This used to read the other way round — a streaming body was
 *    exempt, on the argument that a fold appearing mid-stream clips the words
 *    being written — and the owner's rule is the opposite one: a long reply grows
 *    inside its folded height with `Show more` already under it, and is never
 *    dumped out at full length and then collapsed once the turn seals. The
 *    exemption also cost a visible lurch: a tool row sealing an interim bubble
 *    flipped `streaming` to false, the fold engaged on a body that was already
 *    laid out, and the transcript lost the difference in one frame (−208pt on the
 *    owner's phone). A body the reader has already opened keeps growing open,
 *    because the expanded flag is the LIST's and nothing in a turn clears it.
 *
 * ### Where the cut lands
 *
 * The fold used to clip at a fixed height, and a fixed height lands wherever it
 * lands: half a line of x-height under a gradient, which reads as a row that has
 * been cut rather than as a body that fades. So the clip is now `lines × leading`
 * — the last visible line is always a whole line — and the leading comes from the
 * caller, because only the caller knows what it is rendering at.
 *
 * A table or a fenced code block gets a stronger rule: it is never cut through at
 * all. Half a row of cells or half a line of code under a gradient is not a fade,
 * it is damage, and no gradient fixes it. Where the cut would fall inside one,
 * the clip moves UP to that block's top and the whole block fades out instead —
 * which is only possible because the Markdown renderer reports where its blocks
 * are (`onBlockLayout`).
 *
 * The mask is a gradient from transparent to the surface colour. It needs the
 * colour it is fading INTO, which only the caller knows.
 */
import { LinearGradient } from 'expo-linear-gradient'
import { useCallback, useState, type ReactNode } from 'react'
import { Pressable, useWindowDimensions, View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import {
  FOLD_FADE_LINES,
  FOLD_HEIGHT,
  FOLD_LINES,
  REGULAR_LAYOUT_MIN_WIDTH,
  TAP_SLOP,
  withAlpha
} from '../../ui/tokens'
import { chatStrings } from '../strings'

/** One block of the body, as the Markdown renderer reported it. */
export interface FoldBlock {
  index: number
  top: number
  height: number
  atomic: boolean
}

export interface FoldProps {
  expanded: boolean
  /**
   * Open or close, and by HOW MUCH the row is about to change height.
   *
   * The number is the point of it. An inverted list pins a growing cell's
   * BOTTOM edge, so a body that opens grows upward and takes the line the reader
   * was on up with it; keeping that line still means moving the content offset
   * by exactly the growth, and this is the only place that number is known
   * before the layout happens — `natural` is measured on a view nothing
   * constrains, so the full height is already on hand while the body is clipped.
   * Positive when opening, negative when closing.
   */
  onToggle: (growth: number) => void
  /** What the mask fades into: the bubble's own lower colour. */
  fadeTo: string
  /**
   * The body's leading, in points.
   *
   * The clip is a whole number of these. Absent falls back to the old fixed
   * height, which is the right answer for a body whose leading nobody knows.
   */
  lineHeight?: number
  /**
   * Blocks that must not be cut through, from `<Markdown onBlockLayout>`.
   *
   * Only the atomic ones are used, so a caller may hand over all of them.
   */
  blocks?: readonly FoldBlock[]
  /**
   * How far the mask reaches PAST the text, in points.
   *
   * The fold lives inside the bubble's padded content box, so a mask that spans
   * only that box paints a rectangle with the bubble's padding visible around it
   * — an obvious seam rather than a fade. The clip box is pulled out by `bleed`
   * and padded back in by the same amount, so the mask covers the bubble's full
   * width while the text keeps its inset.
   */
  bleed?: number
  children: ReactNode
  testID?: string
}

export function useFoldHeight(): number {
  const { width } = useWindowDimensions()

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? FOLD_HEIGHT.regular : FOLD_HEIGHT.compact
}

/** How many lines this layout folds at. */
function useFoldLines(): number {
  const { width } = useWindowDimensions()

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? FOLD_LINES.regular : FOLD_LINES.compact
}

/**
 * Collect block geometry for a fold.
 *
 * A hook rather than state in `Fold`, because the reporter has to be handed to
 * the CHILD — the fold receives its body already built and cannot reach inside
 * it. The two bubbles that fold pass `onBlockLayout` to their `Markdown` and
 * `blocks` back to their `Fold`.
 */
export function useFoldBlocks(): { blocks: FoldBlock[]; onBlockLayout: (block: FoldBlock) => void } {
  const [blocks, setBlocks] = useState<FoldBlock[]>([])

  const onBlockLayout = useCallback((block: FoldBlock) => {
    setBlocks(current => {
      const previous = current[block.index]

      // Layout fires on every pass; only a real move is worth a render.
      if (previous && previous.top === block.top && previous.height === block.height) {
        return current
      }

      const next = [...current]

      next[block.index] = block

      return next
    })
  }, [])

  return { blocks, onBlockLayout }
}

/**
 * The clip height: a whole number of lines, moved up off an atomic block.
 *
 * Exported for the test, which is the only way to assert "cuts on a line
 * boundary" without measuring a rendered bubble.
 */
export function foldCut(
  lines: number,
  lineHeight: number | undefined,
  fallback: number,
  blocks: readonly FoldBlock[] = []
): number {
  if (!lineHeight || lineHeight <= 0) {
    return fallback
  }

  const limit = lines * lineHeight
  const straddling = blocks.find(block => block?.atomic && block.top < limit && block.top + block.height > limit)

  // A guard, not a preference: an atomic block that starts in the first few lines
  // would move the cut to almost nothing, and an empty fold with a `Show more`
  // under it is worse than a sliced table. Three lines is the floor.
  if (straddling && straddling.top >= lineHeight * 3) {
    return straddling.top
  }

  return limit
}

export function Fold({ expanded, onToggle, fadeTo, lineHeight, blocks, bleed = 0, children, testID }: FoldProps) {
  const theme = useTheme()
  const fallback = useFoldHeight()
  const lines = useFoldLines()
  const [natural, setNatural] = useState(0)

  const limit = foldCut(lines, lineHeight, fallback, blocks)

  // `natural` is measured on the INNER view, which is never height-constrained,
  // so it keeps reporting the real height even while the outer box clips it —
  // including all through a streaming turn, which is what lets the fold engage at
  // the cap rather than once the turn seals.
  const overflows = natural > limit + theme.space.lg
  const clipped = overflows && !expanded

  // Two and a half lines of fade. A fixed 64pt was a third of the phone's
  // fourteen lines at one leading and a fifth at another, which is why it read
  // as a band on one and as nothing much on the other.
  const fade = Math.round(FOLD_FADE_LINES * (lineHeight && lineHeight > 0 ? lineHeight : 24))

  return (
    <View testID={testID}>
      <View
        style={{
          marginHorizontal: -bleed,
          maxHeight: clipped ? limit : undefined,
          overflow: 'hidden',
          paddingHorizontal: bleed
        }}
      >
        {/*
          The measuring view. It carries a testID of its own because the test
          renderer lays nothing out, so firing `layout` by hand on exactly this
          view is the only way a test can reach the overflowing branch at all.
        */}
        <View
          onLayout={event => setNatural(event.nativeEvent.layout.height)}
          testID={testID ? `${testID}-body` : undefined}
        >
          {children}
        </View>

        {clipped ? (
          /*
            The first stop is the fade colour at ZERO ALPHA, not the keyword
            `transparent`.

            `transparent` is rgba(0,0,0,0) — transparent BLACK — so interpolating
            from it to an opaque colour travels through dark grey and paints a
            dirty band across the last two lines. On the dark theme that band was
            plainly visible over the bubble, with the clipped line ghosting
            through it. Fading a colour to itself is the only way to make the mask
            disappear into the surface.

            The alphas are an even-ish ramp on purpose. The previous pair reached
            0.85 at 65 % of the mask, so five sixths of the opacity happened in
            the first two thirds and the result read as an edge with a soft top
            rather than as a fade.
          */
          <LinearGradient
            colors={[withAlpha(fadeTo, 0), withAlpha(fadeTo, 0.45), withAlpha(fadeTo, 0.92), fadeTo]}
            locations={[0, 0.45, 0.82, 1]}
            pointerEvents="none"
            style={{ bottom: 0, height: fade, left: 0, position: 'absolute', right: 0 }}
          />
        ) : null}
      </View>

      {overflows ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={expanded}
          hitSlop={TAP_SLOP}
          onPress={() => onToggle(expanded ? limit - natural : natural - limit)}
          style={{ justifyContent: 'center', marginTop: theme.space.xs, minHeight: 20 }}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Text color="accentText" variant="meta">
            {expanded ? chatStrings.fold.less : chatStrings.fold.more}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
