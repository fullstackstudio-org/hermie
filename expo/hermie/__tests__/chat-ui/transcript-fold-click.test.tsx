/**
 * The seam a Mac click travels through to reach `Show more`, as far as this
 * renderer can model it.
 *
 * The owner's report was a mouse click on `Show more` that sometimes did
 * nothing at all, on the Mac build. `TranscriptRowFrameView` wraps every
 * transcript row — including the bubble's own `Fold` — in `ContextMenuHost`,
 * which on that build is a native `UIContextMenuInteraction` spanning the
 * WHOLE row (`docs/platform-notes.md`, "Normal Mac behaviour, end to end").
 * That interaction has to evaluate an indirect-pointer click the same way it
 * evaluates a press-and-hold, and it and the fold's own `Pressable` were
 * racing the same touch — nothing in JavaScript decided which one won, which
 * is why it was "sometimes". The fix is `passThroughButtons`: the row's host
 * now tells the interaction a location over a `.button`-trait view is not its
 * concern at all, so there is no race to lose. See
 * `HermieContextMenuView.isOverPassedThroughButton` for the native half; none
 * of that UIKit arbitration can run in this renderer, which lays nothing out
 * and fires no real touches. What IS provable here:
 *
 *  - the row's host is actually TOLD to pass buttons through, which is the
 *    one thing a native rebuild could silently regress by dropping the prop;
 *  - nothing else in the JAVASCRIPT tree between the host and the toggle
 *    swallows the press, by actually pressing it through every layer the
 *    real row nests it in — `ContextMenuHost` renders bare in every test
 *    environment, which is also the shape a build with `passThroughButtons`
 *    on takes for a click that lands on a button: nothing stands between it
 *    and the child.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem } from '../../src/chat-ui/fixtures'
import { renderScreen } from '../support/render'

const received: { testID?: string; passThroughButtons?: boolean }[] = []

jest.mock('../../src/platform/context-menu', () => {
  const React = require('react')
  const { View } = require('react-native')

  return {
    HAS_NATIVE_CONTEXT_MENU: false,
    ContextMenuHost: ({
      children,
      passThroughButtons,
      testID
    }: {
      children: React.ReactNode
      passThroughButtons?: boolean
      testID?: string
    }) => {
      received.push({ passThroughButtons, testID })

      return React.createElement(View, { testID }, children)
    }
  }
})

beforeEach(() => {
  received.length = 0
})

function renderLongReply() {
  return renderScreen(
    <TranscriptList items={[{ item: { ...assistantItem, text: 'x'.repeat(4000) }, presentation: 'full' }]} />
  )
}

describe('a transcript row’s host', () => {
  it('is told to pass a nested button through', () => {
    renderLongReply()

    const row = received.find(props => props.testID === `transcript-menu-${assistantItem.id}`)

    expect(row?.passThroughButtons).toBe(true)
  })
})

describe('a click on `Show more`, through the row it actually nests in', () => {
  it('still reaches the fold’s own toggle', () => {
    renderLongReply()

    // The test renderer lays nothing out, so `Fold` never sees its body
    // overflow on its own — firing `layout` by hand is the documented way
    // `fold.test.tsx` reaches the same branch.
    act(() => {
      fireEvent(screen.getByTestId(`assistant-fold-${assistantItem.id}-body`), 'layout', {
        nativeEvent: { layout: { height: 4000 } }
      })
    })

    const toggle = screen.getByTestId(`assistant-fold-${assistantItem.id}-toggle`)

    expect(toggle.props.accessibilityState?.expanded).toBe(false)

    fireEvent.press(toggle)

    expect(screen.getByTestId(`assistant-fold-${assistantItem.id}-toggle`).props.accessibilityState.expanded).toBe(true)
  })
})
