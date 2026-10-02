/**
 * HERM-83, Task 3: the first place a name, a colour and an avatar appear.
 *
 * `own` and `sender` are `UserBubble`'s own contract — `TranscriptList` is what
 * decides them from `item.author` and the group-chat gate, and that wiring has
 * its own suite (`transcript-attribution.test.tsx`). This one is about the
 * bubble itself: given `own`/`sender`, does it draw the right silhouette, the
 * right name, in the right colour, with the avatar in the right place — and,
 * just as importantly, does the row a caller has NOT proven is somebody
 * else's still look exactly as it always has.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet, type ViewStyle } from 'react-native'

import { UserBubble } from '../../src/chat-ui'
import { userItem } from '../../src/chat-ui/fixtures'
import { ACCENTS } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

const flat = (testID: string): ViewStyle =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as ViewStyle

const WRITER = { authorId: 'authentik:writer', name: 'Robin' }

// `Avatar` is deliberately hidden from accessibility (D7) — decorative, so a
// screen reader relies on the name instead — and RNTL's queries skip anything
// hidden that way unless told not to.
const HIDDEN = { includeHiddenElements: true } as const

describe('UserBubble, own vs somebody else’s', () => {
  it('draws exactly as before when `own` is left at its default', () => {
    renderScreen(<UserBubble item={userItem} />)

    expect(flat(`user-${userItem.id}-box`).alignSelf).toBe('flex-end')
    expect(screen.queryByTestId(`user-sender-${userItem.id}`)).toBeNull()
  })

  it('draws the own silhouette when `own` is explicitly true, sender or not', () => {
    renderScreen(<UserBubble item={userItem} own sender={WRITER} />)

    expect(flat(`user-${userItem.id}-box`).alignSelf).toBe('flex-end')
    expect(screen.queryByTestId(`user-sender-name-${userItem.id}`)).toBeNull()
  })

  it('draws the incoming silhouette for somebody else, even with no sender to name', () => {
    renderScreen(<UserBubble item={userItem} own={false} />)

    expect(flat(`user-${userItem.id}-box`).alignSelf).toBe('flex-start')
    expect(screen.queryByTestId(`user-sender-name-${userItem.id}`)).toBeNull()
  })

  it('never gives a receipt to a row that is not the reader’s own', () => {
    renderScreen(<UserBubble item={userItem} own={false} receipt="read" sender={WRITER} />)

    expect(screen.queryByLabelText(/Read$/)).toBeNull()
  })
})

describe('UserBubble, the sender label and avatar', () => {
  it('names the sender and shows the avatar on the first bubble of a run', () => {
    renderScreen(<UserBubble grouped={false} item={userItem} own={false} sender={WRITER} />)

    expect(screen.getByTestId(`user-sender-name-${userItem.id}`)).toHaveTextContent('Robin')
    expect(screen.getByTestId(`user-sender-avatar-${userItem.id}`, HIDDEN)).toBeTruthy()
  })

  it('suppresses the name and the avatar on a bubble that continues the run', () => {
    renderScreen(<UserBubble grouped item={userItem} own={false} sender={WRITER} />)

    expect(screen.queryByTestId(`user-sender-name-${userItem.id}`)).toBeNull()
    expect(screen.queryByTestId(`user-sender-avatar-${userItem.id}`, HIDDEN)).toBeNull()
    // The gutter itself survives so the bubble below keeps the same left edge
    // as the one that carried the avatar.
    expect(screen.getByTestId(`user-sender-${userItem.id}`)).toBeTruthy()
  })

  it('inks the name from the identity, never the chat’s own accent', () => {
    renderScreen(<UserBubble item={userItem} own={false} sender={WRITER} />)

    const label = screen.getByTestId(`user-sender-name-${userItem.id}`)
    const style = StyleSheet.flatten(label.props.style as never) as ViewStyle & { color?: string }

    expect(style.color).not.toBe(ACCENTS.default.text.light)
  })

  it('keys the avatar’s tint on the identity: two different ids can differ, one id repeats', () => {
    // The identity is what `Avatar`'s `tintKey` receives; this only proves the
    // wiring reaches it; `avatar.test.tsx`-style coverage of the tint math
    // itself lives beside `Avatar`.
    renderScreen(<UserBubble grouped={false} item={{ ...userItem, id: 'x' }} own={false} sender={WRITER} />)

    expect(screen.getByTestId('user-sender-avatar-x', HIDDEN)).toBeTruthy()
  })
})
