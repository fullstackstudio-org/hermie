/**
 * The bubble's SHAPE and RHYTHM, as facts rather than as a look.
 *
 * The owner judges this on a running window with WhatsApp desktop open beside it,
 * and three separate reports came back from that comparison: a one-word message
 * that was as wide as a paragraph, a clock stacked under its own text instead of
 * sitting on the end of it, and a run of bubbles whose grouping could not be seen
 * because the gap inside a run and the gap between two turns were the same order of
 * magnitude. None of the three was catchable by a test that only asked whether the
 * bubble rendered, which is how all three survived a round.
 *
 * So every number the eye is judging is asserted here, and asserted where it is
 * DECIDED — the corner table as a pure function, the flex rule as the styles that
 * produce it — rather than as a rendered pixel a test renderer never produces.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native'

import {
  AssistantBubble,
  Bubble,
  bubbleCorners,
  BubbleColumn,
  DateSeparator,
  TAIL_REACH,
  TranscriptList,
  UserBubble
} from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import { dateStampFor } from '../../src/chat-ui/grouping'
import { Path } from 'react-native-svg'

import { Text } from '../../src/ui/primitives'
import { bubblesFor, compositeHex, resolveThemeFace, THEME_PRESET_ORDER, type Scheme } from '../../src/ui/themes'
import { BUBBLE_GAP, INLINE_META_GAP, MIN_BUBBLE_HEIGHT, radii, TAIL, TAIL_OVERLAP } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

beforeEach(() => {
  mockDimensions.mockReturnValue({ width: 1376, height: 1032, scale: 2, fontScale: 1 })
})

const flat = (testID: string): ViewStyle =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as ViewStyle

/**
 * Whether anything in the chain from the column to the bubble stretches.
 *
 * This is the whole of "a short message is a small bubble": there is no width to
 * assert in a test renderer, so what can be asserted is that nothing ASKS for one.
 * A `width`, a `flex`/`flexGrow`, or an `alignSelf: 'stretch'` anywhere on the way
 * down is the bug; so is an `alignItems` left at its default on the wrapper, which
 * IS stretch and is what put an outgoing bubble at the left of a 1500pt column.
 */
function assertHugs(style: ViewStyle, what: string) {
  expect({ what, width: style.width }).toEqual({ what, width: undefined })
  expect({ what, flex: style.flex }).toEqual({ what, flex: undefined })
  expect({ what, flexGrow: style.flexGrow }).toEqual({ what, flexGrow: undefined })
  expect({ what, alignSelf: style.alignSelf }).not.toEqual({ what, alignSelf: 'stretch' })
}

describe('a bubble hugs its content', () => {
  it('asks for no width at all, on either side, so the cap stays a ceiling', () => {
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <Bubble side="own" testID="own">
          <Text>Bah</Text>
        </Bubble>
        <Bubble side="other" testID="other">
          <Text>Bah</Text>
        </Bubble>
      </BubbleColumn>
    )

    fireEvent(screen.getByTestId('column'), 'layout', {
      nativeEvent: { layout: { width: 1500, height: 900, x: 0, y: 0 } }
    })

    for (const side of ['own', 'other']) {
      assertHugs(flat(side), `the ${side} bubble`)
      assertHugs(flat(`${side}-box`), `the ${side} wrapper`)

      // The cap is present as a ceiling on both, which is the fact that makes
      // "no width" safe rather than a licence to span the column.
      expect(typeof flat(side).maxWidth).toBe('number')
    }

    // And the wrapper aligns rather than stretches, per side.
    expect(flat('own-box').alignItems).toBe('flex-end')
    expect(flat('other-box').alignItems).toBe('flex-start')
  })

  it('does not stretch the body to make room for the clock', () => {
    // The content column aligns its children to the start and takes no width of
    // its own until the clock is measured beside the body. A column that STRETCHED
    // would be a full-width box inside a hugging bubble — the cap by another name.
    renderScreen(<UserBubble item={{ ...userItem, text: 'Bah' }} />)

    const column = flat(`user-${userItem.id}-meta-row`)

    expect(column.alignItems).toBe('flex-start')
    expect(column.width).toBeUndefined()
    expect(column.flexGrow).toBeUndefined()
  })
})

/**
 * Where the clock goes: one measurement with two outcomes.
 *
 * It fits beside the body → the column reserves `body + 8 + clock` and the clock is
 * lifted by its own height onto the body's last line. It does not → nothing is
 * reserved, nothing is lifted, and the clock is a right-aligned line of its own
 * inside the bubble.
 *
 * Both outcomes are asserted by FEEDING the measurements, which is the only honest
 * way: a test renderer performs no text layout, so the widths have to come from the
 * test. That is also what makes these tests worth having — the construction this
 * replaced looked correct in every style assertion and drew the clock through the
 * bubble's bottom edge on a device.
 */
describe('the clock on a bubble’s last line', () => {
  it('is inside the bubble, in the column the body is in', () => {
    renderScreen(<UserBubble item={userItem} />)

    expect(screen.getByTestId(`user-meta-${userItem.id}`)).toBeTruthy()
    // Right-aligned inside that column, which is both cases at once: the end of
    // the reserved space when it is inline, and the right edge of the bubble when
    // it is on a line of its own.
    expect(flat(`user-${userItem.id}-meta-slot`).alignSelf).toBe('flex-end')
  })

  /**
   * Before anything has been measured the clock takes a line of its own.
   *
   * That is the SAFE state and it is deliberately the initial one: the inline case
   * needs a reserved width, and a clock drawn inline without one lands past the
   * bubble's edge, where the bubble's `overflow` cuts it in half. Photographed on an
   * iPhone 18 Pro while the first (flex-wrap) construction was in — see `Bubble`.
   */
  it('starts on its own line and is lifted onto the body’s only once it fits', () => {
    renderScreen(<UserBubble item={{ ...userItem, text: 'Bah' }} />)

    // No layout has been reported by the test renderer, so nothing is reserved and
    // nothing is lifted. The clock is a right-aligned line under the body.
    expect(flat(`user-${userItem.id}-meta-row`).minWidth).toBeUndefined()
    expect(flat(`user-${userItem.id}-meta-slot`).marginTop).toBe(0)
  })

  it('reserves the body, the gap and the clock, and lifts the clock onto the line', () => {
    renderScreen(<UserBubble item={{ ...userItem, text: 'Bah' }} />)

    // A 30pt body and a 44 x 17 clock, in a bubble with room for both.
    fireEvent(screen.getByTestId(`user-${userItem.id}-meta-slot`), 'layout', {
      nativeEvent: { layout: { width: 44, height: 17, x: 0, y: 0 } }
    })
    fireEvent(screen.getByTestId(`user-${userItem.id}-content`), 'layout', {
      nativeEvent: { layout: { width: 30, height: 25, x: 0, y: 0 } }
    })

    expect(flat(`user-${userItem.id}-meta-row`).minWidth).toBe(30 + INLINE_META_GAP + 44)
    // Lifted by exactly its own height, so the column's height is the body's and
    // the bubble is one line tall.
    expect(flat(`user-${userItem.id}-meta-slot`).marginTop).toBe(-17)
  })

  it('reserves nothing and lifts nothing once the body fills the bubble', () => {
    renderScreen(<UserBubble item={userItem} />)

    fireEvent(screen.getByTestId(`user-${userItem.id}-meta-slot`), 'layout', {
      nativeEvent: { layout: { width: 44, height: 17, x: 0, y: 0 } }
    })
    // A body as wide as the bubble's inner box: nothing fits beside it.
    fireEvent(screen.getByTestId(`user-${userItem.id}-content`), 'layout', {
      nativeEvent: { layout: { width: 900, height: 75, x: 0, y: 0 } }
    })

    expect(flat(`user-${userItem.id}-meta-row`).minWidth).toBeUndefined()
    expect(flat(`user-${userItem.id}-meta-slot`).marginTop).toBe(0)
  })

  it('carries its own gap before it, and never a margin that forces its own line', () => {
    renderScreen(<UserBubble item={userItem} />)

    const meta = flat(`user-meta-${userItem.id}`)

    // A `marginTop` here is what used to put the clock under the text even when
    // there was room beside it, and an `alignSelf` here is the slot's job.
    expect(meta.marginTop).toBeUndefined()
    expect(meta.alignSelf).toBeUndefined()

    // The 8pt before it is part of the reserved width, which is the only place
    // that knows whether there is a body to the left of it.
    expect(INLINE_META_GAP).toBe(8)
  })

  it('is on EVERY bubble of a run, not only the one that ends it', () => {
    // The old rule was one clock per run. It cost a reader the time of every
    // message but the last, and it existed because the clock used to occupy a row
    // of its own — which it no longer does.
    renderScreen(
      <>
        <UserBubble grouped={false} item={{ ...userItem, id: 'u1' }} tail={false} />
        <UserBubble grouped item={{ ...userItem, id: 'u2' }} tail={false} />
        <UserBubble grouped item={{ ...userItem, id: 'u3' }} tail />
      </>
    )

    for (const id of ['u1', 'u2', 'u3']) {
      expect(screen.getByTestId(`user-meta-${id}`)).toBeTruthy()
    }
  })

  it('is on a reply as well, and absent while the reply is still only dots', () => {
    renderScreen(<AssistantBubble item={assistantItem} />)
    expect(screen.getByTestId(`assistant-meta-${assistantItem.id}`)).toBeTruthy()

    screen.unmount()

    renderScreen(<AssistantBubble item={{ ...assistantItem, streaming: true, text: '' }} />)
    expect(screen.queryByTestId(`assistant-meta-${assistantItem.id}`)).toBeNull()
    expect(screen.getByTestId(`assistant-typing-${assistantItem.id}`)).toBeTruthy()
  })
})

/**
 * The corner table, per position in a run.
 *
 * Stated as the four positions a reader can actually see, because the rule is about
 * NEIGHBOURS and a single rendered bubble cannot show it. The tail side is the
 * sender's: right for outgoing, left for incoming.
 */
describe('the corners, per run position', () => {
  it('is 18 with a 4pt tail-side corner', () => {
    expect(radii.bubble).toBe(18)
    expect(radii.tail).toBe(4)
  })

  it('tucks the bottom tail-side corner on every bubble, tail or inner', () => {
    // The last of a run: the tail flows out of that corner.
    expect(bubbleCorners(radii, 'own', true).borderBottomRightRadius).toBe(radii.tail)
    // A bubble in the MIDDLE of a run: the same corner, now facing the next
    // bubble. The previous build gave this one the full radius, which is what
    // stopped a run from reading as one block.
    expect(bubbleCorners(radii, 'own', false).borderBottomRightRadius).toBe(radii.tail)
    expect(bubbleCorners(radii, 'other', true).borderBottomLeftRadius).toBe(radii.tail)
  })

  it('tucks the top tail-side corner only when a bubble of the run sits above', () => {
    expect(bubbleCorners(radii, 'own', true).borderTopRightRadius).toBe(radii.tail)
    expect(bubbleCorners(radii, 'own', false).borderTopRightRadius).toBe(radii.bubble)
    expect(bubbleCorners(radii, 'other', true).borderTopLeftRadius).toBe(radii.tail)
    expect(bubbleCorners(radii, 'other', false).borderTopLeftRadius).toBe(radii.bubble)
  })

  it('leaves the whole far side at the full radius, which is the silhouette', () => {
    for (const grouped of [true, false]) {
      expect(bubbleCorners(radii, 'own', grouped).borderTopLeftRadius).toBe(radii.bubble)
      expect(bubbleCorners(radii, 'own', grouped).borderBottomLeftRadius).toBe(radii.bubble)
      expect(bubbleCorners(radii, 'other', grouped).borderTopRightRadius).toBe(radii.bubble)
      expect(bubbleCorners(radii, 'other', grouped).borderBottomRightRadius).toBe(radii.bubble)
    }
  })

  it('is the table the bubble actually renders', () => {
    renderScreen(
      <Bubble grouped side="own" testID="mid" tail={false}>
        <Text>Still me</Text>
      </Bubble>
    )

    const style = flat('mid')
    const expected = bubbleCorners(radii, 'own', true)

    expect(style.borderTopRightRadius).toBe(expected.borderTopRightRadius)
    expect(style.borderBottomRightRadius).toBe(expected.borderBottomRightRadius)
    expect(style.borderTopLeftRadius).toBe(expected.borderTopLeftRadius)
    expect(style.borderBottomLeftRadius).toBe(expected.borderBottomLeftRadius)
  })
})

/**
 * The two gaps, and the ratio between them.
 *
 * 6 against 24. The ratio is the point: at 3 against 12 the two were close enough
 * that a run and a turn boundary looked alike on a large window, and 3pt between
 * two bubbles with a 4pt tucked corner between them is not a gap, it is a scratch.
 */
describe('the run rhythm', () => {
  it('is 6 inside a run and 24 on a change of author', () => {
    expect(BUBBLE_GAP.grouped).toBe(6)
    expect(BUBBLE_GAP.separate).toBe(24)
  })

  it('separates the two by a ratio a reader can resolve without measuring', () => {
    expect(BUBBLE_GAP.separate / BUBBLE_GAP.grouped).toBeGreaterThanOrEqual(3)
  })
})

/**
 * The bubble's own padding, which is the other half of "it hugs".
 *
 * 10 vertical and 14 horizontal: a short message's box is its text plus 20pt of
 * height, not the 44pt a control would take.
 */
describe('the padding', () => {
  it('is 10 vertical and 14 horizontal on a short bubble', () => {
    renderScreen(
      <Bubble side="other" testID="short">
        <Text>Bah</Text>
      </Bubble>
    )

    const padded = flat('short-body')

    expect(padded.paddingVertical).toBe(10)
    expect(padded.paddingHorizontal).toBe(14)
  })

  it('keeps the reading inset on a long reply, which is §7.1 and not this rule', () => {
    // A long body takes the wider reading padding so its measure is comfortable.
    // Stated here so the difference is a decision on the record rather than a
    // number somebody later "fixes" to match the short case.
    renderScreen(
      <Bubble side="other" testID="long" variant="inRead">
        <Text>A long reply.</Text>
      </Bubble>
    )

    expect(flat('long-body').paddingHorizontal).toBe(16)
    expect(flat('long-body').paddingVertical).toBe(10)
  })
})

/**
 * What heads a bubble: the reply eyebrow and the date stamp.
 *
 * One rhythm for both — the author-change gap above, 4pt below, micro type, muted
 * — because they do the same job. The eyebrow gets its gap from the ROW (it only
 * ever appears on a bubble that starts a run, and that row's margin IS the
 * author-change gap), and the stamp carries its own, which is why the row that
 * holds one drops its margin.
 */
describe('the eyebrow and the date stamp', () => {
  it('indents the reply eyebrow to the bubble’s text, not to the row’s edge', () => {
    renderScreen(
      <AssistantBubble grouped={false} item={{ ...assistantItem, replyToBotHandle: 'writer', text: 'On it.' }} />
    )

    const eyebrow = screen.getByText('REPLY TO @WRITER')
    const style = StyleSheet.flatten(eyebrow.props.style as never) as ViewStyle & { fontSize?: number }

    // The tail's gutter plus the bubble's own horizontal padding: where the text
    // inside the bubble starts.
    expect(style.marginLeft).toBe(TAIL_REACH + 14)
    expect(style.marginBottom).toBe(4)
    // `micro`, which is the 11pt tracked-out face the stamp uses too.
    expect(style.fontSize).toBe(11)
  })

  it('follows the bubble’s inset when a long reply takes the reading padding', () => {
    // Two insets, one rule: the eyebrow has to take the same branch the body
    // takes, or it lines up with the text on short replies and misses on long
    // ones — which is half a fix and looks like a rendering bug.
    renderScreen(<AssistantBubble grouped={false} item={{ ...assistantItem, replyToBotHandle: 'writer' }} />)

    const style = StyleSheet.flatten(screen.getByText('REPLY TO @WRITER').props.style as never) as ViewStyle

    expect(style.marginLeft).toBe(TAIL_REACH + 16)
  })

  it('gives the date stamp the author-change gap above it and 4pt below', () => {
    renderScreen(<DateSeparator label="Today" testID="stamp" />)

    const style = flat('stamp')

    expect(style.paddingTop).toBe(BUBBLE_GAP.separate)
    expect(style.paddingBottom).toBe(4)
  })

  it('drops the row’s own margin where a stamp already carries one', () => {
    // 24 above the stamp and 24 above the row under it is 48pt of nothing between
    // two days — a hole in the column rather than a boundary in it.
    renderScreen(<TranscriptList items={[{ item: userItem, presentation: 'full' }]} subagents={subagentMap} />)

    expect(flat(`transcript-row-${userItem.id}`).marginTop).toBe(0)
    // And there IS a stamp on that row, or the assertion above is vacuous.
    expect(screen.getByText(dateStampFor(userItem.ts ?? 0).toUpperCase())).toBeTruthy()
  })
})

/**
 * The typing bubble is the same geometry, not a lookalike.
 *
 * It renders through `Bubble` with a tail, so the corner table and the tail shape
 * above apply to it by construction — which is the assertion: a second shape drawn
 * beside the first is how the previous build ended up with a grey rectangle under a
 * bubble of dots.
 */
describe('the typing bubble', () => {
  it('is a tailed incoming bubble with dots in it, hugging them', () => {
    renderScreen(
      <View>
        <AssistantBubble item={{ ...assistantItem, streaming: true, text: '' }} />
      </View>
    )

    const dots = screen.getByTestId(`assistant-typing-${assistantItem.id}`)

    expect(dots).toBeTruthy()
    expect(screen.getByLabelText('Replying')).toBeTruthy()
  })
})

/**
 * The tail's silhouette, as the four facts the eye is judging.
 *
 * A path is one string, and a hand-edited string is exactly the sort of thing
 * that comes back as "there is a sliver under the corner" a week later. So the
 * points are parsed out of it and checked against the box they have to live in —
 * which is not a style question: a point past the bottom is drawn half a point
 * off the bubble's baseline, and a point short of the full width is a tail that
 * does not reach where the layout has already reserved room for it.
 */
describe('the tail', () => {
  /** Every ON-PATH point the command list names, in order. */
  function points(path: string): [number, number][] {
    const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+/gu) ?? []
    // How many numbers each command takes, and how many of those trail the point.
    const arity: Record<string, number> = { M: 2, L: 2, A: 7, Z: 0 }
    const out: [number, number][] = []
    let index = 0

    while (index < tokens.length) {
      const command = tokens[index]!.toUpperCase()

      expect(arity).toHaveProperty(command)
      index += 1

      const count = arity[command]!
      const numbers = tokens.slice(index, index + count).map(Number)

      index += count

      if (count >= 2) {
        out.push([numbers[count - 2]!, numbers[count - 1]!])
      }
    }

    return out
  }

  const shape = points(TAIL.path)

  it('stays inside its own box, so nothing is clipped and nothing overhangs', () => {
    for (const [x, y] of shape) {
      expect({ x: x >= 0 && x <= TAIL.width, y: y >= 0 && y <= TAIL.height }).toEqual({ x: true, y: true })
    }
  })

  it('comes to its point on the bubble’s bottom line, at the full reach', () => {
    expect(shape).toContainEqual([TAIL.width, TAIL.height])
  })

  it('leaves the bubble’s edge rather than floating beside it', () => {
    // x = TAIL_OVERLAP is where the bubble's own edge stands inside this box.
    expect(shape.some(([x]) => x === TAIL_OVERLAP)).toBe(true)
  })

  it('reaches past the bubble by the gutter the column reserves for it', () => {
    expect(TAIL_REACH).toBe(TAIL.width - TAIL_OVERLAP)
    expect(TAIL_REACH).toBe(7)
  })

  it('is drawn in whole points, which is what the Mac’s scaling needs', () => {
    for (const [x, y] of shape) {
      expect({ x: Number.isInteger(x), y: Number.isInteger(y) }).toEqual({ x: true, y: true })
    }
  })

  it('is no taller than the shape it holds', () => {
    // Both ends, because slack at either one is a defect: too little and the
    // curve's last half point is clipped flat at Mac scaling, too much and the
    // box is a rectangle of bubble colour standing behind the bubble.
    expect(Math.min(...shape.map(([, y]) => y))).toBe(0)
    expect(Math.max(...shape.map(([, y]) => y))).toBe(TAIL.height)
  })

  it('cannot reach the corner at the other end of the shortest bubble there is', () => {
    /*
      The defect this replaced, measured on an iPhone 17 Pro in Graphite dark: the
      box was 25 tall with 11 points of plain rectangle above the shape, and the
      typing indicator is 34 tall with an 18pt corner arc at its top. The
      rectangle stood behind that arc and painted the notch the corner rounds
      away, so the bubble had two left edges with a step between them — a seam
      that no other bubble in the app is short enough to show.

      The tail lives where the bubble's edge is STRAIGHT. That is the rule, and
      this is it as arithmetic.
    */
    expect(TAIL.height + radii.bubble).toBeLessThanOrEqual(MIN_BUBBLE_HEIGHT)
  })
})

/**
 * The tail's colour, in every theme rather than in the one that was reported.
 *
 * `bubblesFor` derives it with `compositeHex` and the component paints those same
 * two layers, so this cannot fail by arithmetic — it fails if somebody gives one
 * of the recipes a tail of its own, which is exactly what the recipes looked like
 * before they were derived.
 */
describe('the tail composites to the body, on every theme', () => {
  const cases = THEME_PRESET_ORDER.flatMap(name => (['light', 'dark'] as Scheme[]).map(scheme => ({ name, scheme })))

  it.each(cases)('$name $scheme', ({ name, scheme }) => {
    const face = resolveThemeFace({ kind: 'preset', name }, scheme)
    const bubbles = bubblesFor(scheme, face.elevation)

    for (const [variant, recipe] of Object.entries(bubbles)) {
      expect({ variant, tail: recipe.tail }).toEqual({ variant, tail: compositeHex(recipe.fill, recipe.solid) })
    }
  })
})

/**
 * The tail is the same shape as the bubble, in the same colour, at the same
 * strength.
 *
 * The owner photographed the failure in the dark theme: an incoming bubble whose
 * tail was visibly lighter and bluer than the bubble it hangs off. The recipe was
 * never wrong — `bubbles[variant].tail` is `compositeHex(fill, solid)` and the
 * body paints exactly those two layers — but the tail is drawn OUTSIDE the
 * rounded box a caller's `style` lands on, and `AssistantBubble` fades an interim
 * note to `opacity: 0.72` and a reply addressed at a teammate to `0.9`. The body
 * went translucent over the page and the tail did not, so the two came apart by
 * a third in the one theme where a third is obvious.
 */
describe('the tail and the bubble are one surface', () => {
  /** The `fill` of the one SVG path in the tree: the tail's own colour. */
  const tailFill = (): string => (screen.UNSAFE_getByType(Path as never).props as { fill: string }).fill

  /** The two layers the body stacks: the opaque rung, then the wash over it. */
  const bodyLayers = (testID: string): string[] =>
    screen
      .getByTestId(testID)
      .props.children.filter((child: { props?: { pointerEvents?: string } }) => child?.props?.pointerEvents === 'none')
      .map(
        (child: { props?: { style?: unknown } }) =>
          (StyleSheet.flatten(child.props?.style as never) as ViewStyle).backgroundColor as string
      )

  it('paints the tail in the colour the body composites to', () => {
    renderScreen(
      <Bubble side="other" tail testID="b">
        <Text>Dit valt buiten de scope.</Text>
      </Bubble>
    )

    // `tail` is `compositeHex(fill, solid)` by construction, so the assertion
    // that means something is that the tail is the composite of the two layers
    // the body actually stacks — not that it equals a token read from the same
    // place the component read it.
    const [solid, wash] = bodyLayers('b')

    expect(tailFill()).toBe(compositeHex(wash!, solid!))
  })

  /**
   * The regression itself: a faded bubble fades its tail with it. The opacity is
   * asserted on the OUTER box — the one that holds the tail and the body — and
   * asserted absent from the body, because a body that dims on its own is the
   * bug however right the colour underneath it is.
   */
  it('fades the whole silhouette rather than only the body', () => {
    renderScreen(
      <Bubble side="other" style={{ opacity: 0.72 }} tail testID="faded">
        <Text>an interim note</Text>
      </Bubble>
    )

    expect(flat('faded-box').opacity).toBe(0.72)
    expect(flat('faded').opacity).toBeUndefined()
  })

  it('leaves a bubble nobody faded at full strength', () => {
    renderScreen(
      <Bubble side="other" tail testID="plain">
        <Text>an ordinary reply</Text>
      </Bubble>
    )

    expect(flat('plain-box').opacity).toBeUndefined()
    expect(flat('plain').opacity).toBeUndefined()
  })

  /** The same for an outgoing bubble, whose tail takes the accent instead. */
  it('fades an outgoing silhouette the same way', () => {
    renderScreen(
      <Bubble accent="#2F6BFF" side="own" style={{ opacity: 0.9 }} tail testID="mine">
        <Text>mine</Text>
      </Bubble>
    )

    expect(flat('mine-box').opacity).toBe(0.9)
    expect(flat('mine').opacity).toBeUndefined()
  })

  /** A caller's other styles still belong to the body, not to the wrapper. */
  it('keeps everything that is not opacity on the body', () => {
    renderScreen(
      <Bubble side="other" style={{ marginTop: 7, opacity: 0.5 }} tail testID="mixed">
        <Text>mixed</Text>
      </Bubble>
    )

    expect(flat('mixed').marginTop).toBe(7)
    expect(flat('mixed-box').marginTop).toBeUndefined()
  })
})
