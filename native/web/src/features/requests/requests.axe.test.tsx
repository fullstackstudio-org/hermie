/**
 * The composer and the request layer through axe, in both colour schemes and
 * every language: the page with a conversation, the composer with its queue and
 * its completions, and the layer open on each kind of request.
 *
 * jsdom has no layout and does not load the stylesheets, so colour contrast is not
 * run here: `ui/theme.contrast.test.ts` measures the theme's pairs, and
 * `e2e/chat/compose.spec.ts` runs axe, contrast included, in a real browser with
 * the layer open, in light and dark. What this checks is the structure: roles,
 * names, labels, the dialog's relations and the page behind it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { bindRequests, requestsStore } from '../../state/requests'
import { assistantItem, chatWith, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { ChatSessionRuntime } from '../chat/chat-runtime'
import { App } from '../shell/App'

let stop: () => void = () => undefined

beforeEach(() => {
  resetShellStores()
  requestsStore.getState().reset()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
  chatsStore.getState().hydrate(
    'researcher',
    chatWith('researcher', [userItem('hello', {}, 'u1'), assistantItem('hi there', {}, 'a1')], {
      runtimeSessionId: 'rt-1'
    })
  )
  chatsStore.getState().hydrate('writer', chatWith('writer', [], { runtimeSessionId: 'rt-2' }))
  stop = bindRequests(chatsStore, requestsStore)
})

afterEach(() => {
  stop()
  applyTheme({ scheme: 'system', tint: 'blue' })
  document.documentElement.removeAttribute('data-tint')
  resetActiveLocale()
  window.localStorage.removeItem('hermie.language')
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

const runtime = (): ChatSessionRuntime => ({
  gatewayBaseUrl: 'http://gateway.test',
  controller: {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    acknowledgeApproval: vi.fn(async () => undefined),
    querySlash: vi.fn(async () => ({
      items: [
        { text: 'model', display: '/model', meta: 'Switch the model' },
        { text: 'help', display: '/help', meta: 'What can I do' }
      ],
      replaceFrom: 1
    }))
  } as unknown as ChatSessionRuntime['controller']
})

const mount = (hash = '#/chat/researcher') => {
  const router = createHashRouter(null)

  router.navigate(hash)

  return render(<App user="Tester" onSignIn={() => {}} onSignOut={() => {}} router={router} chat={runtime()} />)
}

const approval = (): void =>
  void act(() =>
    chatsStore.getState().dispatchServerRequest('researcher', {
      id: 'srq-1',
      method: 'approval',
      params: {
        command: 'find . -name "*.log" -mtime +30 -delete && echo "a very long command that wraps ".repeat(8)',
        description: 'Delete old logs',
        tool_name: 'run_command',
        choices: ['once', 'session', 'always', 'deny'],
        request_id: 'a-1'
      }
    })
  )

const clarify = (params: Record<string, unknown>): void =>
  void act(() => chatsStore.getState().dispatchServerRequest('writer', { id: 'srq-2', method: 'clarify', params }))

describe('the composer and the request layer, through axe', () => {
  describe.each(['light', 'dark', 'system'] as const)('in the %s scheme', scheme => {
    beforeEach(() => applyTheme({ scheme, tint: 'blue' }))

    it('has no violation with the composer on a conversation', async () => {
      mount()

      expect(screen.getByRole('textbox', { name: 'Message Dr. Researcher' })).toBeTruthy()
      expect(await violations()).toEqual([])
    })

    it('has no violation with a queue, a failure and the completions open', async () => {
      mount()
      act(() => {
        chatsStore.getState().enqueue('researcher', { id: 'q:1', text: 'first waiting message' })
        chatsStore.getState().enqueue('researcher', { id: 'q:2', text: 'second', attachments: ['@file:/srv/a.pdf'] })
      })

      const field = screen.getByRole('textbox')

      fireEvent.change(field, { target: { value: '/m' } })
      await act(async () => undefined)

      expect(screen.getByRole('listbox')).toBeTruthy()
      expect(await violations()).toEqual([])
    })

    it('has no violation while a reply runs and Stop is there', async () => {
      chatsStore.getState().hydrate(
        'researcher',
        chatWith('researcher', [userItem('go', {}, 'u1')], {
          runtimeSessionId: 'rt-1',
          turn: { active: true } as never
        })
      )
      mount()

      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
      expect(await violations()).toEqual([])
    })

    it('has no violation with an approval open over the chat', async () => {
      mount()
      approval()

      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(await violations()).toEqual([])
    })

    it('has no violation with a clarify open over another bot’s chat', async () => {
      mount()
      clarify({ question: 'Which of these?', choices: ['Alpha', 'Beta'], request_id: 'q1' })

      expect(await violations()).toEqual([])
    })

    it('has no violation with a multi-select, and with a step of a batch', async () => {
      mount()
      clarify({
        request_id: 'b1',
        questions: [
          { qid: 'q1', question: 'Pick some', choices: ['x', 'y'], multi_select: true },
          { qid: 'q2', question: 'And why?' }
        ]
      })

      expect(await violations()).toEqual([])

      fireEvent.click(screen.getByLabelText('x'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText('Question 2 of 2')).toBeTruthy()
      expect(await violations()).toEqual([])
    })
  })

  it.each(['nl', 'de'] as const)('has no violation in %s, with an approval open', async locale => {
    await setLanguageChoice(locale)
    mount()
    approval()

    expect(document.documentElement.lang).toBe(locale)
    expect(await violations()).toEqual([])
  })
})
