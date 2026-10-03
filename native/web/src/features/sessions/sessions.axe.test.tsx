/**
 * The Conversations page, the read-only viewer and the chats field with its
 * message hits, through axe, in both colour schemes and three languages: no
 * violation, with every form of the page open (a rename field, a delete question,
 * the new-conversation question).
 *
 * jsdom has no layout and does not load the stylesheets, so contrast is
 * `ui/theme.contrast.test.ts`'s and the browser suite's (`e2e/sessions.spec.ts`).
 */
import type { SessionSearchHttp } from '@hermie/gateway-client'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversationGroups } from '../../core/sessions/session-model'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { connectionStore } from '../../state/connection'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { ChatScreenController } from '../chat/chat-runtime'
import { App } from '../shell/App'

const GROUPS: ConversationGroups = {
  canonical: {
    id: 'stored-researcher',
    resolvedId: 'stored-researcher',
    title: 'Bot Chat',
    preview: 'Latest',
    messageCount: 12,
    lastActive: 1_700_000_000,
    kind: 'canonical'
  },
  mine: null,
  branches: [
    {
      id: 'branch-1',
      resolvedId: 'branch-1',
      title: 'Branch · cheaper flights',
      preview: 'What about Porto?',
      messageCount: 6,
      lastActive: 1_700_000_100,
      kind: 'branch'
    }
  ],
  past: [
    {
      id: 'old-1',
      resolvedId: 'old-1',
      title: 'Bot Chat · 2026-09-01 10:00',
      preview: '',
      messageCount: 30,
      lastActive: 0,
      kind: 'past'
    }
  ]
}

function controller(): ChatScreenController {
  return {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'viewer' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    listConversations: vi.fn(async () => GROUPS),
    onConversationsChanged: vi.fn(() => () => undefined)
  } as unknown as ChatScreenController
}

const searchHttp: SessionSearchHttp = {
  get: (async () => ({
    results: [{ session_id: 'stored-researcher', snippet: 'the >>>invoice<<< is due', last_active: 1_700_000_000 }]
  })) as SessionSearchHttp['get']
}

function mount(hash: string) {
  const router = createHashRouter(null)

  router.navigate(hash)

  return render(
    <App
      user="Tester"
      onSignIn={() => {}}
      onSignOut={() => {}}
      router={router}
      chat={{ controller: controller(), gatewayBaseUrl: 'http://gateway.test', sessionSearch: searchHttp }}
    />
  )
}

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Ada' }), aBot('writer')])
  document.documentElement.lang = 'en'
})

afterEach(() => {
  applyTheme({ scheme: 'system', tint: 'blue' })
  resetActiveLocale()
})

describe.each(['light', 'dark'] as const)('conversations and search, through axe, in the %s scheme', scheme => {
  beforeEach(() => applyTheme({ scheme, tint: 'blue' }))

  it.each(['en', 'nl', 'de'] as const)(
    'has no violation on the Conversations page, nor with each of its forms open (%s)',
    async locale => {
      await act(async () => {
        await setLanguageChoice(locale)
      })
      mount('#/chat/researcher/conversations')

      await vi.waitFor(() => expect(document.querySelector('[data-conversation="old-1"]')).not.toBeNull())
      const row = (id: string) => document.querySelector<HTMLElement>(`[data-conversation="${id}"]`)!
      const found: string[] = [...(await violations())]

      // Rename (the first button of a branch's actions), a delete question (the second), then the new-conversation question.
      fireEvent.click(within(row('branch-1')).getAllByRole('button')[0]!)
      expect(within(row('branch-1')).getByRole('textbox')).toBeTruthy()
      found.push(...(await violations()))

      fireEvent.click(within(row('old-1')).getAllByRole('button')[1]!)
      expect(within(row('old-1')).queryByRole('group')).toBeNull()
      found.push(...(await violations()))

      fireEvent.click(document.querySelector<HTMLElement>('.hm-conversations__new button')!)
      expect(document.querySelector('.hm-conversations__new .hm-conversations__confirm')).not.toBeNull()
      found.push(...(await violations()))

      expect(found).toEqual([])
    }
  )

  it('has no violation in the read-only viewer', async () => {
    mount('#/chat/researcher/s/old-1')

    await screen.findByRole('link', { name: 'Back to the chat' })
    expect(await violations()).toEqual([])
  })

  it('has no violation with words in the chats field and a message hit under the list', async () => {
    mount('#/')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'invoice' } })
    await screen.findByRole('link', { name: /invoice/u })

    expect(await violations()).toEqual([])
  })
})
