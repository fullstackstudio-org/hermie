/**
 * HERM-83, Task 3: the wiring between a row's `author`, the group-chat gate,
 * and what `UserBubble` is actually told to draw.
 *
 * `UserBubble`'s own contract (`own`/`sender`) has its own suite
 * (`user-bubble-attribution.test.tsx`); this one is about `TranscriptList`
 * deciding that contract correctly from `context.groupChat`, `context.ownAuthorId`
 * and each row's `author` — which is also where the D3 defect this card fixes
 * lived: a colleague's message painted as the reader's own.
 */
import { screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import type { MessageAuthor, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const ME = 'authentik:me'
const WRITER: MessageAuthor = { id: 'authentik:writer', name: 'Robin' }
const RESEARCHER: MessageAuthor = { id: 'authentik:researcher', name: 'Sam' }

// `Avatar` is deliberately hidden from accessibility (D7), and RNTL's queries
// skip anything hidden that way unless told not to.
const HIDDEN = { includeHiddenElements: true } as const

let seq = 0

function user(id: string, extra: Partial<TranscriptItem> = {}): VisibleItem {
  seq += 1

  return {
    item: {
      id,
      kind: 'user',
      origin: 'history',
      seq,
      text: `message ${id}`,
      ts: 1_767_000_000 + seq,
      version: 1,
      ...extra
    } as TranscriptItem,
    presentation: 'full'
  }
}

function renderList(items: VisibleItem[], props: Record<string, unknown> = {}) {
  return renderScreen(<TranscriptList items={items} {...props} />)
}

describe('TranscriptList, sender attribution (HERM-83)', () => {
  beforeEach(() => {
    seq = 0
  })

  it('names two alternating senders and draws two separate runs', () => {
    renderList([user('a', { author: WRITER }), user('b', { author: RESEARCHER })], {
      groupChat: true,
      ownAuthorId: ME
    })

    expect(screen.getByTestId('user-sender-name-a')).toHaveTextContent('Robin')
    expect(screen.getByTestId('user-sender-name-b')).toHaveTextContent('Sam')
    expect(screen.getByTestId('user-sender-avatar-a', HIDDEN)).toBeTruthy()
    expect(screen.getByTestId('user-sender-avatar-b', HIDDEN)).toBeTruthy()
  })

  it('names only the first of three consecutive messages from one sender', () => {
    renderList([user('a', { author: WRITER }), user('b', { author: WRITER }), user('c', { author: WRITER })], {
      groupChat: true,
      ownAuthorId: ME
    })

    expect(screen.getByTestId('user-sender-name-a')).toBeTruthy()
    expect(screen.queryByTestId('user-sender-name-b')).toBeNull()
    expect(screen.queryByTestId('user-sender-name-c')).toBeNull()
  })

  it('never names or avatars the reader’s own attributed message', () => {
    renderList([user('a', { author: { id: ME, name: 'Me' } })], { groupChat: true, ownAuthorId: ME })

    expect(screen.queryByTestId('user-sender-name-a')).toBeNull()
    expect(screen.queryByTestId('user-sender-avatar-a', HIDDEN)).toBeNull()
  })

  it('draws an unattributed row with the reader’s own silhouette and no name', () => {
    renderList([user('a')], { groupChat: true, ownAuthorId: ME })

    expect(screen.queryByTestId('user-sender-a')).toBeNull()
  })

  it('shows no names at all when this is not the group chat, even with authored rows', () => {
    renderList([user('a', { author: WRITER }), user('b', { author: RESEARCHER })], {
      groupChat: false,
      ownAuthorId: ME
    })

    expect(screen.queryByTestId('user-sender-name-a')).toBeNull()
    expect(screen.queryByTestId('user-sender-name-b')).toBeNull()
  })

  it('shows no names before the reader’s own identity is known, even in the group chat', () => {
    renderList([user('a', { author: WRITER })], { groupChat: true })

    expect(screen.queryByTestId('user-sender-name-a')).toBeNull()
  })

  it('gives the same identity the same ink and the same avatar tint across a remount', () => {
    const items = [user('a', { author: WRITER })]
    const view = renderList(items, { groupChat: true, ownAuthorId: ME })
    const inkBefore = screen.getByTestId('user-sender-name-a').props.style
    const tintBefore = screen.getByTestId('user-sender-avatar-a', HIDDEN).props.style

    view.unmount()
    renderList(items, { groupChat: true, ownAuthorId: ME })
    const inkAfter = screen.getByTestId('user-sender-name-a').props.style
    const tintAfter = screen.getByTestId('user-sender-avatar-a', HIDDEN).props.style

    expect(inkAfter).toEqual(inkBefore)
    expect(tintAfter).toEqual(tintBefore)
  })

  it('keeps a sender’s colour when their stamped name changes', () => {
    const first = renderList([user('a', { author: WRITER })], { groupChat: true, ownAuthorId: ME })
    const before = screen.getByTestId('user-sender-name-a').props.style

    first.unmount()
    renderList([user('a', { author: { id: WRITER.id, name: 'A Whole New Name' } })], {
      groupChat: true,
      ownAuthorId: ME
    })
    const after = screen.getByTestId('user-sender-name-a').props.style

    expect(after).toEqual(before)
    expect(screen.getByTestId('user-sender-name-a')).toHaveTextContent('A Whole New Name')
  })
})

/**
 * HERM-120: `resolveSenderPictureUri` is asked for exactly the rows `RowView`
 * has already proven are somebody else's, and never for the reader's own or
 * an unattributed one — the same gate `resolveSenderName` answers to, and the
 * same reason a colleague's picture must never be requested for a row that
 * turns out to be the reader's own.
 */
describe('TranscriptList, resolveSenderPictureUri (HERM-120)', () => {
  beforeEach(() => {
    seq = 0
  })

  it('is asked for a colleague’s row, by their author id, and draws what it returns', () => {
    const resolveSenderPictureUri = jest.fn((author: MessageAuthor) =>
      author.id === WRITER.id ? 'data:image/png;base64,AAAA' : undefined
    )

    renderList([user('a', { author: WRITER })], { groupChat: true, ownAuthorId: ME, resolveSenderPictureUri })

    expect(resolveSenderPictureUri).toHaveBeenCalledWith(WRITER)
    expect(screen.getByTestId('user-sender-avatar-a', HIDDEN).props.source).toMatchObject({
      uri: 'data:image/png;base64,AAAA'
    })
  })

  it('is never asked for the reader’s own attributed message', () => {
    const resolveSenderPictureUri = jest.fn(() => 'data:image/png;base64,AAAA')

    renderList([user('a', { author: { id: ME, name: 'Me' } })], {
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderPictureUri
    })

    expect(resolveSenderPictureUri).not.toHaveBeenCalled()
  })

  it('is never asked for an unattributed row', () => {
    const resolveSenderPictureUri = jest.fn(() => 'data:image/png;base64,AAAA')

    renderList([user('a')], { groupChat: true, ownAuthorId: ME, resolveSenderPictureUri })

    expect(resolveSenderPictureUri).not.toHaveBeenCalled()
  })

  it('draws the tinted initial, not a broken image, when it answers undefined', () => {
    const resolveSenderPictureUri = jest.fn(() => undefined)

    renderList([user('a', { author: WRITER })], { groupChat: true, ownAuthorId: ME, resolveSenderPictureUri })

    const avatar = screen.getByTestId('user-sender-avatar-a', HIDDEN)

    expect(avatar.props.source).toBeUndefined()
  })
})
