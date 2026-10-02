/**
 * The chat's chrome floats OVER the transcript; it is not a bar above it.
 *
 * The owner's reference is iPadOS 26 Messages: the sidebar/compose button and the
 * contact pill are separate rounded glass elements on the conversation, with the
 * messages scrolling underneath and blurring through them. The header used to be
 * one opaque glass surface spanning the column.
 *
 * Three things have to be true for that to work, and none of them is visible in a
 * screenshot of a test renderer, so each is asserted as the structure it is:
 *
 *  1. the header draws no background of its own and lets touches through the gaps
 *     between its elements, or the transcript under it is unreachable;
 *  2. the pill and the buttons are separate surfaces, not one box;
 *  3. the transcript pads its own content clear of whatever the chrome measured —
 *     on an INVERTED list that is `paddingBottom`, because the content container's
 *     top is at the screen's bottom.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet, type ViewStyle } from 'react-native'

import { ChatHeader } from '../../src/chat-ui'
import { renderScreen } from '../support/render'

const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as ViewStyle

describe('the chat header', () => {
  function render() {
    renderScreen(
      <ChatHeader name="researcher" onOpenOptions={jest.fn()} onToggleSidebar={jest.fn()} secondaryName="Researcher" />
    )
  }

  it('paints no background of its own, so the transcript shows between its parts', () => {
    render()

    expect(flat('chat-header').backgroundColor).toBeUndefined()
  })

  it('lets a drag through the gaps to the list underneath', () => {
    render()

    // `box-none` is the difference between "a transparent header" and "a
    // transparent header that swallows every touch it covers" — and the second
    // one is worse than an opaque bar, because nothing on screen explains it.
    expect(screen.getByTestId('chat-header').props.pointerEvents).toBe('box-none')
  })

  it('draws the pill and the buttons as separate floating surfaces', () => {
    render()

    expect(screen.getByTestId('chat-header-pill')).toBeTruthy()
    expect(screen.getByTestId('chat-header-sidebar')).toBeTruthy()
    expect(screen.getByTestId('chat-header-options')).toBeTruthy()
  })

  it('still says what the bot is doing, which is the one rule that outranks the look', () => {
    // "It must never say Connecting… while the chat is live." The pill carries the
    // presence line; moving the header out of the layout must not lose it.
    render()

    // The second line is the bot's OTHER name beside what it is doing. Two
    // texts, not one: the handle is outside the fade and outside the shrink,
    // so it neither flickers when the status changes nor loses its letters
    // when the status is long (`ChatHeader`'s second-line rule).
    expect(screen.getByTestId('chat-header-handle').props.children).toBe('Researcher')
    expect(screen.getByText(/^· /)).toBeTruthy()
  })
})
