/**
 * A thought is an aside about the reply, not a second message.
 *
 * The owner reported it twice over in one sentence: "each thought appears twice
 * and the thought renders as a chat bubble". The first half is the reducer's
 * (`packages/transcript` keeps one thought per turn now); the second half is
 * this component's, and it is what this file pins down.
 *
 * `ReasoningDisclosure` used to be a `LedgerRow` — a glyph in a tinted well, and
 * the expanded text on a `GlassSurface` card the width of a bubble, sitting
 * exactly where a bubble sits. That silhouette is right for a machine EVENT (a
 * tool call, a cron delivery) and wrong for a thought, which is commentary on
 * the bubble under it. So what is asserted here is the absence of the card and
 * the presence of the alignment, because "it looks like a bubble" is otherwise
 * only catchable by a person looking at a window.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native'

import { AssistantBubble, bubblePaddingX, ExpandedProvider, ReasoningDisclosure, TAIL_REACH } from '../../src/chat-ui'
import { assistantItem } from '../../src/chat-ui/fixtures'
import { space, type as typeScale } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

beforeEach(() => {
  mockDimensions.mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 1 })
})

const flat = (testID: string): ViewStyle & TextStyle =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as ViewStyle & TextStyle

/** The item as it arrives: a short reply, so the bubble takes the normal padding. */
const thinking = { ...assistantItem, text: 'Version 1.2.0 ships three fixes.' }

describe('a thought above a reply', () => {
  it('is one line, once — not a header and a block that both repeat', () => {
    renderScreen(<AssistantBubble item={thinking} />)

    expect(screen.getAllByText(/^Thought for \d+s$/)).toHaveLength(1)
  })

  it('says nothing but the header until it is asked', () => {
    // The disclosure set lives above the list, so the toggle only does anything
    // inside the provider that owns it — see `expanded.tsx`.
    renderScreen(
      <ExpandedProvider>
        <AssistantBubble item={thinking} />
      </ExpandedProvider>
    )

    expect(screen.queryByTestId(`reasoning-${thinking.id}-body`)).toBeNull()

    fireEvent.press(screen.getByTestId(`reasoning-${thinking.id}-toggle`))

    expect(screen.getByTestId(`reasoning-${thinking.id}-body`)).toBeTruthy()
  })

  it('opens onto plain text and not onto a card', () => {
    // `-card` is the id the `LedgerRow` gave its `GlassSurface`. A thought that
    // grows one again is the bug this file exists for.
    renderScreen(
      <ExpandedProvider>
        <AssistantBubble item={thinking} />
      </ExpandedProvider>
    )
    fireEvent.press(screen.getByTestId(`reasoning-${thinking.id}-toggle`))

    expect(screen.queryByTestId(`reasoning-${thinking.id}-card`)).toBeNull()

    const body = flat(`reasoning-${thinking.id}-body`)

    expect(body.backgroundColor).toBeUndefined()
    expect(body.fontSize).toBe(typeScale.preview.fontSize)
  })

  it('starts where the bubble’s text starts, not at the row’s edge', () => {
    // The eyebrow's rule, for the same reason: a line at the row edge reads as a
    // stray note in the margin rather than as this reply's own aside.
    renderScreen(<AssistantBubble item={thinking} />)

    expect(flat(`reasoning-${thinking.id}`).marginLeft).toBe(TAIL_REACH + bubblePaddingX(space, false))
  })

  it('follows the wider reading padding when the reply takes it', () => {
    const long = { ...assistantItem, text: 'Word '.repeat(200) }

    renderScreen(<AssistantBubble item={long} />)

    expect(flat(`reasoning-${long.id}`).marginLeft).toBe(TAIL_REACH + bubblePaddingX(space, true))
  })

  it('offers nothing to open while the thought is still arriving', () => {
    renderScreen(<ReasoningDisclosure streaming testID="live" text="" />)

    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.queryByTestId('live-toggle')).toBeNull()
  })
})
