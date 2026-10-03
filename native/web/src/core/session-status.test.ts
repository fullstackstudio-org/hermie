import type { AuthIdentity } from '@hermie/gateway-client'
import { describe, expect, it, vi } from 'vitest'

import { createChatsStore } from '../state/chats'
import { createSessionStatusStore, rowAuthorsTrusted } from '../state/session-status'
import { chatWith } from '../test-support/chat-fixtures'
import type { SessionSignal } from './chat-controller'
import { createOwnAuthorStore } from './chats/own-author'
import { capabilitiesOf, identityAfter, SessionStatusModel } from './session-status'

const me = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  userId: '1',
  email: 'ann@example.com',
  displayName: 'Ann',
  orgId: '',
  provider: 'authentik',
  expiresAt: 0,
  pictureUrl: '',
  ...over
})

/** Let every already-resolved promise settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { initialAuthor?: { id: string; name?: string }; capabilities?: () => unknown } = {}) {
  const listeners = new Set<(signal: SessionSignal) => void>()
  const statusHandlers = new Set<(status: string) => void>()
  const store = createSessionStatusStore()
  const ownAuthor = createOwnAuthorStore()
  const chats = createChatsStore()
  const readIdentity = vi.fn(async (): Promise<AuthIdentity> => me())
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method !== 'gateway.capabilities') {
      throw new Error(`unexpected ${method}`)
    }

    return options.capabilities ? options.capabilities() : { per_session_exclusive_submit: true }
  })
  const model = new SessionStatusModel({
    gateway: {
      request: request as never,
      onStatus: handler => {
        const listener = (status: string): void => (handler as (status: string, error: null) => void)(status, null)

        statusHandlers.add(listener)

        return () => statusHandlers.delete(listener)
      }
    },
    readIdentity,
    initialAuthor: 'initialAuthor' in options ? options.initialAuthor : { id: 'authentik:1', name: 'Ann' },
    ownAuthor,
    chats,
    store,
    watchSignals: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  })
  const say = (signal: SessionSignal): void => {
    for (const listener of listeners) {
      listener(signal)
    }
  }
  const status = (next: string): void => {
    for (const handler of statusHandlers) {
      handler(next)
    }
  }

  ownAuthor.getState().set(options.initialAuthor)
  chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chats.getState().bindRuntime('researcher', 'rt-1')
  model.start()

  return { model, store, ownAuthor, chats, readIdentity, request, say, status, listeners }
}

describe('who the reader is', () => {
  it('starts from what the boot read, and says anonymous for a gateway that named nobody', () => {
    expect(setup().store.getState().identity).toEqual({ kind: 'known', authorId: 'authentik:1', name: 'Ann' })
    expect(setup({ initialAuthor: undefined }).store.getState().identity).toEqual({ kind: 'anonymous' })
  })

  it('asks /api/auth/me again after every reconnect, not on the first connection the boot just read for', async () => {
    const { status, readIdentity, store, ownAuthor } = setup()

    status('ready')
    await flush()
    expect(readIdentity).not.toHaveBeenCalled()

    readIdentity.mockResolvedValueOnce(me({ userId: '2', displayName: 'Bea' }))
    status('reconnecting')
    status('ready')
    await flush()

    expect(readIdentity).toHaveBeenCalledTimes(1)
    expect(store.getState().identity).toEqual({ kind: 'known', authorId: 'authentik:2', name: 'Bea' })
    expect(ownAuthor.getState().author).toEqual({ id: 'authentik:2', name: 'Bea' })
  })

  it('keeps a known identity when a read fails, and says failed when nothing named anybody', async () => {
    const known = setup()

    known.readIdentity.mockRejectedValue(new Error('offline'))
    await known.model.refreshIdentity()
    expect(known.store.getState().identity.kind).toBe('known')
    expect(known.ownAuthor.getState().author?.id).toBe('authentik:1')

    const nobody = setup({ initialAuthor: undefined })

    nobody.readIdentity.mockRejectedValue(new Error('offline'))
    await nobody.model.refreshIdentity()
    expect(nobody.store.getState().identity).toEqual({ kind: 'failed' })
  })

  it('forgets the author when the gateway now answers without an account', async () => {
    const { model, readIdentity, store, ownAuthor } = setup()

    readIdentity.mockResolvedValueOnce(me({ provider: '', userId: '' }))
    await model.refreshIdentity()

    expect(store.getState().identity).toEqual({ kind: 'anonymous' })
    expect(ownAuthor.getState().author).toBeUndefined()
  })

  it('applies only the newest read', async () => {
    const { model, readIdentity, store } = setup()
    let release: (value: AuthIdentity) => void = () => undefined

    readIdentity.mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
    readIdentity.mockResolvedValueOnce(me({ userId: '3', displayName: 'Cy' }))

    const first = model.refreshIdentity()

    await model.refreshIdentity()
    release(me({ userId: '9', displayName: 'Stale' }))
    await first

    expect(store.getState().identity).toEqual({ kind: 'known', authorId: 'authentik:3', name: 'Cy' })
  })

  it('never invents an id', () => {
    expect(identityAfter({ kind: 'unknown' }, null)).toEqual({ kind: 'failed' })
    expect(identityAfter({ kind: 'anonymous' }, me({ provider: 'authentik', userId: '' }))).toEqual({
      kind: 'anonymous'
    })
  })
})

describe('what the gateway can do', () => {
  it('reads gateway.capabilities once per connection', async () => {
    const { status, request, store } = setup({
      capabilities: () => ({
        per_session_exclusive_submit: true,
        per_message_author: true,
        transcript_row_identity: true
      })
    })

    expect(store.getState().capabilities).toBeNull()

    status('ready')
    status('ready')
    await flush()

    expect(request).toHaveBeenCalledTimes(1)
    expect(store.getState().capabilities).toEqual({
      perSessionExclusiveSubmit: true,
      perMessageAuthor: true,
      transcriptRowIdentity: true
    })
    expect(rowAuthorsTrusted(store.getState())).toBe(true)

    status('reconnecting')
    status('ready')
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('leaves what was known when the gateway has no answer, and withholds what is not advertised', async () => {
    let answer: () => unknown = () => ({ per_session_exclusive_submit: true })
    const { status, store } = setup({ capabilities: () => answer() })

    status('ready')
    await flush()
    expect(store.getState().capabilities).toEqual({
      perSessionExclusiveSubmit: true,
      perMessageAuthor: false,
      transcriptRowIdentity: false
    })
    expect(rowAuthorsTrusted(store.getState())).toBe(false)

    answer = () => {
      throw new Error('Unknown method: gateway.capabilities')
    }
    status('reconnecting')
    status('ready')
    await flush()

    expect(store.getState().capabilities).toEqual({
      perSessionExclusiveSubmit: true,
      perMessageAuthor: false,
      transcriptRowIdentity: false
    })
  })

  it('reads the answer defensively', () => {
    expect(capabilitiesOf(null)).toBeNull()
    expect(capabilitiesOf([])).toBeNull()
    expect(capabilitiesOf({ per_message_author: 'yes', transcript_row_identity: 1 })).toEqual({
      perSessionExclusiveSubmit: false,
      perMessageAuthor: false,
      transcriptRowIdentity: false
    })
  })
})

describe('resume progress', () => {
  it('shows a line while the gateway loads a resumed chat, its reason when it could not, and nothing once done', () => {
    const { say, store, model } = setup()
    const progress = (payload: Record<string, unknown>): void =>
      say({ kind: 'resume.progress', chat: 'researcher', payload })

    say({ kind: 'resumed', chat: 'researcher', runtimeSessionId: 'rt-1', pendingConnection: null, hydrating: true })
    expect(store.getState().resumeProgress).toEqual({ researcher: { status: 'loading' } })

    progress({ phase: 'history', status: 'complete', message_count: 4 })
    expect(store.getState().resumeProgress).toEqual({})

    progress({ phase: 'history', status: 'failed', message: 'disk‮ full\u0007' })
    expect(store.getState().resumeProgress).toEqual({ researcher: { status: 'failed', message: 'disk full' } })

    progress({ phase: 'history', status: 'sideways' })
    expect(store.getState().resumeProgress.researcher?.status).toBe('failed')

    model.dismissProgress('researcher')
    expect(store.getState().resumeProgress).toEqual({})

    progress({ phase: 'history', status: 'loading' })
    say({ kind: 'resumed', chat: 'researcher', runtimeSessionId: 'rt-1', pendingConnection: null, hydrating: false })
    expect(store.getState().resumeProgress).toEqual({})
  })

  it('drops the line of a chat that lets go of its session', () => {
    const { say, store, chats } = setup()

    say({ kind: 'resume.progress', chat: 'researcher', payload: { status: 'loading' } })
    chats.getState().dropRuntime('researcher')

    expect(store.getState().resumeProgress).toEqual({})
  })

  it('stops hearing and forgets everything when it stops', async () => {
    const { model, store, listeners, status, request } = setup()

    model.stop()
    status('ready')
    await flush()

    expect(listeners.size).toBe(0)
    expect(request).not.toHaveBeenCalled()
    expect(store.getState().identity).toEqual({ kind: 'unknown' })
  })
})
