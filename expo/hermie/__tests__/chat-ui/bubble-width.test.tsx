/**
 * How wide a bubble is allowed to get, measured against the COLUMN it is in.
 *
 * The rule in `design/liquid-glass-tokens.md` §4 is a percentage and a point
 * ceiling, and the percentage is of the chat column. Until this round the
 * percentage lived in the style as `maxWidth: '68%'` on a bubble whose parent
 * was sized by its own `maxWidth` — so Yoga had no base to resolve it against
 * and dropped it, leaving the point cap as the only rule that ever applied. On
 * a 1376pt iPad window that made every bubble exactly 435pt wide no matter how
 * wide the column was, which is what the owner saw and reported as "compact
 * bubbles on a wide window".
 *
 * So the numbers below are absolute points, deliberately: a percentage in a
 * style is a rule nobody can assert, and this file exists because that is how
 * the bug survived two rounds of component tests.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native'

import { Bubble, BubbleColumn, LedgerRow, resolveBubbleWidth, useBubbleWidth } from '../../src/chat-ui'
import { Text } from '../../src/ui/primitives'
import { BUBBLE_MAX, REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_WIDTH, WINDOW_GAP } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13" in landscape, which is what the Mac window reports as well. */
const LANDSCAPE = { width: 1376, height: 1032 }
/** The same device portrait, where 68 % of the column is what binds. */
const PORTRAIT = { width: 1032, height: 1376 }
/** iPhone 17 Pro. */
const PHONE = { width: 402, height: 874 }

function Probe() {
  const max = useBubbleWidth()

  return <Text testID="cap">{String(max)}</Text>
}

/** Render one bubble's cap inside a column of `columnWidth`, once laid out. */
function capInColumn(columnWidth: number): number {
  renderScreen(
    <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
      <Probe />
    </BubbleColumn>
  )

  fireEvent(screen.getByTestId('column'), 'layout', {
    nativeEvent: { layout: { width: columnWidth, height: 800, x: 0, y: 0 } }
  })

  return Number(screen.getByTestId('cap').props.children)
}

describe('the cap on the wide layout', () => {
  it('is 68 % of the CHAT COLUMN, not of the window', () => {
    size(PORTRAIT.width, PORTRAIT.height)

    // The column beside the sidebar: the window less the sidebar, the gap
    // between the panels and the window padding on each side.
    const column = PORTRAIT.width - (SIDEBAR_WIDTH + WINDOW_GAP * 3)
    const percentage = Math.round((column * BUBBLE_MAX.regular.percent) / 100)

    expect(capInColumn(column)).toBe(percentage)

    // And the window is wide enough that reading the rule off IT would have
    // produced the ceiling instead — which is the bug this replaced.
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, PORTRAIT.width)).toBe(BUBBLE_MAX.regular.points)
  })

  it('stops at the point ceiling on a landscape window, where the column is wide enough', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)

    // Beside the sidebar the column is ~994pt: under `wideColumnFrom`, so the
    // base 640 ceiling is the one that binds and 68 % of the column is not.
    const column = LANDSCAPE.width - (SIDEBAR_WIDTH + WINDOW_GAP * 3)

    expect(column).toBeLessThan(BUBBLE_MAX.regular.wideColumnFrom)
    expect(capInColumn(column)).toBe(BUBBLE_MAX.regular.points)

    // With the sidebar collapsed the column is the window, which is past the
    // threshold — so the wide ceiling applies. This is the case the owner was
    // looking at when he reported the empty right half.
    expect(capInColumn(LANDSCAPE.width)).toBe(BUBBLE_MAX.regular.widePoints)
  })

  it('does not fall back to the compact rule because the COLUMN is under the threshold', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)

    // 646pt is narrower than the 700pt layout threshold, and the compact rule
    // would cap it at 320. The layout is wide; the column is merely a column.
    expect(capInColumn(646)).toBeGreaterThan(BUBBLE_MAX.compact.points)
  })
})

describe('the cap on a phone', () => {
  it('is the phone percentage of the window, which is the whole column there', () => {
    size(PHONE.width, PHONE.height)

    expect(capInColumn(PHONE.width)).toBe(Math.round((PHONE.width * BUBBLE_MAX.compact.percent) / 100))
  })

  it('never reaches the compact ceiling on any phone this app supports', () => {
    size(PHONE.width, PHONE.height)

    expect(capInColumn(PHONE.width)).toBeLessThan(BUBBLE_MAX.compact.points)
  })
})

describe('before the column has been laid out', () => {
  it('falls back to the window, so the first frame is not zero-width', () => {
    size(PHONE.width, PHONE.height)
    renderScreen(
      <View>
        <Probe />
      </View>
    )

    expect(Number(screen.getByTestId('cap').props.children)).toBe(resolveBubbleWidth(BUBBLE_MAX.compact, PHONE.width))
  })
})

describe('the rule itself', () => {
  it('is the smaller of the percentage and the ceiling, both halves live', () => {
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, 500)).toBe(340)
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, 1000)).toBe(BUBBLE_MAX.regular.points)
    expect(REGULAR_LAYOUT_MIN_WIDTH).toBeGreaterThan(0)
  })

  it('steps up to the wide ceiling once the column is wide enough to look empty', () => {
    // The owner's window: a ~1500pt content column, where a 640pt bubble uses
    // under half of it and the transcript reads as a strip down one side.
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, 1500)).toBe(BUBBLE_MAX.regular.widePoints)

    // …and not one point below the threshold, so the step is a step.
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, BUBBLE_MAX.regular.wideColumnFrom)).toBe(BUBBLE_MAX.regular.points)
  })
})

/**
 * Which EDGE a bubble hangs off, which is a different question from how wide it
 * may be — and the one the cap was silently answering.
 *
 * The wrapper around a bubble carries the cap as a `maxWidth`. A stretched box
 * with a `maxWidth` is exactly that wide and sits at the start of the row, so an
 * outgoing bubble was right-aligned inside a 640pt box pinned to the LEFT of a
 * 1500pt column: it ended at x≈640 and the right half of the panel was empty.
 * Both facts have to hold at once — capped AND on the correct edge — so they are
 * asserted together.
 */
describe('which edge a bubble hangs off', () => {
  function wrapperStyle(side: 'own' | 'other', columnWidth: number): ViewStyle {
    size(LANDSCAPE.width, LANDSCAPE.height)
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <Bubble side={side} testID="bubble">
          <Text>Hello</Text>
        </Bubble>
      </BubbleColumn>
    )

    fireEvent(screen.getByTestId('column'), 'layout', {
      nativeEvent: { layout: { width: columnWidth, height: 800, x: 0, y: 0 } }
    })

    // The box around the bubble: the bubble itself carries the corners and the
    // cap, this carries the alignment and the tail's gutter.
    return StyleSheet.flatten(screen.getByTestId('bubble-box').props.style as never) as ViewStyle
  }

  it('puts an outgoing bubble on the column’s right edge, still capped', () => {
    const style = wrapperStyle('own', 1500)

    expect(style.alignSelf).toBe('flex-end')
    // Not `stretch`, and not absent — absent IS stretch, which is the bug.
    expect(style.alignSelf).not.toBe('stretch')
    expect(style.maxWidth).toBeLessThanOrEqual(BUBBLE_MAX.regular.widePoints + 7)
  })

  it('puts an incoming bubble on the column’s left edge', () => {
    expect(wrapperStyle('other', 1500).alignSelf).toBe('flex-start')
  })
})

/**
 * The ledger takes the same cap, and only inside the transcript.
 *
 * §6.4 gives tool rows, thinking, cron deliveries and outgoing DMs the bubble's
 * left edge and a different silhouette. They had no right edge at all, so on the
 * wide window a one-line tool row ran the full width of the column while every
 * bubble beside it stopped at 640 — the column read as two layouts stacked on
 * each other. The same rows are drawn by the Activity timeline, which has no
 * column and must keep filling its own box, and that is the whole reason this is
 * a second hook rather than `useBubbleWidth` with a different name.
 */
describe('the ledger cap', () => {
  function ledgerCap(columnWidth: number): unknown {
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <LedgerRow glyph="◌" testID="row" title="Thought for 8s" />
      </BubbleColumn>
    )

    fireEvent(screen.getByTestId('column'), 'layout', {
      nativeEvent: { layout: { width: columnWidth, height: 800, x: 0, y: 0 } }
    })

    return (StyleSheet.flatten(screen.getByTestId('row').props.style as never) as { maxWidth?: unknown }).maxWidth
  }

  it('is the bubble’s number, measured off the same column', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)

    expect(ledgerCap(1000)).toBe(resolveBubbleWidth(BUBBLE_MAX.regular, 1000))
    expect(ledgerCap(1000)).toBe(capInColumn(1000))
  })

  it('is a number on a phone too, not the whole window', () => {
    size(PHONE.width, PHONE.height)

    expect(ledgerCap(PHONE.width)).toBe(resolveBubbleWidth(BUBBLE_MAX.compact, PHONE.width))
  })

  it('is absent outside a transcript, where the row is filling its own box', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    renderScreen(
      <View>
        <LedgerRow glyph="◌" testID="row" title="Thought for 8s" />
      </View>
    )

    expect(
      (StyleSheet.flatten(screen.getByTestId('row').props.style as never) as { maxWidth?: unknown }).maxWidth
    ).toBe(undefined)
  })
})

describe('the bubble itself', () => {
  it('carries the cap as points, never as a percentage nothing can resolve', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <Bubble side="other" testID="bubble">
          <Text>Hello</Text>
        </Bubble>
      </BubbleColumn>
    )

    fireEvent(screen.getByTestId('column'), 'layout', {
      nativeEvent: { layout: { width: 1000, height: 800, x: 0, y: 0 } }
    })

    const style = StyleSheet.flatten(screen.getByTestId('bubble').props.style as never) as { maxWidth?: unknown }

    expect(style.maxWidth).toBe(resolveBubbleWidth(BUBBLE_MAX.regular, 1000))
    expect(typeof style.maxWidth).toBe('number')
  })
})
