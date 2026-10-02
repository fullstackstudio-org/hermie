/**
 * The error card takes the column rule, and its Retry takes its own width.
 *
 * §6.4 puts everything in the ledger in the bot's gutter with the bubble's cap.
 * The error card was the last one still without it: on an iPad Pro 13" in
 * portrait it ran the full 620pt of the transcript while every bubble beside it
 * stopped at 439, so the one row that reports a failure was also the widest
 * thing on the screen. Its Retry stretched the same distance — a one-word action
 * 600pt wide reads as the card's bottom edge, not as a button.
 *
 * Both halves are asserted against a laid-out `BubbleColumn`, because the cap is
 * a number the column produces and a percentage nothing can resolve was the
 * original bug (see `bubble-width.test.tsx`).
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native'

import { BubbleColumn, resolveBubbleWidth } from '../../src/chat-ui'
import { ErrorCard } from '../../src/chat-ui/ErrorCard'
import { BUBBLE_MAX, CONTROL_MIN_HEIGHT } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13" portrait, and the chat column it leaves beside the sidebar. */
const PORTRAIT = { width: 1032, height: 1376 }
const COLUMN = 646

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<string, unknown>

function inColumn(columnWidth: number) {
  renderScreen(
    <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
      <ErrorCard message="The gateway is unreachable." onRetry={jest.fn()} retryable testID="err" />
    </BubbleColumn>
  )

  fireEvent(screen.getByTestId('column'), 'layout', {
    nativeEvent: { layout: { width: columnWidth, height: 800, x: 0, y: 0 } }
  })
}

describe('the error card inside a transcript', () => {
  it('takes the bubble’s cap off the same column', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    expect(flat('err').maxWidth).toBe(resolveBubbleWidth(BUBBLE_MAX.regular, COLUMN))
  })

  it('carries the cap as points, never as a percentage nothing can resolve', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    expect(typeof flat('err').maxWidth).toBe('number')
  })

  it('keeps the companion margin that holds it off the gutter', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    expect(flat('err').marginRight).toBe(26)
  })

  it('stops well short of the column it sits in', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    expect(flat('err').maxWidth as number).toBeLessThan(COLUMN)
  })
})

describe('the error card outside a transcript', () => {
  it('has no cap, because it is filling its own box on purpose', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    renderScreen(
      <View>
        <ErrorCard message="The gateway is unreachable." onRetry={jest.fn()} retryable testID="err" />
      </View>
    )

    expect(flat('err').maxWidth).toBe(undefined)
  })
})

describe('the Retry button', () => {
  it('is its own width rather than the card’s', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    expect(flat('err-retry').alignSelf).toBe('flex-start')
  })

  it('is still a full-height touch target', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    // The 44pt minimum lives on the view INSIDE `Button`'s pressable, so what
    // has to be proved is that narrowing the pressable did not shorten it —
    // which means reading the rendered child rather than the prop we passed.
    const inner = StyleSheet.flatten(
      (screen.getByTestId('err-retry').children[0] as { props: { style: unknown } }).props.style as never
    ) as { minHeight?: number }

    expect(inner.minHeight).toBe(CONTROL_MIN_HEIGHT)
  })

  it('does not set a width or a height of its own beyond the alignment', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    inColumn(COLUMN)

    const style = flat('err-retry')

    expect(style.width).toBe(undefined)
    expect(style.height).toBe(undefined)
  })

  it('is absent on a recoverable failure, which the backend is still holding', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <ErrorCard message="Connection lost." onRetry={jest.fn()} recoverable testID="err" />
      </BubbleColumn>
    )

    expect(screen.queryByTestId('err-retry')).toBeNull()
  })
})
