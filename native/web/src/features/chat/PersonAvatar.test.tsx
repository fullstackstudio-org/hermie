/**
 * A person's picture beside their turn: the gateway's picture when it has one, the initial on their
 * own ground until it arrives and wherever it never does, and nothing a screen reader has to hear.
 */
import type { PictureFetchOutcome } from '@hermie/gateway-client'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createPeoplePictures, type PeoplePictures } from '../../core/people-pictures'
import { userItem } from '../../test-support/chat-fixtures'
import { LONG_AGO } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatSessionRuntime } from './chat-runtime'
import { ChatItem } from './items/ChatItem'
import { ItemContext } from './items/item-context'
import { PersonAvatar } from './PersonAvatar'

const PICTURE = 'data:image/png;base64,AAAA'
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

function cacheAnswering(outcome: PictureFetchOutcome): {
  pictures: PeoplePictures
  fetchPicture: ReturnType<typeof vi.fn>
} {
  const fetchPicture = vi.fn(async () => outcome)

  return { pictures: createPeoplePictures({ fetchPicture }), fetchPicture }
}

/** The runtime a chat screen would hand down, with only the cache in it. */
const runtimeWith = (pictures: PeoplePictures): ChatSessionRuntime =>
  ({ pictures, gatewayBaseUrl: 'http://gateway.test' }) as ChatSessionRuntime

describe('PersonAvatar', () => {
  it('draws the initial first and the picture once the gateway has served it', async () => {
    const { pictures, fetchPicture } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })
    const { container } = render(
      <ChatRuntimeContext.Provider value={runtimeWith(pictures)}>
        <PersonAvatar id="authentik:dana" name="Dana" />
      </ChatRuntimeContext.Provider>
    )

    expect(container.textContent).toBe('D')
    await settle()

    expect(fetchPicture).toHaveBeenCalledWith('/api/auth/picture?id=authentik%3Adana')
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PICTURE)
  })

  it('stays the initial where the gateway holds no picture, and asks once however often it is drawn', async () => {
    const { pictures, fetchPicture } = cacheAnswering({ kind: 'missing' })
    const view = (
      <ChatRuntimeContext.Provider value={runtimeWith(pictures)}>
        <PersonAvatar id="authentik:dana" name="Dana" />
        <PersonAvatar id="authentik:dana" name="Dana" />
      </ChatRuntimeContext.Provider>
    )
    const { container, rerender } = render(view)

    await settle()
    rerender(view)
    await settle()

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('DD')
    expect(fetchPicture).toHaveBeenCalledTimes(1)
  })

  it('falls back to the initial when the picture will not decode', async () => {
    const { pictures } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })
    const { container } = render(
      <ChatRuntimeContext.Provider value={runtimeWith(pictures)}>
        <PersonAvatar id="authentik:dana" name="Dana" />
      </ChatRuntimeContext.Provider>
    )

    await settle()
    fireEvent.error(container.querySelector('img') as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('D')
  })

  it('draws the initial and asks nothing on a page with no cache, or when told the gateway holds none', async () => {
    const { container } = render(<PersonAvatar id="authentik:dana" name="Dana" />)

    expect(container.textContent).toBe('D')

    const { pictures, fetchPicture } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })

    render(
      <ChatRuntimeContext.Provider value={runtimeWith(pictures)}>
        <PersonAvatar id="self-hosted:sam" name="Sam" skip />
      </ChatRuntimeContext.Provider>
    )
    await settle()

    expect(fetchPicture).not.toHaveBeenCalled()
  })

  it('uses the address the gateway gave for the reader’s own, and hides itself from assistive technology', async () => {
    const { pictures, fetchPicture } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })
    const { container } = render(
      <ChatRuntimeContext.Provider value={runtimeWith(pictures)}>
        <PersonAvatar id="self-hosted:sam" name="Sam" path="/api/auth/picture?id=self-hosted%3Asam" />
      </ChatRuntimeContext.Provider>
    )

    await settle()

    expect(fetchPicture).toHaveBeenCalledWith('/api/auth/picture?id=self-hosted%3Asam')
    expect(container.querySelector('.hm-avatar')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('somebody else’s turn in the group chat', () => {
  const draw = (
    pictures: PeoplePictures | undefined,
    ownAuthorId: string | undefined,
    author: { id: string; name: string }
  ) =>
    render(
      <ChatRuntimeContext.Provider value={pictures ? runtimeWith(pictures) : null}>
        <ItemContext.Provider
          value={{ botName: 'Bot', gatewayBaseUrl: 'http://gateway.test', ownAuthorId, groupChat: true }}
        >
          <ChatItem row={{ item: userItem('hi', { author, ts: LONG_AGO }), presentation: 'full' }} />
        </ItemContext.Provider>
      </ChatRuntimeContext.Provider>
    )

  it('puts their picture beside the bubble, by the id the row carries, and still names them in text', async () => {
    const { pictures, fetchPicture } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })
    const { container } = draw(pictures, 'authentik:me', { id: 'authentik:dana', name: 'Dana' })

    await settle()

    expect(fetchPicture).toHaveBeenCalledWith('/api/auth/picture?id=authentik%3Adana')
    expect(container.querySelector('.hm-msg__row .hm-avatar__picture')?.getAttribute('src')).toBe(PICTURE)
    expect(container.querySelector('.hm-msg__sender')?.textContent).toBe('Dana')
    expect(container.querySelector('article')?.getAttribute('aria-label')).toMatch(/^Dana, /)
  })

  it('draws the initial circle when the gateway has no picture of them', async () => {
    const { pictures } = cacheAnswering({ kind: 'missing' })
    const { container } = draw(pictures, 'authentik:me', { id: 'authentik:dana', name: 'Dana' })

    await settle()

    expect(container.querySelector('.hm-msg__row .hm-avatar')?.textContent).toBe('D')
    expect(container.querySelector('img')).toBeNull()
  })

  it('draws no picture beside the reader’s own turn', async () => {
    const { pictures, fetchPicture } = cacheAnswering({ kind: 'ready', dataUri: PICTURE })
    const { container } = draw(pictures, 'authentik:me', { id: 'authentik:me', name: 'Me' })

    await settle()

    expect(container.querySelector('.hm-avatar')).toBeNull()
    expect(fetchPicture).not.toHaveBeenCalled()
  })
})
