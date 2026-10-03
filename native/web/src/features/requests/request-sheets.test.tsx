/**
 * The sheets' chunk (`request-sheets.ts`), from a page that has not fetched it
 * yet: this file runs in a module graph of its own, so nothing has loaded the
 * chunk before the first test. A request that arrives first is a dialog with
 * nothing to press, the sheet follows when the chunk is in, and from then on a
 * request is drawn in the same pass it arrives in.
 */
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { bindRequests, requestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatScreenController } from '../chat/chat-runtime'
import { preloadRequestSheets } from './request-sheets'
import { RequestLayer } from './RequestLayer'

const controller = {
  respondApproval: vi.fn(async () => undefined),
  acknowledgeApproval: vi.fn(async () => undefined)
} as unknown as ChatScreenController

let stopBinding: () => void = () => undefined

const mount = (): void =>
  void render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <RequestLayer tapGuardMs={0} />
    </ChatRuntimeContext.Provider>
  )

const approval = (id: string): void =>
  void act(() =>
    chatsStore.getState().dispatchServerRequest('researcher', {
      id,
      method: 'approval',
      params: { command: 'rm -rf ./build', description: 'Remove the build directory', request_id: `a-${id}` }
    })
  )

beforeEach(() => {
  resetShellStores()
  requestsStore.getState().reset()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-researcher' }))
  stopBinding = bindRequests(chatsStore, requestsStore)
})

afterEach(() => {
  stopBinding()
})

describe('the sheets’ chunk', () => {
  it('draws the dialog at once, with nothing to press, and the sheet as soon as the chunk is in', async () => {
    mount()
    approval('srq-1')

    const dialog = screen.getByRole('dialog')

    expect(dialog.querySelector('.hm-requests__pending')?.getAttribute('aria-busy')).toBe('true')
    expect(within(dialog).queryAllByRole('button')).toEqual([])

    expect(await screen.findByRole('dialog', { name: 'Allow this command?' })).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('.hm-requests__pending')).toBeNull()
  })

  it('resolves to the same module every time, and once it is in, a request is drawn in the pass it arrives in', async () => {
    const first = await preloadRequestSheets()

    expect(await preloadRequestSheets()).toBe(first)

    mount()
    approval('srq-2')

    expect(screen.getByRole('dialog', { name: 'Allow this command?' })).toBeTruthy()
  })
})
