/**
 * The row memo, which is the only reason a long transcript stays usable while
 * a reply streams.
 *
 * `TranscriptRow` compares the shared `context` object by identity, and the
 * chat screen used to build that object out of inline arrows — so every delta
 * handed every settled row a new context and re-rendered the whole list. The
 * assertion is about RENDER COUNTS rather than about output: the screen looked
 * identical either way, which is exactly why it went unnoticed.
 *
 * It is in its own file because it mocks `AssistantBubble` to count itself, and
 * that mock must not leak into the tests that render the real one.
 */
import { screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import { AssistantBubble } from '../../src/chat-ui/AssistantBubble'
import { assistantItem, subagentMap } from '../../src/chat-ui/fixtures'
import type { VisibleItem } from '../../src/chat-ui/types'
import { renderScreen, withProviders } from '../support/render'

jest.mock('../../src/chat-ui/AssistantBubble', () => {
  const actual = jest.requireActual('../../src/chat-ui/AssistantBubble')

  return { AssistantBubble: jest.fn(actual.AssistantBubble) }
})

const bubble = jest.mocked(AssistantBubble)

/** A finished reply, three rows up, that must not move for the rest of the turn. */
const settled: VisibleItem = { item: { ...assistantItem, id: 'a-done', streaming: false }, presentation: 'full' }

const streaming = (text: string, version: number): VisibleItem => ({
  item: { ...assistantItem, id: 'a-live', streaming: true, text, version },
  presentation: 'full'
})

/** Stable handlers, the way `ChatScreen` now passes them. */
const HANDLERS = { onOpenBot: jest.fn(), onOpenRequest: jest.fn(), onOpenTranscript: jest.fn() }

const list = (items: VisibleItem[], handlers: Record<string, unknown>) => (
  <TranscriptList items={items} subagents={subagentMap} {...handlers} />
)

beforeEach(() => bubble.mockClear())

describe('re-rendering while a reply streams', () => {
  it('leaves settled rows alone when only the streaming row changes', () => {
    const view = renderScreen(list([settled, streaming('He', 1)], HANDLERS))

    const settledRenders = () => bubble.mock.calls.filter(([props]) => props.item.id === 'a-done').length
    const before = settledRenders()

    expect(before).toBeGreaterThan(0)

    for (const [index, text] of ['Hell', 'Hello', 'Hello t', 'Hello there'].entries()) {
      view.rerender(withProviders(list([settled, streaming(text, index + 2)], HANDLERS)))
    }

    expect(settledRenders()).toBe(before)
    expect(screen.getByText('Hello there')).toBeTruthy()
  })

  it('does rebuild them when a handler changes identity', () => {
    const view = renderScreen(list([settled], HANDLERS))

    const settledRenders = () => bubble.mock.calls.filter(([props]) => props.item.id === 'a-done').length
    const before = settledRenders()

    // A fresh arrow is exactly what the chat screen used to hand it on every
    // delta, and this is the cost of doing that.
    view.rerender(withProviders(list([settled], { ...HANDLERS, onOpenRequest: jest.fn() })))

    expect(settledRenders()).toBeGreaterThan(before)
  })
})
