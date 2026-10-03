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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileUploadError, type UploadableFile } from '../../core/chats/file-upload'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { chatsStore } from '../../state/chats'
import { connectionsStore } from '../../state/connections'
import { connectionStore } from '../../state/connection'
import { noticesStore } from '../../state/notices'
import { bindRequests, requestsStore } from '../../state/requests'
import { sessionStatusStore } from '../../state/session-status'
import { assistantItem, chatWith, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { ChatSessionRuntime } from '../chat/chat-runtime'
import { App } from '../shell/App'
import { preloadRequestSheets } from './request-sheets'

// The sheets are a chunk of their own (`request-sheets.ts`); the page fetches it when the session starts.
beforeAll(async () => {
  await preloadRequestSheets()
})

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
  stop = bindRequests(chatsStore, requestsStore, undefined, undefined, connectionsStore)
})

afterEach(() => {
  stop()
  connectionsStore.getState().reset()
  noticesStore.getState().reset()
  applyTheme({ scheme: 'system', tint: 'blue' })
  document.documentElement.removeAttribute('data-tint')
  resetActiveLocale()
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
    respondApproval: vi.fn(async (bot: string, id: string, choice: string) =>
      chatsStore.getState().answer(bot, id, choice)
    ),
    uploadFile: vi.fn((_bot: string, file: UploadableFile) => {
      if (file.name.startsWith('refused')) {
        return Promise.reject(new FileUploadError('refused', 'refused', 400, 'Path must be absolute'))
      }

      // `slow…` never answers: a chip that is still uploading.
      return file.name.startsWith('slow')
        ? new Promise(() => undefined)
        : Promise.resolve({ path: `/w/${file.name}`, reference: `@file:/w/${file.name}`, filename: file.name, size: 3 })
    }),
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

    it('has no violation with attachments in every state and files dragged over the chat', async () => {
      const { container } = mount()
      const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
      const files = ['ready.csv', 'slow.csv', 'refused.csv', 'shot.png'].map(
        name => new File(['abc'], name, { type: name.endsWith('.png') ? 'image/png' : 'text/csv' })
      )

      Object.defineProperty(picker, 'files', { value: files, configurable: true })
      fireEvent.change(picker)
      await waitFor(() => expect(screen.getByText(/Path must be absolute/u)).toBeTruthy())
      fireEvent.dragEnter(container.querySelector('.hm-chat')!, {
        dataTransfer: { types: ['Files'], files: [] } as unknown as DataTransfer
      })

      expect(screen.getByText('Drop file to attach')).toBeTruthy()
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

    it('has no violation with a smart-denied approval, and with one answer for several ticked', async () => {
      mount()
      approval()
      act(() =>
        chatsStore.getState().dispatchServerRequest('researcher', {
          id: 'srq-3',
          method: 'approval',
          params: { command: 'ls -la', request_id: 'a-3' }
        })
      )

      const tick = screen.getByRole('checkbox')

      await waitFor(() => expect((tick as HTMLInputElement).disabled).toBe(false))
      fireEvent.click(tick)
      expect(within(screen.getByRole('dialog')).getByText('ls -la')).toBeTruthy()
      expect(await violations()).toEqual([])

      act(() =>
        chatsStore.getState().dispatchServerRequest('writer', {
          id: 'srq-4',
          method: 'approval',
          params: { command: 'curl example.test', smart_denied: true, request_id: 'a-4' }
        })
      )
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false)
      )
      // Answers the first two (the box is ticked); the smart-denied one is next.
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(/safety check refused/u)).toBeTruthy())
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
      // The sheet's buttons wake after the tap guard.
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false)
      )
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

  it.each(['light', 'dark'] as const)(
    'has no violation in the %s scheme with a connection card, notices, a progress line and the identity line',
    async scheme => {
      applyTheme({ scheme, tint: 'blue' })
      act(() => {
        sessionStatusStore.setState({
          identity: { kind: 'anonymous' },
          resumeProgress: { researcher: { status: 'loading' } }
        })
        noticesStore.setState({
          notices: [
            { id: 'credits', text: 'Credits are low', level: 'warn', chat: 'researcher', serial: 1 },
            { id: 'boot', text: 'Starting the agent', level: 'info', chat: undefined, serial: 2 }
          ]
        })
      })
      mount()
      act(() =>
        connectionsStore.setState({
          cards: {
            researcher: {
              chat: 'researcher',
              runtimeSessionId: 'rt-1',
              opId: 'op-1',
              toolCallId: 'tc-1',
              seq: 1,
              deadline: Date.now() + 90_000,
              answer: { kind: 'failed', message: 'gateway not connected' },
              version: 1,
              seq0: 1,
              targets: [
                {
                  name: 'github',
                  label: 'github',
                  kind: 'connector',
                  action: 'authorize',
                  state: 'pending',
                  detail: 'Needs repo scope',
                  instructions: 'Sign in with your work account',
                  link: { url: 'https://auth.example/gh', host: 'auth.example' },
                  linkRefused: false,
                  opened: true
                },
                {
                  name: 'notion',
                  label: 'notion',
                  kind: 'mcp',
                  action: 'install',
                  state: 'pending',
                  detail: '',
                  instructions: null,
                  link: null,
                  linkRefused: true,
                  opened: false
                }
              ]
            }
          }
        })
      )

      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(await violations()).toEqual([])
    }
  )
})
