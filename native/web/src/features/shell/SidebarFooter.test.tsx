/**
 * The reader's own picture in the sidebar's foot: the one the gateway named, fetched through the same
 * cache as everybody else's, and the initial when there is none.
 */
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ownAuthorStore } from '../../core/chats/own-author'
import { createPeoplePictures } from '../../core/people-pictures'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { SidebarFooter } from './SidebarFooter'

const PICTURE = 'data:image/png;base64,AAAA'
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

afterEach(() => {
  ownAuthorStore.getState().reset()
})

function draw(pictureUrl: string | undefined) {
  const fetchPicture = vi.fn(async () => ({ kind: 'ready', dataUri: PICTURE }) as const)
  const runtime = { pictures: createPeoplePictures({ fetchPicture }), gatewayBaseUrl: 'http://gateway.test' }

  ownAuthorStore.getState().set({ id: 'self-hosted:sam', name: 'Sam' })

  const view = render(
    <ChatRuntimeContext.Provider value={runtime as ChatSessionRuntime}>
      <SidebarFooter user="Sam" {...(pictureUrl === undefined ? {} : { pictureUrl })} onSignOut={() => undefined} />
    </ChatRuntimeContext.Provider>
  )

  return { ...view, fetchPicture }
}

describe('SidebarFooter', () => {
  it('shows the reader’s picture, from the address /api/auth/me gave, beside their name', async () => {
    const { container, fetchPicture } = draw('/api/auth/picture?id=self-hosted%3Asam')

    await settle()

    expect(fetchPicture).toHaveBeenCalledWith('/api/auth/picture?id=self-hosted%3Asam')
    expect(container.querySelector('.hm-sidebar__person .hm-avatar__picture')?.getAttribute('src')).toBe(PICTURE)
    expect(container.querySelector('.hm-sidebar__who')?.textContent).toContain('Sam')
  })

  it('shows the initial and fetches nothing when the gateway holds no picture of them', async () => {
    const { container, fetchPicture } = draw('')

    await settle()

    expect(fetchPicture).not.toHaveBeenCalled()
    expect(container.querySelector('.hm-sidebar__person .hm-avatar')?.textContent).toBe('S')
  })

  it('shows no avatar at all when the gateway named nobody', () => {
    const { container } = render(<SidebarFooter user="" onSignOut={() => undefined} />)

    expect(container.querySelector('.hm-avatar')).toBeNull()
  })
})
