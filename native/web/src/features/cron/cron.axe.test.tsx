/**
 * The Crons pages and the Activity timeline through axe, in both colour schemes and three languages: the list, one
 * cron (with its delete question open), the editor in each of its schedule kinds with its errors showing, a run, and
 * the timeline.
 *
 * jsdom has no layout and does not load the stylesheets, so contrast is `ui/theme.contrast.test.ts`'s and the
 * browser suite's (`e2e/crons.spec.ts`).
 */
import { createChatState, type TranscriptItem } from '@hermie/transcript'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { cronStore } from '../../state/cron'
import { fakeCron } from '../../test-support/cron-transport'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { ChatScreenController } from '../chat/chat-runtime'
import { App } from '../shell/App'

function mount(hash: string) {
  const router = createHashRouter(null)
  const cron = fakeCron()
  const controller = {
    loadActivity: vi.fn(async () => undefined),
    activeSubagentCount: vi.fn(async () => 0),
    inFlightDeliveries: vi.fn(async () => 0)
  } as unknown as ChatScreenController

  router.navigate(hash)

  render(
    <App
      user="Tester"
      onSignIn={() => {}}
      onSignOut={() => {}}
      router={router}
      cron={{ transport: cron.transport }}
      chat={{ controller, gatewayBaseUrl: 'http://gateway.test' }}
    />
  )

  return { router }
}

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

beforeEach(() => {
  resetShellStores()
  cronStore.getState().reset()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Ada' }), aBot('writer')])
  document.documentElement.lang = 'en'
})

afterEach(() => {
  applyTheme({ scheme: 'system', tint: 'blue' })
  resetLocale()
  resetActiveLocale()
})

describe.each(['light', 'dark'] as const)('crons and activity, through axe, in the %s scheme', scheme => {
  beforeEach(() => applyTheme({ scheme, tint: 'blue' }))

  it.each(['en', 'nl', 'de'] as const)(
    'has no violation on the list, a cron and its delete question (%s)',
    async locale => {
      await act(async () => {
        await setLanguageChoice(locale)
      })
      const { router } = mount('#/crons')
      await waitFor(() => expect(document.querySelector('[data-job="job-digest"]')).not.toBeNull())

      const found = [...(await violations())]

      act(() => router.navigate('#/crons/job-heartbeat'))
      await waitFor(() => expect(document.querySelector('.hm-cron__runs')).not.toBeNull())
      found.push(...(await violations()))

      fireEvent.click(document.querySelector<HTMLElement>('.hm-cron__buttons .hm-button--danger')!)
      expect(document.querySelector('.hm-cron__confirm')).not.toBeNull()
      found.push(...(await violations()))

      expect(found).toEqual([])
    }
  )

  it.each(['en', 'nl', 'de'] as const)(
    'has no violation in the editor, in every schedule kind, with its errors (%s)',
    async locale => {
      await act(async () => {
        await setLanguageChoice(locale)
      })
      mount('#/crons/new')
      await waitFor(() => expect(document.querySelector('form.hm-cron-form')).not.toBeNull())

      const found = [...(await violations())]

      // Errors showing: nothing typed, and a schedule that cannot be built.
      fireEvent.click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)
      found.push(...(await violations()))

      for (const mode of ['daily', 'cron', 'once']) {
        fireEvent.click(document.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!)
        found.push(...(await violations()))
      }

      expect(found).toEqual([])
    }
  )

  it('has no violation in a run’s transcript', async () => {
    mount('#/crons/job-heartbeat/runs/cron_job-heartbeat_1790000000')
    await screen.findByText('All clear: disk at 41%, memory at 58%.')

    expect(await violations()).toEqual([])
  })

  it.each(['en', 'nl', 'de'] as const)('has no violation on the timeline (%s)', async locale => {
    await act(async () => {
      await setLanguageChoice(locale)
    })

    const chat = createChatState('researcher', 's', 's')
    const item: TranscriptItem = {
      id: 'dm-1',
      kind: 'bot_dm_out',
      seq: 1000,
      version: 1,
      origin: 'history',
      ts: Math.floor(Date.now() / 1000) - 60,
      toolId: 'dm-1',
      target: '@writer',
      targetHandle: 'writer',
      message: 'Can you draft the announcement?',
      dispatch: { status: 'queued' }
    }

    chat.items[item.id] = item
    chat.order.push(item.id)
    chatsStore.setState({ chats: { researcher: chat } })
    mount('#/activity')
    await waitFor(() => expect(document.querySelector('.hm-activity__row')).not.toBeNull())

    expect(await violations()).toEqual([])
  })
})
