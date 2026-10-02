/**
 * HERM-83, Task 5: the store-wired half of the chat-list attribution.
 *
 * `packages/transcript/src/preview.test.ts` and `sender-preview.test.ts` cover
 * the pure decision (`chatRowPreview`/`formatChatPreview`) exhaustively; this
 * is the one test that proves `useRowPreview` actually reaches for the
 * reader's own identity (`useOwnAuthorStore`, the stamp-shaped id), the
 * sanitising resolver, and the SAME group-chat gate the transcript uses —
 * derived from what is bound under the bot's key, never assumed.
 */
import { act, renderHook } from '@testing-library/react-native'

import { createChatState, reconcile, rowsToItems, type TranscriptRow } from '@hermie/transcript'

import { useRowPreview } from '../../src/features/bots/row-preview'
import { useOwnAuthorStore } from '../../src/features/chats/own-author'
import { type Bot, useBotsStore } from '../../src/store/bots'
import { useChatLayoutStore } from '../../src/store/chat-layout'
import { useChatsStore } from '../../src/store/chats'

const ME = 'authentik:me'
const GATEWAY = 'gateway-one'
/** FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE (HERM-83 polish): see `format.ts`'s `isolate`. */
const FSI = '\u2068'
const PDI = '\u2069'
const GROUP = { id: 'stored-researcher', resolvedId: 'stored-researcher', preview: '', lastActive: 1, messageCount: 1 }
const OWN = { id: 'stored-own', resolvedId: 'stored-own', preview: '', lastActive: 2, messageCount: 1 }

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: GROUP
}

const COLLEAGUE_ROW: TranscriptRow = {
  role: 'user',
  row_id: 1,
  text: 'draft is ready',
  display_metadata: { author: { id: 'authentik:writer-review', name: 'Robin Vale' } }
}

function seedChat(rows: readonly TranscriptRow[], storedId = GROUP.id): void {
  useChatsStore
    .getState()
    .hydrate('researcher', reconcile(createChatState('researcher', storedId, storedId), rowsToItems(rows, 'rpc')))
}

describe('useRowPreview', () => {
  beforeEach(() => {
    useChatsStore.getState().reset()
    useBotsStore.getState().reset()
    useBotsStore.getState().setBots([BOT])
    useChatLayoutStore.setState({ current: {}, myChats: {} })
    useOwnAuthorStore.getState().reset()
    useOwnAuthorStore.getState().bind(GATEWAY)
    useOwnAuthorStore.getState().set(GATEWAY, { id: ME })
  })

  it('leads the group chat’s row with a foreign sender’s resolved name', () => {
    seedChat([COLLEAGUE_ROW])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe(`${FSI}Robin Vale${PDI}: draft is ready`)
    expect(result.current.system).toBe(false)
  })

  it('leaves the reader’s own attributed row exactly as it read before `author` existed', () => {
    seedChat([{ role: 'user', row_id: 1, text: 'ship it', display_metadata: { author: { id: ME } } }])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('ship it')
  })

  it('leaves an unattributed row unnamed, even once the reader’s own identity is known', () => {
    seedChat([{ role: 'user', row_id: 1, text: 'from before the stamp existed' }])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('from before the stamp existed')
  })

  it('falls back to the gateway’s own string, unattributed, when this device holds no transcript', () => {
    const { result } = renderHook(() => useRowPreview('an-unopened-bot', 'Message from 🤖 Writer (@writer): hi'))

    expect(result.current.text).toBe('🤖 @writer: hi')
  })

  it('names nobody while the reader’s own chat is the one bound under the bot’s key', () => {
    useBotsStore.getState().setCurrent('researcher', OWN)
    useChatLayoutStore.setState({ current: { researcher: OWN.id }, myChats: { researcher: true } })
    seedChat([COLLEAGUE_ROW], OWN.id)

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('draft is ready')
  })

  it('names nobody for a legacy title-only `myChats` entry, which has no id remembered yet', () => {
    // The reader's memory says "my chat" with no id (`current` absent); the
    // controller found it by title and bound it.
    useChatLayoutStore.setState({ current: {}, myChats: { researcher: true } })
    useBotsStore.getState().setCurrent('researcher', OWN)
    seedChat([COLLEAGUE_ROW], OWN.id)

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe('draft is ready')
  })

  it('keeps its answer while a switch has the key empty, rather than flipping', () => {
    seedChat([COLLEAGUE_ROW])

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    expect(result.current.text).toBe(`${FSI}Robin Vale${PDI}: draft is ready`)

    // The reader picks their own chat: the memory moves first, the chat under
    // the key is dropped, and then the switch is refused and the group chat
    // is put back. At no point is a personal chat bound.
    act(() => {
      useChatLayoutStore.setState({ current: { researcher: OWN.id }, myChats: { researcher: true } })
    })
    expect(result.current.text).toBe(`${FSI}Robin Vale${PDI}: draft is ready`)

    act(() => {
      useChatsStore.getState().forget('researcher')
      useChatLayoutStore.setState({ current: {}, myChats: {} })
      seedChat([COLLEAGUE_ROW])
    })
    expect(result.current.text).toBe(`${FSI}Robin Vale${PDI}: draft is ready`)
  })

  it('reads the reader’s own id under the gateway it is bound to, not another gateway’s', () => {
    seedChat([{ role: 'user', row_id: 1, text: 'ship it', display_metadata: { author: { id: ME } } }])
    useOwnAuthorStore.getState().bind('gateway-two')

    const { result } = renderHook(() => useRowPreview('researcher', ''))

    // Unknown on gateway two: nothing is foreign by id, so nothing is named.
    expect(result.current.text).toBe('ship it')

    act(() => {
      useOwnAuthorStore.getState().set('gateway-two', { id: 'authentik:somebody-else' })
    })
    expect(result.current.text).toBe(`${FSI}me${PDI}: ship it`)
  })
})
