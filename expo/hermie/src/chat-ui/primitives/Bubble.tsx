/**
 * A speech bubble, and the only thing in the kit allowed to be one.
 *
 * Geometry from `design/liquid-glass-tokens.md` §4 and §6.1: radius 18 with a 4pt
 * corner down the sender's side, a width cap that is a percentage plus a point
 * cap, and a tail that is ONE path belonging to the bubble.
 *
 * **The bubble hugs its content.** Nothing here sets a width, and the wrapper
 * aligns rather than stretches, so a one-word message is a one-word bubble: its
 * width is the text, the clock that shares the line with it, and the padding. The
 * cap is a ceiling and never a size — see `bubble-geometry.test.tsx`, which asserts
 * exactly that, because "it looked right on my window" is how the opposite
 * survived a round.
 *
 * Four things here are load-bearing and should not be "tidied":
 *
 *  - **The tail is an SVG path.** The previous build built it from positioned
 *    `View`s: a small square with one rounded corner, offset `-5`, tucked under
 *    the bubble's edge. On the owner's Mac build that showed as a ~10pt square of
 *    bubble colour protruding past the bottom-right corner with a notch in it,
 *    plus a dark vertical sliver where the square's box was wider than the
 *    bubble's own. A rectangle has square corners and a sibling view has an
 *    anti-aliased edge; neither problem exists for a path with the tail's actual
 *    silhouette.
 *  - **The tail is drawn BEHIND the bubble, not inside it.** Only the part that
 *    escapes the bubble's rounded corner is visible, so the join can never show
 *    as a seam or a band. Both are one flat colour now — the outgoing gradient is
 *    gone (the owner's verdict: gradients look generated) — but behind is still
 *    where the tail belongs: drawn on top it would paint its own anti-aliased
 *    edge across the bubble's.
 *  - **Every offset is a whole point.** The Mac renders the iPad build scaled,
 *    so a sub-point offset that is invisible at 3x is a visible sliver there. The
 *    tail's own width is the wrapper's padding, which keeps it inside the column
 *    instead of hanging over the list's gutter.
 *  - **An incoming bubble is not a `GlassSurface`.** §7.4: no blur view per row —
 *    a virtualised list with one per bubble is the fastest way to make a long
 *    report scroll badly, and on Android there are none at all. The glass recipe
 *    is composited by hand, and a long reply swaps it for the near-opaque reading
 *    wash so its contrast stops being a function of the wallpaper.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { useTheme } from '../../ui/theme'
import {
  BUBBLE_MAX,
  INLINE_META_GAP,
  REGULAR_LAYOUT_MIN_WIDTH,
  TAIL,
  TAIL_OVERLAP,
  type BubbleVariant,
  type ResolvedBubbleWidth
} from '../../ui/tokens'
import { useBubbleColumnWidth } from './BubbleColumn'

export interface BubbleProps {
  side: 'own' | 'other'
  /**
   * Which recipe paints the interior.
   *
   * `own` ignores it — an outgoing bubble is the chat's accent — so the variant
   * only ever describes an incoming one.
   */
  variant?: BubbleVariant
  /**
   * The outgoing bubble's flat fill, from `useChatAccent`.
   *
   * Passed in rather than read here: the bubble does not know which chat it is
   * in, and the accent is one lookup per screen rather than one per row.
   */
  accent?: string
  /** Draws the tail. Only the LAST bubble of a group gets one. */
  tail?: boolean
  /** Continues a run: the top corner on the sender's side tucks in too. */
  grouped?: boolean
  children: ReactNode
  /**
   * The clock, and on an outgoing bubble the ticks — placed ON the body's last
   * line where there is room for it, and on a line of its own where there is not.
   *
   * A prop rather than something the caller stacks under `children`, because
   * "on the last line, or on a line of its own" is one decision about two
   * siblings and neither sibling can make it alone. See `useInlineMeta` below.
   */
  meta?: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * How far the tail sticks out past the bubble. A whole number, deliberately.
 *
 * Exported because anything drawn ABOVE a bubble and meant to line up with its
 * text has to clear the same gutter — the reply eyebrow, a sender chip — and a
 * second copy of the number is a second thing to forget when the tail changes.
 */
export const TAIL_REACH = TAIL.width - TAIL_OVERLAP

/**
 * The bubble's own horizontal padding: how far its body sits in from its edge.
 *
 * A long reply takes the wider reading padding (§7.1), so "where does the text
 * start" is not one number, and a caller that wants to align to it needs the same
 * branch rather than a guess at the common case.
 */
export function bubblePaddingX(space: { md: number; lg: number }, reading: boolean): number {
  return reading ? space.lg : space.md + 2
}

/**
 * How much room a BLOCK inside a bubble has, in points.
 *
 * The cap minus the padding on both sides — the width a table or a fenced
 * listing may occupy before it has to scroll instead. It is a hook and not a
 * measurement because it CANNOT be measured from inside: the bubble's body sits
 * under `alignItems: 'flex-start'` so it can hand the clock its natural width,
 * and everything below that is therefore sized by this very content. See
 * `src/markdown/OverflowScroll.tsx` for what that costs when nobody supplies
 * the number.
 *
 * The cap rather than the bubble's actual width, which is the right answer for
 * both: a bubble narrower than the cap is narrower because its content is, and
 * content that overflows is by definition at the cap.
 */
export function useBubbleContentWidth(reading: boolean): number {
  const theme = useTheme()
  const max = useBubbleWidth()

  return Math.max(0, max - bubblePaddingX(theme.space, reading) * 2)
}

/**
 * The cap a bubble may grow to, in points.
 *
 * Both halves of §4's rule matter: the percentage keeps a short line off the far
 * gutter, and the point cap is what stops a long report from spanning a Mac
 * window. They are resolved to ONE number here rather than left as two styles,
 * because a percentage in the style resolves against whatever Yoga decides the
 * parent is — which, for a parent sized by its own `maxWidth`, is nothing at all.
 *
 * Which RULE applies is the layout's question: a phone reads a 68 % bubble as a
 * narrow ribbon, hence the wider percentage below the threshold. Which NUMBER it
 * produces is the COLUMN's, because the column is the box the bubble is in — on
 * the wide layout that is the chat panel, not the window that also holds the
 * sidebar.
 */
export function useBubbleWidth(): number {
  const { width } = useWindowDimensions()
  const column = useBubbleColumnWidth()
  const rule = width >= REGULAR_LAYOUT_MIN_WIDTH ? BUBBLE_MAX.regular : BUBBLE_MAX.compact

  return resolveBubbleWidth(rule, column ?? width)
}

/** The rule applied to one column width. Exported so a test can state both. */
export function resolveBubbleWidth(rule: ResolvedBubbleWidth, columnWidth: number): number {
  // The wide ceiling only exists on the regular rule, and only above the column
  // width where the base one starts to look mean. See `BUBBLE_MAX`.
  const points = 'widePoints' in rule && columnWidth > rule.wideColumnFrom ? rule.widePoints : rule.points

  return Math.round(Math.min((columnWidth * rule.percent) / 100, points))
}

/**
 * The same cap, for the things in the ledger that are not bubbles.
 *
 * §6.4 puts tool rows, thinking, cron deliveries and outgoing DMs in the bot's
 * gutter — "same left edge, distinct silhouette". They had the left edge and no
 * right one, so on a wide window a one-line tool row and a cron card ran the
 * full width of the column while every bubble beside them stopped at 640pt. The
 * column reads as two different layouts stacked on each other.
 *
 * `undefined` OUTSIDE a transcript, which is the difference from
 * `useBubbleWidth`: a bubble with no column still needs a number so its first
 * frame is not zero-width, whereas a ledger row rendered somewhere else — the
 * Activity timeline, a gallery section — is filling that box on purpose and must
 * keep doing so.
 */
export function useLedgerWidth(): number | undefined {
  const { width } = useWindowDimensions()
  const column = useBubbleColumnWidth()

  if (column === null) {
    return undefined
  }

  return resolveBubbleWidth(width >= REGULAR_LAYOUT_MIN_WIDTH ? BUBBLE_MAX.regular : BUBBLE_MAX.compact, column)
}

/**
 * The tail.
 *
 * The box is the shape's own extent exactly — no slack, in either direction.
 *
 * Not too little: the previous path was drawn with control points that overshot
 * its nominal height, so the view had to be a point taller than the shape to keep
 * the curve's last half point from being clipped into a flat edge at Mac scaling.
 * `TAIL.path` is derived rather than eyeballed and touches 0 and `TAIL.height` and
 * nothing beyond them.
 *
 * And not too MUCH: a box taller than the shape is a rectangle of bubble colour
 * standing behind the bubble, and on a short bubble it stands behind the rounded
 * corner at the other end — where the bubble is not painting, and the rectangle
 * is. `TAIL` has the measurement that found it.
 */
function Tail({ side, color }: { side: 'own' | 'other'; color: string }) {
  const own = side === 'own'

  return (
    <View
      // Decorative: the shape is the bubble's silhouette, not an object of its
      // own, so it is hidden from assistive technology entirely.
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        bottom: 0,
        height: TAIL.height,
        position: 'absolute',
        width: TAIL.width,
        ...(own ? { right: 0 } : { left: 0 }),
        // Mirroring is the whole difference between the two sides; there is no
        // second path and no second set of numbers to keep in step.
        ...(own ? {} : { transform: [{ scaleX: -1 }] })
      }}
    >
      <Svg height={TAIL.height} viewBox={`0 0 ${TAIL.width} ${TAIL.height}`} width={TAIL.width}>
        <Path d={TAIL.path} fill={color} />
      </Svg>
    </View>
  )
}

/**
 * The four corners, from the two facts a row knows about its neighbours.
 *
 * The rule is stated on the TAIL SIDE — right for an outgoing bubble, left for an
 * incoming one — because that is the side a run is built along:
 *
 *  - **Bottom, tail side: always tucked.** Either the tail flows out of it (this
 *    is the last bubble of the run) or the next bubble of the run sits under it
 *    (this is an inner corner). Both want the small radius, so `tail` does not
 *    appear in this table at all any more — it decides whether the SHAPE is drawn,
 *    not what the corner measures. The previous build gave a mid-run bubble its
 *    full radius here, which put a 22pt arc between two bubbles 3pt apart: the run
 *    read as separate lozenges, not as one block.
 *  - **Top, tail side: tucked only when a bubble of the same run sits above.**
 *  - **Everything on the far side: full.** That asymmetry IS the silhouette — a
 *    straight-ish edge down the sender's side and a fully rounded one away from
 *    it.
 *
 * Exported so a test can state the table rather than re-derive it from a rendered
 * style, and so the four cases can be named per run position.
 */
export function bubbleCorners(
  radii: { bubble: number; tail: number },
  side: 'own' | 'other',
  grouped: boolean
): Pick<
  ViewStyle,
  'borderBottomLeftRadius' | 'borderBottomRightRadius' | 'borderTopLeftRadius' | 'borderTopRightRadius'
> {
  const own = side === 'own'
  const topTailSide = grouped ? radii.tail : radii.bubble

  return {
    borderBottomLeftRadius: own ? radii.bubble : radii.tail,
    borderBottomRightRadius: own ? radii.tail : radii.bubble,
    borderTopLeftRadius: own ? radii.bubble : topTailSide,
    borderTopRightRadius: own ? topTailSide : radii.bubble
  }
}

/**
 * The body and its clock, sharing a line where the line has room.
 *
 * ### Why this is measured rather than wrapped
 *
 * The obvious construction is a `flexWrap: 'wrap'` row — body and clock fit, the
 * clock sits at the end of the line; they do not, Yoga moves it to the next one.
 * It was built that way first and it is wrong on a device: inside a box that HUGS
 * its content, Yoga sizes a wrapping container from the first pass and reports the
 * height of one line even when it has laid two out. The clock ended up drawn below
 * the bubble's bottom edge and clipped in half by the bubble's own `overflow`.
 * Photographed on an iPhone 18 Pro (iOS 27) before it was replaced — see
 * `docs/platform-notes.md`. Three variants of the same idea did the same thing,
 * because it is the interaction between hugging and wrapping and not the details.
 *
 * So the decision is made from two measurements instead, and the geometry is plain
 * flexbox that cannot be measured wrong:
 *
 *  - The content column takes a `minWidth` of `body + gap + clock` when the clock
 *    fits beside the body. That is what reserves the space, and it is why the
 *    bubble ends up exactly as wide as text-plus-clock-plus-padding.
 *  - The clock is `alignSelf: 'flex-end'` and is pulled UP by its own height, so it
 *    lands on the body's last line, at the right-hand end of the reserved space.
 *  - When it does not fit, both of those are off: no reserved width, no pull, and
 *    the clock is a right-aligned line of its own inside the bubble — which is the
 *    second half of the rule, not a fallback.
 *
 * **The body's own measurement can never move.** It is taken on a view inside the
 * column, and only the COLUMN grows — so the number that decides is not changed by
 * the decision, and there is no oscillation at the boundary.
 *
 * What this does NOT do is measure the last RENDERED line. The unit is the body
 * block: a one-line message takes the inline case and a body that wrapped takes the
 * own-line case, which are the two the rule names. A two-line body whose second
 * line happens to be short still gets its own line for the clock, because the width
 * of that line is a fact only the text layout engine has and it does not report it.
 * `design/README.md` records that as a deviation.
 */
function useInlineMeta(inner: number): {
  inline: boolean
  reserve: number
  lift: number
  onBody: (event: LayoutChangeEvent) => void
  onMeta: (event: LayoutChangeEvent) => void
} {
  const [body, setBody] = useState(0)
  const [meta, setMeta] = useState({ height: 0, width: 0 })

  const onBody = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout

    // Layout fires on every pass; only a real move is worth a render, which in a
    // virtualised list is the difference between one extra pass per cell and one
    // per frame.
    setBody(current => (Math.abs(current - width) < 0.5 ? current : width))
  }, [])

  const onMeta = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout

    setMeta(current =>
      Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5 ? current : { height, width }
    )
  }, [])

  const inline = body > 0 && meta.width > 0 && body + INLINE_META_GAP + meta.width <= inner

  return {
    inline,
    lift: inline ? -meta.height : 0,
    onBody,
    onMeta,
    reserve: inline ? body + INLINE_META_GAP + meta.width : 0
  }
}

export function Bubble({
  side,
  variant = 'in',
  accent,
  tail = true,
  grouped = false,
  children,
  meta,
  style,
  testID
}: BubbleProps) {
  const theme = useTheme()
  const max = useBubbleWidth()
  const own = side === 'own'
  const recipe = theme.bubbles[variant]
  const fill = own ? accent : undefined
  const reading = variant === 'inRead' || variant === 'dmRead'
  const corners = bubbleCorners(theme.radii, side, grouped)
  const paddingX = bubblePaddingX(theme.space, reading)
  const clock = useInlineMeta(max - paddingX * 2)

  const tailColor = own ? (fill ?? theme.accent().bubble) : recipe.tail
  /*
    A caller's `opacity` belongs to the SILHOUETTE, not to the body.

    `style` lands on the rounded box, and the tail is drawn outside that box —
    so an interim note (0.72) and a reply addressed at a teammate (0.9) faded the
    body toward the page behind it and left the tail at full strength. In the
    dark theme that reads exactly as reported: a tail lighter and bluer than the
    bubble it belongs to. Hoisting the one property that makes a layer
    translucent onto the box that holds BOTH keeps them one shape; everything
    else in `style` is still the body's.
  */
  const flat = StyleSheet.flatten(style) ?? {}
  const { opacity, ...bodyStyle } = flat

  return (
    <View
      style={{
        alignItems: own ? 'flex-end' : 'flex-start',
        // `alignSelf` and NOT the default stretch, which is the whole of the
        // owner's "the right half of the panel is empty" report. A stretched box
        // with a `maxWidth` is exactly `maxWidth` wide and sits at the START of
        // the row, so an outgoing bubble was right-aligned inside a 640pt box
        // pinned to the LEFT edge of a 1500pt column — it ended at x≈640 with
        // half the panel blank beside it. Aligning the box itself makes the cap
        // a cap on the bubble rather than a width for the row, so an outgoing
        // one hugs the column's right edge and an incoming one its left, which
        // is what §6.1 means by the two sides.
        alignSelf: own ? 'flex-end' : 'flex-start',
        maxWidth: max + TAIL_REACH,

        // The tail lives in this padding rather than hanging over the list's
        // gutter, so the bubble and its tail are one box as far as layout is
        // concerned.
        ...(own ? { paddingRight: TAIL_REACH } : { paddingLeft: TAIL_REACH }),
        ...(opacity === undefined ? {} : { opacity })
      }}
      // The alignment lives here and the cap lives here, so this is the box a
      // test has to be able to reach: asserting the bubble's own style proves
      // only half the rule.
      testID={testID ? `${testID}-box` : undefined}
    >
      {tail ? <Tail color={tailColor} side={side} /> : null}

      <View style={[corners, { maxWidth: max, overflow: 'hidden' }, bodyStyle]} testID={testID}>
        {/*
          One flat field, and under a translucent incoming recipe the rung it
          composites onto. `own` needs no rung: its accent has no alpha.

          This was a two-stop vertical gradient. The owner's verdict on gradients
          is that they look generated, and a messenger's outgoing bubble is one
          saturated colour with one ink on it — which is also why the tail below
          is now trivially the same colour as the bubble instead of having to
          match its lower stop.
        */}
        {own ? null : (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: recipe.solid }]} />
        )}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: own ? (fill ?? theme.accent().bubble) : recipe.fill }]}
        />

        <View
          style={{ paddingHorizontal: paddingX, paddingVertical: theme.space.sm + 2 }}
          // The padded box, which is where "10 vertical, 14 horizontal" lives. A
          // test that asserts the bubble's own style asserts the corners and
          // learns nothing about the inset the text actually gets.
          testID={testID ? `${testID}-body` : undefined}
        >
          {meta ? (
            <View
              style={{ alignItems: 'flex-start', minWidth: clock.reserve || undefined }}
              testID={testID ? `${testID}-meta-row` : undefined}
            >
              {/*
                The body's own box, and the thing that is MEASURED. It is separate
                from the column above it on purpose: the column is what grows to
                reserve the clock's space, so measuring the column would feed the
                decision back into itself and oscillate at the boundary.
              */}
              <View onLayout={clock.onBody} testID={testID ? `${testID}-content` : undefined}>
                {children}
              </View>

              <View
                onLayout={clock.onMeta}
                style={{ alignSelf: 'flex-end', marginTop: clock.lift }}
                testID={testID ? `${testID}-meta-slot` : undefined}
              >
                {meta}
              </View>
            </View>
          ) : (
            children
          )}
        </View>
      </View>
    </View>
  )
}
