/**
 * HERM-83, Task 5, D7: a screen reader still hears whose bubble this is when
 * a run suppresses the VISIBLE name.
 *
 * The first bubble of a run has its own suite
 * (`user-bubble-attribution.test.tsx`, Task 3) and needs nothing extra —
 * `SenderLabel` is real text ahead of the bubble, so a screen reader already
 * says the name and then the message with nothing wired up. This file is
 * about the bubble that continues a run, where that visible text is gone on
 * purpose and D7 still requires one announcement of the sender, once, without
 * putting the visible name back.
 */
import { screen } from '@testing-library/react-native'

import { UserBubble } from '../../src/chat-ui'
import { userItem } from '../../src/chat-ui/fixtures'
import { renderScreen } from '../support/render'

const WRITER = { authorId: 'authentik:writer', name: 'Robin' }

describe('UserBubble, the sender name for a screen reader on a mid-run bubble', () => {
  it('puts the sender’s name in the accessibility label, once, on a bubble that continues the run', () => {
    renderScreen(<UserBubble grouped item={userItem} own={false} sender={WRITER} />)

    const marker = screen.getByTestId(`user-sender-name-a11y-${userItem.id}`)

    expect(marker.props.accessibilityLabel).toBe('Robin')
    // A real, non-zero footprint — not `height/width: 0`, which VoiceOver and
    // some browser screen readers drop rather than announce. See
    // `docs/platform-notes.md`, "A message bubble is many accessible
    // elements, not one".
    const style = Array.isArray(marker.props.style) ? Object.assign({}, ...marker.props.style) : marker.props.style

    expect(style.height).toBeGreaterThan(0)
    expect(style.width).toBeGreaterThan(0)
    expect(style.opacity).not.toBe(0)
    // The VISIBLE label is still suppressed — this is an additional
    // announcement, not the visible one turned back on.
    expect(screen.queryByTestId(`user-sender-name-${userItem.id}`)).toBeNull()
  })

  it('draws its text in no ink, so not even a speck of a glyph shows, and stays exposed to a screen reader', () => {
    renderScreen(<UserBubble grouped item={userItem} own={false} sender={WRITER} />)

    const marker = screen.getByTestId(`user-sender-name-a11y-${userItem.id}`)
    const style = Array.isArray(marker.props.style) ? Object.assign({}, ...marker.props.style) : marker.props.style

    expect(style.color).toBe('transparent')
    // Transparent INK, not a transparent element: no `opacity: 0`, no zero
    // frame, and the label is still spelled out explicitly.
    expect(style.opacity).not.toBe(0)
    expect(style.height).toBeGreaterThan(0)
    expect(style.width).toBeGreaterThan(0)
    expect(marker.props.accessibilityLabel).toBe('Robin')
    expect(marker.props.accessibilityElementsHidden).not.toBe(true)
    expect(marker.props.importantForAccessibility).not.toBe('no-hide-descendants')
  })

  it('draws no second, hidden name on the first bubble of a run — the visible label already carries it', () => {
    renderScreen(<UserBubble grouped={false} item={userItem} own={false} sender={WRITER} />)

    expect(screen.getByTestId(`user-sender-name-${userItem.id}`)).toHaveTextContent('Robin')
    expect(screen.queryByTestId(`user-sender-name-a11y-${userItem.id}`)).toBeNull()
  })

  it('draws no sender name at all, visible or not, for the reader’s own bubble', () => {
    renderScreen(<UserBubble grouped item={userItem} own sender={WRITER} />)

    expect(screen.queryByTestId(`user-sender-name-a11y-${userItem.id}`)).toBeNull()
    expect(screen.queryByTestId(`user-sender-name-${userItem.id}`)).toBeNull()
  })

  it('adds the announcement beside the bubble’s own accessible elements rather than replacing them', () => {
    // The whole bubble is deliberately NOT folded into one accessible unit —
    // see `docs/platform-notes.md` — so a link inside a mid-run message stays
    // its own, separately reachable and activatable element even though the
    // sender is also announced.
    renderScreen(
      <UserBubble
        grouped
        item={{ ...userItem, text: 'Also pushed the fix, see the [PR](https://example.test/pr/42) for details.' }}
        own={false}
        sender={WRITER}
      />
    )

    expect(screen.getByTestId(`user-sender-name-a11y-${userItem.id}`).props.accessibilityLabel).toBe('Robin')
    expect(screen.getByRole('link', { name: 'PR' })).toBeTruthy()
  })
})
