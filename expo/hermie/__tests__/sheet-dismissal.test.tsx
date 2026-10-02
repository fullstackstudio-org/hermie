/**
 * The three ways out of a sheet, and the one thing none of them is.
 *
 * A sheet closes on a backdrop tap, on Escape from a hardware keyboard, and on
 * a drag down past a third of its own height (or a flick faster than 500 pt/s).
 * What that means for a sheet carrying an agent's question is the point of this
 * file: **dismissing is not answering.** The question stays open on the gateway,
 * stays in the transcript, and comes back from its own `Answer` button — which
 * is why the sheet is allowed to be dragged away at all.
 *
 * The drag itself cannot be performed here. `PanResponder` builds its gesture
 * state from a stream of native touches, and synthesising one would be
 * asserting against a fabrication rather than against the gesture. So the drag
 * is exercised at the seam the component actually uses — `sheetDragConfig`,
 * whose four callbacks are precisely what `PanResponder` calls — with the
 * numbers the brief names: 60 % of the height closes, 10 % springs back.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { Animated } from 'react-native'

import { approvalItem } from '../src/chat-ui/fixtures'
import { beginsSheetDrag, sheetDragConfig, sheetDragProgress } from '../src/ui/BottomSheet'
import { ApprovalSheet, ChatOptionsSheet } from '../src/ui/sheets'
import { renderScreen } from './support/render'

const OPTIONS = {
  botName: 'Researcher',
  fast: false,
  model: 'example-model',
  modelOptions: [],
  onChangeFast: jest.fn(),
  onChangeModel: jest.fn(),
  onChangeReasoningEffort: jest.fn(),
  onChangeShowBotToBot: jest.fn(),
  onChangeShowThinking: jest.fn(),
  onChangeVerbosity: jest.fn(),
  onChangeYolo: jest.fn(),
  reasoningEffort: 'medium',
  reasoningOptions: [],
  showBotToBot: true,
  showThinking: true,
  verbosity: 'normal' as const,
  yolo: false
}

/** The height a 874pt window gives a sheet: `sheetBox` caps it at 86 %. */
const HEIGHT = 600

/** What `PanResponder` hands a callback, minus everything these four ignore. */
const gesture = (dy: number, vy = 0) =>
  ({ dx: 0, dy, vy }) as unknown as Parameters<NonNullable<ReturnType<typeof sheetDragConfig>['onPanResponderMove']>>[1]

const EVENT = {} as Parameters<NonNullable<ReturnType<typeof sheetDragConfig>['onPanResponderMove']>>[0]

function valueOf(animated: Animated.Value): number {
  let read = 0

  const id = animated.addListener(({ value }) => {
    read = value
  })

  // `addListener` does not fire on its own; a set with the current value does.
  animated.setValue((animated as unknown as { _value: number })._value)
  animated.removeListener(id)

  return read
}

describe('a backdrop tap', () => {
  it('closes the chat options sheet', () => {
    const onClose = jest.fn()

    renderScreen(<ChatOptionsSheet {...OPTIONS} onClose={onClose} visible />)

    fireEvent.press(screen.getByTestId('chat-options-sheet-backdrop'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes an approval sheet without answering it', () => {
    // The one that used to be impossible. `onClose` is the chat's "put it
    // aside" — the question stays open, and the transcript keeps the row with
    // the `Answer` button on it.
    const onClose = jest.fn()
    const onRespond = jest.fn()

    renderScreen(
      <ApprovalSheet
        botHandle="researcher"
        item={approvalItem}
        onClose={onClose}
        onRespond={onRespond}
        tapGuardMs={0}
        visible
      />
    )

    fireEvent.press(screen.getByTestId('approval-sheet-backdrop'))

    expect(onClose).toHaveBeenCalledTimes(1)
    // Nothing went to the gateway: a dismissal is not a choice.
    expect(onRespond).not.toHaveBeenCalled()
  })
})

describe('the drag', () => {
  const drag = (overrides: Partial<{ atTop: boolean }> = {}) => {
    const progress = new Animated.Value(1)
    const onRequestClose = jest.fn()
    const config = sheetDragConfig({
      atTop: () => overrides.atTop ?? true,
      height: () => HEIGHT,
      onRequestClose,
      progress
    })

    return { config, onRequestClose, progress }
  }

  it('follows the finger one to one', () => {
    const { config, progress } = drag()

    config.onPanResponderMove(EVENT, gesture(HEIGHT * 0.25))

    // A quarter of the way down is a quarter off the slide-in's own value —
    // which is the same value the opening animation drives, so the two are one
    // motion rather than two that agree.
    expect(valueOf(progress)).toBeCloseTo(0.75, 5)
  })

  it('goes no higher than its own place, however far up the finger goes', () => {
    // Not a rubber band. The card is square against the window's bottom edge, so
    // lifting it by any amount opens a strip of window under it — the defect the
    // previous round removed.
    expect(sheetDragProgress(-4, HEIGHT)).toBe(1)
    expect(sheetDragProgress(-400, HEIGHT)).toBe(1)

    // …and no lower than gone.
    expect(sheetDragProgress(HEIGHT * 2, HEIGHT)).toBe(0)
  })

  it('closes on a drag of 60 % of the height', () => {
    const { config, onRequestClose, progress } = drag()

    config.onPanResponderMove(EVENT, gesture(HEIGHT * 0.6))
    config.onPanResponderRelease(EVENT, gesture(HEIGHT * 0.6))

    expect(onRequestClose).toHaveBeenCalledTimes(1)
    // And it is NOT animated back up first: the value the finger left behind is
    // where the slide-out starts.
    expect(valueOf(progress)).toBeCloseTo(0.4, 5)
  })

  it('springs back from a drag of 10 %', () => {
    jest.useFakeTimers()

    try {
      const { config, onRequestClose, progress } = drag()

      config.onPanResponderMove(EVENT, gesture(HEIGHT * 0.1))
      expect(valueOf(progress)).toBeCloseTo(0.9, 5)

      config.onPanResponderRelease(EVENT, gesture(HEIGHT * 0.1))
      expect(onRequestClose).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(1000)
      })

      expect(valueOf(progress)).toBeCloseTo(1, 2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('closes on a flick, however short it was', () => {
    const { config, onRequestClose } = drag()

    // 500 pt/s is the threshold, and `PanResponder` reports points per
    // millisecond: a tenth of the height thrown downward still means "go".
    config.onPanResponderRelease(EVENT, gesture(HEIGHT * 0.1, 0.9))

    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('takes the gesture from the scroll view only at the top', () => {
    // Content that can still scroll scrolls. This is the capture question, and
    // it is the whole of "scrollable content only drag-dismisses when scrolled
    // to top".
    const atTop = drag({ atTop: true })
    const scrolled = drag({ atTop: false })

    expect(atTop.config.onMoveShouldSetPanResponderCapture(EVENT, gesture(40))).toBe(true)
    expect(scrolled.config.onMoveShouldSetPanResponderCapture(EVENT, gesture(40))).toBe(false)

    // The grip bar sits outside the scroll view, so its drags arrive on the
    // bubble phase and are taken wherever the content happens to be.
    expect(scrolled.config.onMoveShouldSetPanResponder(EVENT, gesture(40))).toBe(true)
  })

  it('ignores a tap, a settling finger and a sideways swipe', () => {
    expect(beginsSheetDrag({ dx: 0, dy: 0 })).toBe(false)
    expect(beginsSheetDrag({ dx: 0, dy: 4 })).toBe(false)
    expect(beginsSheetDrag({ dx: 80, dy: 20 })).toBe(false)
    expect(beginsSheetDrag({ dx: 0, dy: -60 })).toBe(false)
    expect(beginsSheetDrag({ dx: 4, dy: 20 })).toBe(true)
  })
})
