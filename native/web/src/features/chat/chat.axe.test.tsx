/**
 * The chat screen through axe, in both colour schemes and every language, with
 * a conversation that holds one of everything a row can be.
 *
 * jsdom has no layout and does not load the stylesheets, so colour contrast is
 * not run here: `ui/theme.contrast.test.ts` measures the theme's pairs, and the
 * Playwright suite (`e2e/chat/open-chat.spec.ts`) runs axe, contrast included, in
 * a real browser against the built client. What this checks is the structure:
 * landmarks, headings, names, roles, ARIA and labels, with the scheme attribute on
 * the document as the app puts it.
 */
import { act, render } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { chatViewStore } from '../../state/chat-view'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import {
  assistantItem,
  chatWith,
  daysAfter,
  noticeItem,
  statusItem,
  toolItem,
  userItem
} from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { App } from '../shell/App'
import { loadChatScreen } from './load'
import type { ChatSessionRuntime } from './chat-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
})

afterEach(() => {
  applyTheme({ scheme: 'system', tint: 'blue' })
  document.documentElement.removeAttribute('data-tint')
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    rules: { 'color-contrast': { enabled: false } }
  })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

/** One of everything: both days, every kind, a heading in a reply, a code block, a table, a failure. */
function conversation() {
  return chatWith(
    'researcher',
    [
      userItem(
        'Good morning, a **question** about the [docs](https://example.test).',
        { ts: daysAfter(0, 3600) },
        'u1'
      ),
      assistantItem(
        '# Findings\n\n## Detail\n\nSome *words*.\n\n```ts\nexport const a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- [x] two',
        { ts: daysAfter(0, 3700), usage: { input: 10, output: 20, model: 'acme-large-2' } as never, durationS: 3 },
        'a1'
      ),
      toolItem('web_search', { summary: 'three results', args: { query: 'retry' }, durationS: 0.4 }, 't1'),
      toolItem('shell', { status: 'error', isError: true, result: { error: 'permission denied' } }, 't2'),
      noticeItem('Switched to a faster model', { noticeKind: 'model_switch' }, 'n1'),
      noticeItem('Job finished', { noticeKind: 'process_complete', body: 'exit 0' }, 'n2'),
      statusItem('compacting context', {}, 's1'),
      userItem('And the next day', { ts: daysAfter(2, 3600), pending: true, attachments: ['@file:/srv/a.pdf'] }, 'u2'),
      userItem('Hello from Dana', { ts: daysAfter(2, 3650), author: { id: 'p:dana', name: 'Dana' } }, 'u3'),
      assistantItem(
        'Half an answer',
        { ts: daysAfter(2, 3700), error: { message: 'rate limited', partial: true } },
        'a2'
      ),
      assistantItem('', { ts: daysAfter(2, 3800), streaming: true }, 'a3')
    ],
    { turn: { active: true, local: true, nextSeq: 90_000 } }
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
    closeChat: vi.fn(async () => undefined)
  } as unknown as ChatSessionRuntime['controller']
})

/** The chat screen is a chunk of its own: draw the app, then wait for the screen to arrive. */
const mount = async (hash = '#/chat/researcher') => {
  const router = createHashRouter(null)

  router.navigate(hash)

  const view = render(<App user="Tester" onSignIn={() => {}} onSignOut={() => {}} router={router} chat={runtime()} />)

  await act(async () => {
    await loadChatScreen()
  })

  return view
}

describe('the chat screen, through axe', () => {
  describe.each(['light', 'dark', 'system'] as const)('in the %s scheme', scheme => {
    beforeEach(() => {
      applyTheme({ scheme, tint: 'blue' })
      // At `normal`, so every kind is on the screen: `quiet`, the default, folds the tools away.
      chatViewStore.getState().setDefaults({ level: 'normal' })
    })

    it('has no violation with a conversation of every kind on it', async () => {
      chatsStore.getState().hydrate('researcher', conversation())
      await mount()

      expect(document.querySelectorAll('[data-row-key]').length).toBeGreaterThan(10)
      expect(await violations()).toEqual([])
    })

    it('has no violation with a tool opened and a reader scrolled away from the bottom', async () => {
      chatsStore.getState().hydrate('researcher', conversation())
      const { container } = await mount()

      container.querySelector<HTMLButtonElement>('.hm-tool__line')?.click()
      expect(await violations()).toEqual([])
    })

    it('has no violation with the task list open and a tool being written', async () => {
      chatsStore.getState().hydrate('researcher', {
        ...conversation(),
        turn: { active: true, local: true, nextSeq: 90_000, draftingTool: 'terminal' },
        todo: {
          revision: 3,
          todos: [
            { id: '1', content: 'Read the logs', status: 'completed' },
            { id: '2', content: 'Find the cause', status: 'in_progress' },
            { id: '2a', content: 'Check the retry path', status: 'pending', parent: '2' },
            { id: '3', content: 'Old idea', status: 'cancelled' }
          ]
        }
      })
      const { container } = await mount()

      expect(container.querySelector('[data-generating]')).toBeTruthy()
      container.querySelector<HTMLButtonElement>('.hm-todo__head')?.click()
      await act(async () => undefined)
      expect(container.querySelectorAll('.hm-todo__task')).toHaveLength(4)
      expect(await violations()).toEqual([])
    })

    it('has no violation while the chat is empty, loading or has failed to open', async () => {
      const first = await mount()

      expect(await violations()).toEqual([])
      first.unmount()

      chatsStore.getState().hydrate('researcher', chatWith('researcher', []))
      const second = await mount()

      expect(await violations()).toEqual([])
      second.unmount()

      await mount('#/chat/ghost')
      expect(await violations()).toEqual([])
    })
  })

  it.each(['nl', 'de'] as const)('has no violation in %s', async locale => {
    chatsStore.getState().hydrate('researcher', conversation())
    await setLanguageChoice(locale)
    await mount()

    expect(document.documentElement.lang).toBe(locale)
    expect(await violations()).toEqual([])
  })

  it('has no violation on a past conversation, read-only', async () => {
    chatsStore.getState().hydrate('researcher#old', conversation())
    await mount('#/chat/researcher/s/old')

    expect(await violations()).toEqual([])
  })
})
