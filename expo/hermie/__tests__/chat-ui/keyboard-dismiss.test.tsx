/**
 * Scrolling up in a chat puts the keyboard away.
 *
 * `keyboardDismissMode="interactive"` is set on iOS and did not behave on the
 * owner's iPhone. The reason is the list's own shape: `inverted` is a
 * `scaleY: -1` on the scroll view, and UIKit's interactive dismissal reads the
 * pan in that flipped space — so it looks for a drag away from the keyboard
 * where the reader is making one towards it. The other two suspects were checked
 * and cleared: there is exactly one `KeyboardAvoidingView` over the chat screen
 * (the composer's own is off by default for that reason), and
 * `keyboardShouldPersistTaps` governs taps, not drags.
 *
 * So the list does it itself, on the sign an inverted list actually has: offset 0
 * is the newest message, and "scroll up to read" GROWS the offset.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { Keyboard } from 'react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import { dismissesKeyboard } from '../../src/chat-ui/TranscriptList'
import type { VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const visible = (items: { id: string }[]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'collapsed' }) as VisibleItem)

function scrollTo(y: number): void {
  fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { height: 2000, width: 402 },
      layoutMeasurement: { height: 800, width: 402 }
    }
  })
}

describe('dismissesKeyboard', () => {
  it('says nothing while no drag is running', () => {
    expect(dismissesKeyboard(undefined, 400)).toBe(false)
  })

  it('takes a drag towards the history — the direction an inverted list grows in', () => {
    expect(dismissesKeyboard(0, 80)).toBe(true)
  })

  it('leaves a drag towards the newest message alone', () => {
    // Pulling the chat back down to the latest reply is not a request to type
    // less; it is a request to read what just arrived.
    expect(dismissesKeyboard(200, 40)).toBe(false)
  })

  it('ignores a settling finger and a rubber-band bounce', () => {
    expect(dismissesKeyboard(200, 210)).toBe(false)
  })
})

describe('the transcript with the keyboard up', () => {
  it('dismisses it once the drag up the history is unmistakable, and only once', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

      fireEvent(screen.getByTestId('transcript-list-scroll'), 'scrollBeginDrag')
      scrollTo(10)
      expect(dismiss).not.toHaveBeenCalled()

      scrollTo(120)
      expect(dismiss).toHaveBeenCalledTimes(1)

      // Still the same drag: one native call is the whole of the effect.
      scrollTo(300)
      expect(dismiss).toHaveBeenCalledTimes(1)
    } finally {
      dismiss.mockRestore()
    }
  })

  it('leaves it up when the reader never dragged, which is a programmatic scroll', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

      scrollTo(600)

      expect(dismiss).not.toHaveBeenCalled()
    } finally {
      dismiss.mockRestore()
    }
  })

  it('still dismisses on the momentum a flick leaves behind', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

      // A short flick: the finger lifts before the threshold, and the list
      // coasts past it. That momentum is the same gesture.
      fireEvent(screen.getByTestId('transcript-list-scroll'), 'scrollBeginDrag')
      scrollTo(10)
      fireEvent(screen.getByTestId('transcript-list-scroll'), 'scrollEndDrag', {
        nativeEvent: { contentOffset: { x: 0, y: 10 }, velocity: { x: 0, y: 2 } }
      })
      scrollTo(400)

      expect(dismiss).toHaveBeenCalledTimes(1)
    } finally {
      dismiss.mockRestore()
    }
  })
})
