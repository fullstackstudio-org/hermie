/**
 * Finding a search hit's row in the chat it opened: found, still arriving,
 * paged back to, and given up on (by the start of the chat or by the bound).
 */
import type { VisibleItem } from '@hermie/transcript'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TranscriptListHandle } from '../chat/TranscriptList'
import { createFindRequests, type FindRequest } from './find-request'
import { FIND_PAGE_LIMIT, useFindInChat, type UseFindInChatOptions } from './use-find-in-chat'

const say = (id: string, text: string): VisibleItem =>
  ({
    item: { id, kind: 'assistant', text, seq: 0, at: 0, origin: 'rest', version: 1, streaming: false, interim: false },
    presentation: 'full'
  }) as unknown as VisibleItem

function setup(over: Partial<UseFindInChatOptions> = {}) {
  const requests = createFindRequests()

  requests.request('researcher', 'invoice')

  const request = requests.current() as FindRequest
  const revealRow = vi.fn((_key: string) => true)
  const showOldest = vi.fn()
  const list = { current: { jumpToLatest: vi.fn(), revealRow, showOldest } satisfies TranscriptListHandle }
  const loadOlder = vi.fn(async () => 'start' as const)
  const initial: UseFindInChatOptions = {
    request,
    rows: [say('a1', 'hello'), say('a2', 'the invoice is due'), say('a3', 'thanks')],
    loaded: true,
    list,
    loadOlder,
    requests,
    ...over
  }
  const hook = renderHook((props: UseFindInChatOptions) => useFindInChat(props), { initialProps: initial })

  return { hook, initial, requests, revealRow, loadOlder, showOldest }
}

describe('useFindInChat', () => {
  it('shows the newest row with the words, says so and settles the request', () => {
    const { hook, requests, revealRow } = setup({
      rows: [say('a1', 'an invoice'), say('a2', 'the invoice again'), say('a3', 'thanks')]
    })

    expect(revealRow).toHaveBeenCalledWith('a2')
    expect(hook.result.current).toEqual({ status: 'Found “invoice” in this chat.', missed: false })
    expect(requests.current()).toBeNull()
  })

  it('waits for a chat that is still arriving before it calls anything a miss', () => {
    const { hook, initial, loadOlder, revealRow } = setup({ rows: [], loaded: false })

    expect(loadOlder).not.toHaveBeenCalled()
    expect(hook.result.current.status).toBe('')

    hook.rerender({ ...initial, rows: [say('a9', 'invoice')], loaded: true })
    expect(revealRow).toHaveBeenCalledWith('a9')
  })

  it('pages back through older history until the row turns up', async () => {
    const loadOlder = vi.fn(async () => 'grew' as const)
    const { hook, initial, revealRow, showOldest } = setup({ rows: [say('a3', 'thanks')], loadOlder })

    await vi.waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1))
    // The list goes to its oldest row once the page is asked for, where the page will land.
    expect(showOldest).toHaveBeenCalledTimes(1)
    expect(loadOlder.mock.invocationCallOrder[0]).toBeLessThan(showOldest.mock.invocationCallOrder[0]!)

    // The page comes in: the older row has the words.
    await act(async () => {
      hook.rerender({ ...initial, loadOlder, rows: [say('o1', 'the invoice'), say('a3', 'thanks')] })
    })

    expect(revealRow).toHaveBeenCalledWith('o1')
    expect(hook.result.current.missed).toBe(false)
  })

  it('says the words are not in the visible text once the chat has no more history', async () => {
    const { hook, requests } = setup({ rows: [say('a1', 'nothing to see')] })

    await vi.waitFor(() => expect(hook.result.current.missed).toBe(true))
    expect(hook.result.current.status).toBe(
      '“invoice” was matched by the gateway, but it is not in the visible text of this chat.'
    )
    expect(requests.current()).toBeNull()
  })

  it('stops after the page limit instead of reading the whole chat', async () => {
    let rows = [say('a1', 'nothing')]
    let page = 0
    const loadOlder = vi.fn(async () => {
      page += 1
      rows = [say(`o${page}`, 'still nothing'), ...rows]

      return 'grew' as const
    })
    const { hook, initial } = setup({ rows, loadOlder })

    for (let step = 0; step < FIND_PAGE_LIMIT + 5 && !hook.result.current.missed; step += 1) {
      await act(async () => {
        await Promise.resolve()
        hook.rerender({ ...initial, loadOlder, rows })
      })
    }

    expect(hook.result.current.missed).toBe(true)
    expect(loadOlder).toHaveBeenCalledTimes(FIND_PAGE_LIMIT)
  })

  it('does nothing without a request', () => {
    const { revealRow, loadOlder } = setup({ request: null })

    expect(revealRow).not.toHaveBeenCalled()
    expect(loadOlder).not.toHaveBeenCalled()
  })
})
