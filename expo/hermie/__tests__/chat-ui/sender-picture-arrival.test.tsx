/**
 * HERM-120: a colleague's picture appears the moment it arrives, not after the
 * next message.
 *
 * The picture is fetched by `author.id` and cached per gateway. Two things
 * stopped it showing: the fetch was started DURING a row's render (a store
 * update from inside somebody else's render), and nothing told the row when the
 * picture landed — the resolver's identity never changed and `sameRow` compares
 * the transcript context by identity, so a memoised row kept its initial until
 * the next turn rebuilt the list. A row now subscribes to its own picture and
 * asks for it from an effect.
 */
import { act, renderHook, screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import type { MessageAuthor, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'
import { usePeoplePicturesStore } from '../../src/features/people/people-pictures'
import { useSenderPictureResolver } from '../../src/features/people/use-sender-picture-resolver'
import { deferred, renderScreen } from '../support/render'

const ME = 'authentik:me'
const WRITER: MessageAuthor = { id: 'authentik:writer', name: 'Robin' }
const HIDDEN = { includeHiddenElements: true } as const
const PICTURE = 'data:image/png;base64,AAAA'

const mockFetch = jest.fn()
// ONE object, as the real provider hands out one `http` per connection: a fresh
// object per render would rebuild every callback and hide the bug under test.
const mockGateway = { gatewayId: 'gateway-one', http: { fetchAuthenticatedPicture: mockFetch } }

jest.mock('../../src/gateway', () => ({
  useGateway: () => mockGateway
}))

function item(id: string, author?: MessageAuthor): VisibleItem {
  return {
    item: {
      id,
      kind: 'user',
      origin: 'history',
      seq: 1,
      text: `message ${id}`,
      ts: 1_790_000_000,
      version: 1,
      ...(author ? { author } : {})
    } as TranscriptItem,
    presentation: 'full'
  }
}

/** What `ChatScreen` does: one hook at the top, its result handed to the list. */
function Host({ items }: { items: VisibleItem[] }) {
  const pictures = useSenderPictureResolver()

  return <TranscriptList groupChat items={items} ownAuthorId={ME} {...pictures} />
}

describe('a colleague’s picture, arriving', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    usePeoplePicturesStore.getState().reset()
  })

  it('shows on the row it belongs to as soon as the fetch lands, with no new message', async () => {
    const answer = deferred<{ kind: 'ready'; dataUri: string }>()

    mockFetch.mockReturnValue(answer.promise)

    const items = [item('a', WRITER)]

    renderScreen(<Host items={items} />)

    expect(screen.getByTestId('user-sender-avatar-a', HIDDEN).props.source).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      answer.resolve({ kind: 'ready', dataUri: PICTURE })
      await answer.promise
    })

    expect(screen.getByTestId('user-sender-avatar-a', HIDDEN).props.source).toEqual({ uri: PICTURE })
  })

  it('reads a picture without starting anything, so a row can read it during render', () => {
    mockFetch.mockReturnValue(new Promise(() => undefined))

    const { result } = renderHook(() => useSenderPictureResolver())

    // Reading is what a row does while it renders: it must not touch the store
    // or the network. Asking is what it does from an effect.
    expect(result.current.resolveSenderPictureUri(WRITER)).toBeUndefined()
    expect(usePeoplePicturesStore.getState().byKey).toEqual({})
    expect(mockFetch).not.toHaveBeenCalled()

    act(() => result.current.requestSenderPicture(WRITER))

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('asks once per colleague, however many of their rows are on screen', () => {
    mockFetch.mockReturnValue(new Promise(() => undefined))

    renderScreen(
      <Host items={[item('a', WRITER), item('b', { id: 'authentik:sam', name: 'Sam' }), item('c', WRITER)]} />
    )

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('never asks for the reader’s own picture, nor for an unattributed row', () => {
    mockFetch.mockReturnValue(new Promise(() => undefined))

    renderScreen(<Host items={[item('a', { id: ME, name: 'Alex' }), item('b')]} />)

    expect(mockFetch).not.toHaveBeenCalled()
  })
})
