/**
 * The reader's own picture in the sidebar's foot: the one the gateway named, fetched through the same
 * cache as everybody else's, and the initial when there is none.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ownAuthorStore } from '../../core/chats/own-author'
import { createPeoplePictures } from '../../core/people-pictures'
import { sessionStatusStore } from '../../state/session-status'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { ConnectionLine } from './ConnectionLine'
import { SidebarFooter } from './SidebarFooter'

const PICTURE = 'data:image/png;base64,AAAA'
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))

afterEach(() => {
  cleanup()
  ownAuthorStore.getState().reset()
  sessionStatusStore.getState().reset()
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

  it('on a gateway without sign-in, says there is none and offers to forget the token', () => {
    const onSignOut = vi.fn()

    // Nobody is named, which the identity note would say again under the line that already says it.
    sessionStatusStore.setState({ identity: { kind: 'anonymous' } })

    const { container, getByRole, queryByRole } = render(<SidebarFooter user="" gated={false} onSignOut={onSignOut} />)

    expect(container.querySelector('.hm-sidebar__who')?.textContent).toBe('No sign-in on this gateway')
    expect(container.querySelector('[data-identity]')).toBeNull()
    expect(queryByRole('button', { name: 'Sign out' })).toBeNull()

    fireEvent.click(getByRole('button', { name: 'Forget the token' }))

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionLine', () => {
  it('asks for a sign-in when a session lapsed, and on a gateway without sign-in reads the token again', () => {
    const onSignIn = vi.fn()
    const gated = render(<ConnectionLine status="needs_signin" onSignIn={onSignIn} />)

    expect(gated.getByRole('alert').textContent).not.toMatch(/token/u)
    gated.unmount()

    const ungated = render(<ConnectionLine status="needs_signin" gated={false} onSignIn={onSignIn} />)

    expect(ungated.getByRole('alert').textContent).toMatch(/did not accept the token from its dashboard page/u)
    fireEvent.click(ungated.getByRole('button', { name: 'Read it from the dashboard again' }))
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })
})
