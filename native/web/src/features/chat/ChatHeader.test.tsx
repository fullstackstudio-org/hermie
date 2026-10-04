import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { assistantItem, chatWith, toolItem, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatHeader } from './ChatHeader'

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
})

const state = () => document.querySelector('.hm-chat-header__status')?.textContent
const bead = () => document.querySelector('.hm-bead')?.getAttribute('data-state')
const active = { turn: { active: true, local: true, nextSeq: 9000 } }

describe('the line under the bot’s name', () => {
  it('says Online for a bot that is connected and idle, with the bead to match', () => {
    render(<ChatHeader bot="researcher" chatKey="researcher" />)

    expect(state()).toBe('Online')
    expect(bead()).toBe('online')
  })

  it('says what the turn is doing, narrowest first', () => {
    act(() => chatsStore.getState().hydrate('researcher', chatWith('researcher', [userItem('q', {}, 'q')], active)))
    render(<ChatHeader bot="researcher" chatKey="researcher" />)
    expect(state()).toBe('Working…')
    expect(bead()).toBe('working')

    act(() =>
      chatsStore
        .getState()
        .hydrate(
          'researcher',
          chatWith('researcher', [userItem('q', {}, 'q'), assistantItem('Hel', { streaming: true }, 'a')], active)
        )
    )
    expect(state()).toBe('Typing…')

    act(() =>
      chatsStore
        .getState()
        .hydrate(
          'researcher',
          chatWith(
            'researcher',
            [userItem('q', {}, 'q'), toolItem('mcp__terminal__run', { status: 'running' }, 't')],
            active
          )
        )
    )
    expect(state()).toBe('Running terminal…')
  })

  it('says it is waiting for the reader when a request is open, even once the turn is over', () => {
    act(() => chatsStore.getState().hydrate('researcher', chatWith('researcher', [])))
    act(() =>
      chatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-1',
        method: 'approval',
        params: { request_id: 'a1', command: 'ls', choices: ['once', 'deny'] }
      })
    )
    render(<ChatHeader bot="researcher" chatKey="researcher" />)

    expect(state()).toBe('Waiting for you')
    expect(bead()).toBe('needsInput')
  })

  it('says what the connection is doing when that is why nothing is happening', () => {
    render(<ChatHeader bot="researcher" chatKey={undefined} />)

    for (const [status, words] of [
      ['connecting', 'Connecting…'],
      ['reconnecting', 'Reconnecting…'],
      ['needs_signin', 'Signed out'],
      ['offline', 'Offline']
    ] as const) {
      act(() => connectionStore.getState().setStatus(status, null))
      expect(state(), status).toBe(words)
      expect(bead(), status).toBe('offline')
    }
  })

  it('draws the avatar’s letter from the cleaned name: an invisible or direction-changing first character is not one', () => {
    seedRoster([aBot('researcher', { displayName: '\u202E\u2060\u2066Zoe' })])
    render(<ChatHeader bot="researcher" chatKey="researcher" />)

    expect(document.querySelector('.hm-avatar')?.textContent).toBe('Z')
  })

  it('shows the bot’s own picture, and follows the language', async () => {
    botsStore.getState().setAvatar('researcher', 0, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')
    render(<ChatHeader bot="researcher" chatKey="researcher" />)

    expect(document.querySelector('img')?.getAttribute('src')).toContain('data:image/gif')

    await act(() => setLanguageChoice('nl'))
    expect(state()).toBe('Online')
    expect(screen.getByText('Online')).toBeTruthy()
  })
})
