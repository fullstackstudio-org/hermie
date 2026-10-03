/**
 * The passkey model on its own, with a hand-driven connection: how a frame is
 * read (every 4040 reason and the notice it leaves), what `request.answer`'s
 * refusals mean, and what each `request.cancel` reason does to a confirmation in
 * each phase. The whole flow against a gateway that verifies is
 * `model.integration.test.ts`.
 */
import type { GatewayEvent } from '@hermes/shared/gateway-events'
import { JsonRpcGatewayError, type ServerRequest, type ServerRequestHandler } from '@hermes/shared/json-rpc-channel'
import { describe, expect, it, vi } from 'vitest'

import { createKeyValueStore, type StorageLike } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createPasskeysStore } from '../../state/passkeys'
import { softWebAuthn } from '../../test-support/soft-webauthn'
import type { PasskeyClient, PasskeyStatus } from './client'
import {
  credentialName,
  CREDENTIAL_NAME_LIMIT,
  DECLINE,
  type OpenSession,
  type PasskeyGateway,
  isTransportFailure,
  PasskeyModel,
  phaseAfter
} from './model'

const BASE = 'https://gw.example.test'
const GATEWAY_ID = 'AAECAwQFBgcICQoLDA0ODw'
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const CREDENTIAL = 'Y3JlZGVudGlhbC0x'

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()

  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    }
  }
}

/** A connection that is driven by hand: frames in, events in, `request.answer` answered by the test. */
function handGateway() {
  const handlers: ServerRequestHandler[] = []
  const listeners: ((event: GatewayEvent) => void)[] = []
  const answer = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ status: 'ok' }))
  const gateway: PasskeyGateway = {
    request: ((method: string, params: unknown) => answer(method, params)) as PasskeyGateway['request'],
    onAny: listener => {
      listeners.push(listener)

      return () => undefined
    },
    onRequest: handler => {
      handlers.push(handler)

      return () => undefined
    },
    // Never `ready`: nothing here advertises.
    onStatus: handler => {
      handler('connecting', null)

      return () => undefined
    }
  }

  return {
    gateway,
    answer,
    deliver(id: string, params: Record<string, unknown>): { accepted: boolean; failed: unknown[] } {
      const failed: unknown[] = []
      const request: ServerRequest = {
        id,
        method: 'confirm',
        params,
        respond: () => undefined,
        fail: (code, message) => void failed.push({ code, message })
      }
      const accepted = handlers.some(handler => handler(request) !== false)

      return { accepted, failed }
    },
    emit(type: string, payload: Record<string, unknown>) {
      for (const listener of listeners) {
        listener({ type, payload } as unknown as GatewayEvent)
      }
    }
  }
}

const frame = (overrides: Record<string, unknown> = {}, passkey: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  title: 'Pay invoice',
  summary: 'Pay 120.00 EUR.',
  detail: 'IBAN NL00 TEST 0123\nReference 2026-114',
  level: 'passkey',
  passkey: {
    v: 1,
    nonce: NONCE,
    gateway_id: GATEWAY_ID,
    base_url: BASE,
    expires_at: 1_790_000_120,
    user: { id: 'self-hosted:u1', name: 'Alex Example' },
    credentials: [
      { rp_id: 'confirm.hermie.dev', ids: ['bmF0aXZl'] },
      { rp_id: 'gw.example.test', ids: [CREDENTIAL] }
    ],
    ...passkey
  },
  ...overrides
})

/** The frame's `expires_at` is 120 s after this. */
const NOW = 1_790_000_000

function setUp(
  options: {
    baseUrl?: string
    available?: boolean
    pinned?: string
    foreign?: string
    client?: Partial<PasskeyClient>
    sessions?: readonly OpenSession[]
    watch?: (listener: () => void) => () => void
  } = {}
) {
  const hand = handGateway()
  const storage = memoryStorage()

  if (options.foreign) {
    storage.setItem(
      'hermie:/other:device.passkey.pin@https://other.example.test',
      JSON.stringify({ gateway_id: options.foreign })
    )
  }

  const kv = createKeyValueStore({ namespace: '/', storage })
  const pins = createPasskeyPins({ store: kv, baseUrl: BASE, storage })

  if (options.pinned) {
    pins.pin(options.pinned)
  }

  const store = createPasskeysStore()
  const clock = { now: NOW }
  const failures: { id: string; code: number; data: Record<string, unknown> }[] = []
  const model = new PasskeyModel({
    gateway: hand.gateway,
    client: (options.client ?? {}) as PasskeyClient,
    webauthn: softWebAuthn(BASE, { available: options.available ?? true }),
    baseUrl: options.baseUrl ?? BASE,
    pins,
    store,
    now: () => clock.now,
    ...(options.sessions ? { openSessions: () => options.sessions as readonly OpenSession[] } : {}),
    ...(options.watch ? { watchSessions: options.watch } : {}),
    failWithData: (request, code, _message, data) => void failures.push({ id: request.id, code, data })
  })

  model.start()

  return { ...hand, model, store, failures, clock, pins, storage }
}

describe('reading a confirm frame', () => {
  it('takes a frame at level passkey, with the text exactly as it came', () => {
    const page = setUp()
    const { accepted, failed } = page.deliver('srq-1', frame())

    expect(accepted).toBe(true)
    expect(failed).toEqual([])
    expect(page.store.getState().confirmations).toEqual([
      expect.objectContaining({
        id: 'srq-1',
        sessionId: 'sess-1',
        title: 'Pay invoice',
        summary: 'Pay 120.00 EUR.',
        detail: 'IBAN NL00 TEST 0123\nReference 2026-114',
        baseUrl: BASE,
        userName: 'Alex Example',
        expiresAt: 1_790_000_120,
        phase: { kind: 'waiting' },
        dismissed: false
      })
    ])
  })

  it('leaves level plain to the channel (never advertised here)', () => {
    const page = setUp()

    expect(page.deliver('srq-1', frame({ level: 'plain', passkey: undefined })).accepted).toBe(false)
  })

  it('keeps one confirmation per request id when the frame comes again', () => {
    const page = setUp()

    page.deliver('srq-1', frame())
    page.deliver('srq-1', frame())

    expect(page.store.getState().confirmations).toHaveLength(1)
  })

  const refusals: {
    name: string
    setup?: Parameters<typeof setUp>[0]
    params: Record<string, unknown>
    reason: string
    notice?: string
  }[] = [
    {
      name: 'no secure context or WebAuthn',
      setup: { available: false },
      params: frame(),
      reason: 'rp_not_configured'
    },
    {
      name: 'a gateway under a path prefix',
      setup: { baseUrl: `${BASE}/alice` },
      params: frame(),
      reason: 'bad_base_url'
    },
    {
      name: 'another contract version',
      params: frame({}, { v: 2 }),
      reason: 'unsupported_version',
      notice: 'unsupported_version'
    },
    {
      name: 'no passkey object',
      params: frame({ passkey: undefined }),
      reason: 'unsupported_version',
      notice: 'unsupported_version'
    },
    {
      name: 'a nonce of the wrong length',
      params: frame({}, { nonce: 'AAAA' }),
      reason: 'bad_request',
      notice: 'malformed_request'
    },
    { name: 'no user', params: frame({}, { user: {} }), reason: 'bad_request', notice: 'malformed_request' },
    { name: 'no summary', params: frame({ summary: 7 }), reason: 'bad_request', notice: 'malformed_request' },
    {
      name: 'no expires_at',
      params: frame({}, { expires_at: undefined }),
      reason: 'bad_request',
      notice: 'malformed_request'
    },
    {
      name: 'an expires_at that is not a number',
      params: frame({}, { expires_at: '1790000120' }),
      reason: 'bad_request',
      notice: 'malformed_request'
    },
    {
      name: 'no passkey of this site listed',
      params: frame({}, { credentials: [{ rp_id: 'confirm.hermie.dev', ids: ['bmF0aXZl'] }] }),
      reason: 'no_credential',
      notice: 'no_credential'
    },
    {
      name: 'another gateway id than the one pinned',
      setup: { pinned: 'ZmZmZmZmZmZmZmZmZmZmZg' },
      params: frame(),
      reason: 'gateway_id_mismatch',
      notice: 'gateway_id_mismatch'
    },
    {
      name: 'the id another gateway in this browser pinned',
      setup: { foreign: GATEWAY_ID },
      params: frame(),
      reason: 'gateway_id_conflict',
      notice: 'gateway_id_conflict'
    }
  ]

  for (const refusal of refusals) {
    it(`answers 4040 ${refusal.reason}: ${refusal.name}`, () => {
      const page = setUp(refusal.setup)

      expect(page.deliver('srq-9', refusal.params).accepted).toBe(true)
      expect(page.failures).toEqual([{ id: 'srq-9', code: 4040, data: { reason: refusal.reason } }])
      expect(page.store.getState().confirmations).toEqual([])
      expect(page.store.getState().notices.map(notice => notice.notice.kind)).toEqual(
        refusal.notice ? [refusal.notice] : []
      )
    })
  }
})

describe('what the gateway says back', () => {
  it('reads request.answer refusals as the native apps do', () => {
    expect(phaseAfter(new JsonRpcGatewayError('no', { code: 4033 }))).toEqual({
      kind: 'ended',
      end: { kind: 'not_allowed' }
    })
    expect(
      phaseAfter(new JsonRpcGatewayError('answer refused', { code: 4034, data: { reason: 'challenge_mismatch' } }))
    ).toEqual({ kind: 'refused', reason: 'challenge_mismatch' })
    expect(
      phaseAfter(new JsonRpcGatewayError('answer refused', { code: 4034, data: { reason: 'too_many_attempts' } }))
    ).toEqual({ kind: 'ended', end: { kind: 'too_many_attempts' } })
    expect(phaseAfter(new Error('gateway not connected'))).toEqual({
      kind: 'not_sent',
      message: 'gateway not connected'
    })
  })

  it('sends exactly the decline and closes the sheet', async () => {
    const page = setUp()

    page.deliver('srq-1', frame())
    await page.model.decline('srq-1')

    expect(page.answer).toHaveBeenCalledWith('request.answer', { id: 'srq-1', result: DECLINE })
    expect(page.store.getState().confirmations[0]).toMatchObject({ phase: { kind: 'declined' }, dismissed: true })
  })

  it('sends nothing when the browser sheet ends without a passkey, and an open sheet cannot be closed', async () => {
    const page = setUp()

    page.deliver('srq-1', frame())
    await page.model.confirm('srq-1')

    // The soft authenticator holds no passkey for the listed id: like a browser, it says "not allowed".
    expect(page.store.getState().confirmations[0]?.phase).toEqual({ kind: 'waiting' })
    expect(page.answer).not.toHaveBeenCalled()

    page.model.dismiss('srq-1')
    expect(page.store.getState().confirmations[0]?.dismissed).toBe(false)
  })

  const withdrawals: { reason: string; from: 'waiting' | 'received'; phase: unknown; dismissed: boolean }[] = [
    { reason: 'timeout', from: 'waiting', phase: { kind: 'ended', end: { kind: 'timed_out' } }, dismissed: true },
    {
      reason: 'resolved',
      from: 'waiting',
      phase: { kind: 'ended', end: { kind: 'answered_elsewhere' } },
      dismissed: true
    },
    {
      reason: 'cancelled',
      from: 'waiting',
      phase: { kind: 'ended', end: { kind: 'withdrawn', reason: 'cancelled' } },
      dismissed: true
    },
    {
      reason: 'too_many_attempts',
      from: 'waiting',
      phase: { kind: 'ended', end: { kind: 'too_many_attempts' } },
      dismissed: false
    },
    { reason: 'resolved', from: 'received', phase: { kind: 'received' }, dismissed: false },
    { reason: 'timeout', from: 'received', phase: { kind: 'received' }, dismissed: false },
    {
      reason: 'verification_failed',
      from: 'received',
      phase: { kind: 'ended', end: { kind: 'verification_failed' } },
      dismissed: false
    }
  ]

  for (const withdrawal of withdrawals) {
    it(`request.cancel ${withdrawal.reason} while ${withdrawal.from}`, async () => {
      const page = setUp()

      page.deliver('srq-1', frame())

      if (withdrawal.from === 'received') {
        // Through the decline path's twin: an answer that went through, then the sheet closed.
        page.store.setState(state => ({
          confirmations: state.confirmations.map(entry => ({ ...entry, phase: { kind: 'received' }, dismissed: true }))
        }))
      }

      page.emit('request.cancel', { id: 'srq-1', method: 'confirm', reason: withdrawal.reason })

      expect(page.store.getState().confirmations[0]).toMatchObject({
        phase: withdrawal.phase,
        ...(withdrawal.phase && (withdrawal.phase as { kind: string }).kind === 'received'
          ? {}
          : { dismissed: withdrawal.dismissed })
      })
    })
  }
})

describe('an answer that may have arrived', () => {
  /** The browser's sheet hands back an assertion at once (what it holds does not matter to a hand gateway). */
  function signs(page: ReturnType<typeof setUp>): void {
    const held = page.model as unknown as { options: { webauthn: { get: (...args: unknown[]) => unknown } } }

    vi.spyOn(held.options.webauthn, 'get').mockResolvedValue({
      credentialId: new Uint8Array([1, 2, 3]),
      authenticatorData: new Uint8Array(37),
      clientDataJSON: new Uint8Array([123, 125]),
      signature: new Uint8Array([48, 6]),
      userHandle: null
    })
  }

  const UNKNOWN = { kind: 'ended', end: { kind: 'outcome_unknown' } }

  /** A confirmation whose passkey answer got no reply: the socket closed under it. */
  async function lost(): Promise<ReturnType<typeof setUp>> {
    const page = setUp()

    signs(page)
    page.deliver('srq-1', frame())
    page.answer.mockRejectedValueOnce(new Error('gateway not connected'))
    await page.model.confirm('srq-1')

    return page
  }

  const entry = (page: ReturnType<typeof setUp>) => page.store.getState().confirmations[0]

  it('tells a transport failure from the gateway’s word', () => {
    expect(isTransportFailure(new Error('request timed out after 30s: request.answer'))).toBe(true)
    expect(isTransportFailure(new JsonRpcGatewayError('closed'))).toBe(true)
    expect(isTransportFailure(new JsonRpcGatewayError('unknown request', { code: 4004 }))).toBe(false)
    expect(isTransportFailure(new JsonRpcGatewayError('answer refused', { code: 4034 }))).toBe(false)
  })

  it('is marked after a passkey answer got no reply, and stays open to try again', async () => {
    const page = await lost()

    expect(page.answer).toHaveBeenCalledWith('request.answer', expect.objectContaining({ id: 'srq-1' }))
    expect(entry(page)).toMatchObject({
      phase: { kind: 'not_sent', message: 'gateway not connected' },
      answerMayHaveArrived: true,
      dismissed: false
    })
  })

  it('is not marked by a decline that got no reply, nor by an answer the gateway refused', async () => {
    const declined = setUp()

    declined.deliver('srq-1', frame())
    declined.answer.mockRejectedValueOnce(new Error('gateway not connected'))
    await declined.model.decline('srq-1')
    expect(entry(declined)).toMatchObject({ phase: { kind: 'not_sent' }, answerMayHaveArrived: false })

    const refused = setUp()

    signs(refused)
    refused.deliver('srq-1', frame())
    refused.answer.mockRejectedValueOnce(
      new JsonRpcGatewayError('answer refused', { code: 4034, data: { reason: 'signature_invalid' } })
    )
    await refused.model.confirm('srq-1')
    expect(entry(refused)).toMatchObject({
      phase: { kind: 'refused', reason: 'signature_invalid' },
      answerMayHaveArrived: false
    })
  })

  it('ends outcome-unknown, not timed out, at its deadline on the page’s clock', async () => {
    const page = await lost()

    page.clock.now = NOW + 120
    expect(page.model.expire('srq-1')).toBe(true)
    // On screen: the person must read it.
    expect(entry(page)).toMatchObject({ phase: UNKNOWN, dismissed: false })
  })

  it('ends outcome-unknown, not timed out, when a confirm or a decline comes after the deadline', async () => {
    for (const act of ['confirm', 'decline'] as const) {
      const page = await lost()

      page.clock.now = NOW + 121
      await page.model[act]('srq-1')
      expect(entry(page), act).toMatchObject({ phase: UNKNOWN, dismissed: false })
    }
  })

  it('ends outcome-unknown when a Decline is answered “not found” or “expired”', async () => {
    const notFound = await lost()

    notFound.answer.mockRejectedValueOnce(new JsonRpcGatewayError('request not found', { code: 4004 }))
    await notFound.model.decline('srq-1')
    expect(notFound.answer).toHaveBeenLastCalledWith('request.answer', { id: 'srq-1', result: DECLINE })
    expect(entry(notFound)).toMatchObject({ phase: UNKNOWN, dismissed: false })

    const expired = await lost()

    expired.answer.mockResolvedValueOnce({ status: 'expired' })
    await expired.model.decline('srq-1')
    expect(entry(expired)).toMatchObject({ phase: UNKNOWN, dismissed: false })
  })

  it('ends outcome-unknown when a retry is answered “expired”', async () => {
    const page = await lost()

    page.answer.mockResolvedValueOnce({ status: 'expired' })
    await page.model.confirm('srq-1')
    expect(entry(page)).toMatchObject({ phase: UNKNOWN, dismissed: false })
  })

  it('is received when a retry is answered ok, and declined when a Decline is (the request was still open)', async () => {
    const retried = await lost()

    await retried.model.confirm('srq-1')
    expect(entry(retried)?.phase).toEqual({ kind: 'received' })

    const declined = await lost()

    await declined.model.decline('srq-1')
    expect(entry(declined)).toMatchObject({ phase: { kind: 'declined' }, dismissed: true })
  })

  it('keeps saying it may have arrived when a retry gets no reply either', async () => {
    const page = await lost()

    page.answer.mockRejectedValueOnce(new Error('request timed out after 30s: request.answer'))
    await page.model.decline('srq-1')
    expect(entry(page)).toMatchObject({ phase: { kind: 'not_sent' }, answerMayHaveArrived: true })
  })

  const cancels: { reason: string; phase: unknown; dismissed: boolean }[] = [
    { reason: 'resolved', phase: UNKNOWN, dismissed: false },
    { reason: 'timeout', phase: UNKNOWN, dismissed: false },
    { reason: 'cancelled', phase: UNKNOWN, dismissed: false },
    { reason: 'verification_failed', phase: { kind: 'ended', end: { kind: 'verification_failed' } }, dismissed: false },
    { reason: 'too_many_attempts', phase: { kind: 'ended', end: { kind: 'too_many_attempts' } }, dismissed: false }
  ]

  for (const cancel of cancels) {
    it(`request.cancel ${cancel.reason} after it may have arrived`, async () => {
      const page = await lost()

      page.emit('request.cancel', { id: 'srq-1', method: 'confirm', reason: cancel.reason })
      expect(entry(page)).toMatchObject({ phase: cancel.phase, dismissed: cancel.dismissed })
    })
  }

  it('ends outcome-unknown when a read of the open requests no longer lists it', async () => {
    const page = await lost()
    const internals = page.model as unknown as { withdrawn(id: string, reason: string): void }

    // What `readOpenRequests` does for a request the gateway no longer lists.
    internals.withdrawn('srq-1', 'timeout')
    expect(entry(page)).toMatchObject({ phase: UNKNOWN, dismissed: false })
  })

  it('keeps a 4033 on a retry as not allowed', async () => {
    const page = await lost()

    page.answer.mockRejectedValueOnce(new JsonRpcGatewayError('not allowed', { code: 4033 }))
    await page.model.confirm('srq-1')
    expect(entry(page)?.phase).toEqual({ kind: 'ended', end: { kind: 'not_allowed' } })
  })
})

describe('the page’s clock ends a confirmation', () => {
  it('ends an expired one as timed out in confirm and decline, with no ceremony and no answer', async () => {
    for (const act of ['confirm', 'decline'] as const) {
      const page = setUp()
      const held = page.model as unknown as { options: { webauthn: { get: (...args: unknown[]) => unknown } } }
      const get = vi.spyOn(held.options.webauthn, 'get')

      page.deliver('srq-1', frame())
      // The deadline (NOW + 120 s) passed while no socket told us.
      page.clock.now = NOW + 121
      await page.model[act]('srq-1')

      expect(page.store.getState().confirmations[0], act).toMatchObject({
        phase: { kind: 'ended', end: { kind: 'timed_out' } },
        dismissed: true
      })
      expect(get, act).not.toHaveBeenCalled()
      expect(page.answer, act).not.toHaveBeenCalled()
    }
  })

  it('ends it exactly at its deadline, and leaves a later one and an answered one alone', () => {
    const page = setUp()

    page.deliver('srq-1', frame())
    page.deliver('srq-3', frame())
    // Arrived 10 s later: its deadline is NOW + 130.
    page.clock.now = NOW + 10
    page.deliver('srq-2', frame({}, { expires_at: NOW + 200 }))
    page.store.setState(state => ({
      confirmations: state.confirmations.map(entry =>
        entry.id === 'srq-3' ? { ...entry, phase: { kind: 'received' } } : entry
      )
    }))

    page.clock.now = NOW + 119
    expect(page.model.expire('srq-1')).toBe(false)

    page.clock.now = NOW + 120
    expect(page.model.expire('srq-1')).toBe(true)
    expect(page.model.expire('srq-2')).toBe(false)
    // An answer that went through is the gateway's to settle.
    expect(page.model.expire('srq-3')).toBe(false)
    expect(page.model.expire('missing')).toBe(false)
    expect(Object.fromEntries(page.store.getState().confirmations.map(entry => [entry.id, entry.phase.kind]))).toEqual({
      'srq-1': 'ended',
      'srq-2': 'waiting',
      'srq-3': 'received'
    })
  })

  it('keeps a confirmation open at most 120 seconds after it arrived, whatever expires_at says', () => {
    const page = setUp()

    page.deliver('srq-1', frame({}, { expires_at: NOW + 86_400 }))

    expect(page.store.getState().confirmations[0]?.expiresAt).toBe(NOW + 120)
    page.clock.now = NOW + 120
    expect(page.model.expire('srq-1')).toBe(true)
  })

  it('ends a ceremony at its deadline before it cancels the browser’s sheet', () => {
    const page = setUp()
    const held = page.model as unknown as { options: { webauthn: { cancel: () => void } } }
    const phases: string[] = []

    vi.spyOn(held.options.webauthn, 'cancel').mockImplementation(() => {
      phases.push(page.store.getState().confirmations[0]?.phase.kind ?? '')
    })
    page.deliver('srq-1', frame())
    page.store.setState(state => ({
      confirmations: state.confirmations.map(entry => ({ ...entry, phase: { kind: 'signing' } }))
    }))

    page.clock.now = NOW + 120
    expect(page.model.expire('srq-1')).toBe(true)
    expect(phases).toEqual(['ended'])
  })

  it('does not let a late 4033 end a request for good: the frame again brings it back', async () => {
    const page = setUp()

    page.deliver('srq-1', frame())
    page.answer.mockRejectedValueOnce(new JsonRpcGatewayError('not allowed', { code: 4033 }))
    await page.model.decline('srq-1')

    expect(page.store.getState().confirmations[0]?.phase).toEqual({ kind: 'ended', end: { kind: 'not_allowed' } })

    // The second capabilities call was accepted; the gateway offers the request to this connection now.
    expect(page.deliver('srq-1', frame()).accepted).toBe(true)

    expect(page.store.getState().confirmations).toHaveLength(1)
    expect(page.store.getState().confirmations[0]).toMatchObject({ phase: { kind: 'waiting' }, dismissed: false })

    await page.model.decline('srq-1')
    expect(page.answer).toHaveBeenLastCalledWith('request.answer', { id: 'srq-1', result: DECLINE })
  })
})

const GATEWAY_STATUS = (overrides: Partial<PasskeyStatus> = {}): PasskeyStatus => ({
  v: 1,
  enabled: true,
  reason: '',
  gateway_id: GATEWAY_ID,
  user: { id: 'self-hosted:u1', handle: 'aGFuZGxl' },
  rp: { native: [], web: ['gw.example.test'] },
  base_urls: [BASE],
  user_invites: true,
  credentials: [],
  ...overrides
})

/** A page whose socket is up: `advertise()` runs the two capability calls against what `since` answers. */
function advertising(
  options: {
    status?: PasskeyStatus
    since?: (sessionId: string) => unknown
    offerId?: string
    sessions?: OpenSession[]
    watch?: (listener: () => void) => () => void
  } = {}
) {
  const sessions: OpenSession[] = options.sessions ?? [{ sessionId: 'sess-1', lastSeen: 0 }]
  const page = setUp({
    sessions,
    ...(options.watch ? { watch: options.watch } : {}),
    client: { status: vi.fn(async () => options.status ?? GATEWAY_STATUS()) }
  })

  page.answer.mockImplementation(async (method: string, params: unknown) => {
    if (method === 'client.capabilities') {
      return (params as { confirm?: string[] }).confirm
        ? { confirm: ['passkey'] }
        : {
            confirm: [],
            confirm_passkey: {
              v: 1,
              enabled: true,
              reason: '',
              gateway_id: options.offerId ?? GATEWAY_ID,
              rp: { native: [], web: ['gw.example.test'] }
            }
          }
    }

    if (method === 'session.events.since') {
      return options.since ? options.since((params as { session_id: string }).session_id) : { open_requests: [] }
    }

    return { status: 'ok' }
  })

  return page
}

const callsTo = (page: ReturnType<typeof setUp>, method: string): unknown[] =>
  page.answer.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

describe('the base URL the gateway lists', () => {
  it('advertises when the gateway lists this page’s address', async () => {
    const page = advertising()

    await page.model.advertise()

    expect(page.store.getState().capability).toEqual({ verdict: { kind: 'advertised' }, accepted: ['passkey'] })
    expect(callsTo(page, 'client.capabilities')).toHaveLength(2)
  })

  it('does not advertise when it does not, and says so (every answer would be refused)', async () => {
    const page = advertising({ status: GATEWAY_STATUS({ base_urls: ['https://elsewhere.example.test'] }) })

    await page.model.advertise()

    expect(page.store.getState().capability).toEqual({ verdict: { kind: 'base_url_not_listed' }, accepted: [] })
    expect(page.store.getState().notices.map(notice => notice.notice)).toEqual([{ kind: 'base_url_not_listed' }])
    // Only the first call: nothing was offered.
    expect(callsTo(page, 'client.capabilities')).toHaveLength(1)
  })

  it('goes by the serialised form of the listed addresses, and by nothing when the gateway lists none', async () => {
    const same = advertising({ status: GATEWAY_STATUS({ base_urls: ['HTTPS://GW.EXAMPLE.TEST:443/'] }) })

    await same.model.advertise()
    expect(same.store.getState().capability?.verdict).toEqual({ kind: 'advertised' })

    const silent = advertising({ status: GATEWAY_STATUS({ base_urls: undefined }) })

    await silent.model.advertise()
    expect(silent.store.getState().capability?.verdict).toEqual({ kind: 'advertised' })
  })
})

describe('reading the open requests again', () => {
  it('ends a confirmation of a session just read that the gateway no longer lists', async () => {
    const page = advertising()

    page.deliver('srq-1', frame())
    await page.model.advertise()

    expect(page.store.getState().confirmations[0]).toMatchObject({
      phase: { kind: 'ended', end: { kind: 'timed_out' } },
      dismissed: true
    })
  })

  it('keeps one the gateway still lists, one of another session, and one it said nothing about', async () => {
    const listed = advertising({ since: () => ({ open_requests: [{ id: 'srq-1', method: 'confirm', params: {} }] }) })

    listed.deliver('srq-1', frame())
    listed.deliver('srq-2', frame({ session_id: 'sess-other' }))
    await listed.model.advertise()
    expect(listed.store.getState().confirmations.map(entry => entry.phase.kind)).toEqual(['waiting', 'waiting'])

    const unlisted = advertising({ since: () => ({ events: [] }) })

    unlisted.deliver('srq-1', frame())
    await unlisted.model.advertise()
    expect(unlisted.store.getState().confirmations[0]?.phase.kind).toBe('waiting')

    const answered = advertising()

    answered.deliver('srq-1', frame())
    answered.store.setState(state => ({
      confirmations: state.confirmations.map(entry => ({ ...entry, phase: { kind: 'received' } }))
    }))
    await answered.model.advertise()
    expect(answered.store.getState().confirmations[0]?.phase.kind).toBe('received')
  })

  it('reads a session the page starts holding after the level was accepted, once, and not before', async () => {
    const held: OpenSession[] = []
    let changed = (): void => undefined
    const page = advertising({
      sessions: held,
      watch: listener => {
        changed = listener

        return () => undefined
      }
    })

    // Not accepted yet: a change of the sessions reads nothing.
    held.push({ sessionId: 'sess-0', lastSeen: 0 })
    changed()
    expect(callsTo(page, 'session.events.since')).toEqual([])

    // Accepted while no chat of the page held a session (its resume answer was hidden, and the chat had
    // not taken it in yet).
    held.length = 0
    await page.model.advertise()
    expect(callsTo(page, 'session.events.since')).toEqual([])

    page.deliver('srq-1', frame())
    held.push({ sessionId: 'sess-1', lastSeen: 7 })
    changed()
    changed()
    await vi.waitFor(() => expect(callsTo(page, 'session.events.since')).toHaveLength(1))

    // Read once, with what the page had seen of it; the gateway's list is empty, so the confirmation is over.
    expect(callsTo(page, 'session.events.since')).toEqual([{ session_id: 'sess-1', last_seen: 7 }])
    await vi.waitFor(() => expect(page.store.getState().confirmations[0]?.phase.kind).toBe('ended'))
  })

  it('leaves what arrives while it reads alone', async () => {
    const page = advertising({
      since: () => {
        // A frame that came after the gateway's list was made.
        page.deliver('srq-new', frame())

        return { open_requests: [] }
      }
    })

    await page.model.advertise()

    expect(page.store.getState().confirmations.map(entry => [entry.id, entry.phase.kind])).toEqual([
      ['srq-new', 'waiting']
    ])
  })
})

describe('a status read that breaks the pin', () => {
  it('keeps nothing of it, so the settings page lists no other gateway’s passkeys', async () => {
    const page = setUp({
      pinned: 'ZmZmZmZmZmZmZmZmZmZmZg',
      client: {
        status: vi.fn(async () =>
          GATEWAY_STATUS({ credentials: [{ id: 'b3RoZXI', name: 'Somebody else’s', rp_id: 'gw.example.test' }] })
        )
      }
    })

    page.store.setState({ status: GATEWAY_STATUS(), credentials: GATEWAY_STATUS().credentials })
    await page.model.refresh()

    expect(page.store.getState()).toMatchObject({ status: null, credentials: [] })
    expect(page.store.getState().notices.map(notice => notice.notice)).toEqual([{ kind: 'gateway_id_mismatch' }])
    expect(page.pins.seen().ids).toEqual([])
  })
})

describe('forgetting the pin', () => {
  it('clears this gateway’s pin and its mismatch notice, and nothing else', () => {
    const page = setUp({ pinned: 'ZmZmZmZmZmZmZmZmZmZmZg', foreign: 'AAAAAAAAAAAAAAAAAAAAAA' })

    page.pins.remember(['a'])
    page.store.setState({
      pinned: true,
      notices: [
        { id: 1, notice: { kind: 'gateway_id_mismatch' }, at: 0 },
        { id: 2, notice: { kind: 'gateway_id_conflict' }, at: 0 }
      ]
    })
    page.model.forgetPin()

    expect(page.pins.gatewayId()).toBeNull()
    expect(page.pins.seen().ids).toEqual(['a'])
    expect(page.pins.foreignGatewayIds().has('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true)
    expect(page.store.getState().pinned).toBe(false)
    expect(page.store.getState().notices.map(notice => notice.notice.kind)).toEqual(['gateway_id_conflict'])
  })

  it('is what makes a reset gateway acceptable again: the capability calls run once more', async () => {
    const page = advertising({ offerId: 'ZmZmZmZmZmZmZmZmZmZmZg' })

    page.pins.pin(GATEWAY_ID)
    await page.model.advertise()
    expect(page.store.getState().capability?.verdict).toEqual({ kind: 'gateway_id_mismatch' })

    page.pins.forget()
    await page.model.advertise()
    expect(page.store.getState().capability?.verdict).toEqual({ kind: 'advertised' })
  })
})

describe('the passkey’s name', () => {
  it('is “Hermie — <host>” while it fits', () => {
    expect(credentialName('Hermie', 'gw.example.test')).toBe('Hermie — gw.example.test')
  })

  it('is cut to the gateway’s limit by shortening the host in the middle', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.test`
    const name = credentialName('Hermie', host)

    expect(Array.from(name)).toHaveLength(CREDENTIAL_NAME_LIMIT)
    expect(name.startsWith('Hermie — aaaa')).toBe(true)
    expect(name.endsWith('.example.test')).toBe(true)
    expect(name).toContain('…')
  })

  it('is what enrolment sends for such a host', async () => {
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.example.test`
    const base = `https://${long}`
    const hand = handGateway()
    const sent: string[] = []
    const storage = memoryStorage()
    const model = new PasskeyModel({
      gateway: hand.gateway,
      client: {
        status: async () => GATEWAY_STATUS({ rp: { native: [], web: [long] }, base_urls: [base] }),
        registerBegin: async (body: { name: string }) => {
          sent.push(body.name)
          throw new Error('stop here')
        }
      } as unknown as PasskeyClient,
      webauthn: softWebAuthn(base),
      baseUrl: base,
      pins: createPasskeyPins({ store: createKeyValueStore({ namespace: '/', storage }), baseUrl: base, storage }),
      store: createPasskeysStore()
    })

    await expect(model.enrol('00000-00000-00000-00000')).rejects.toBeDefined()
    expect(sent).toHaveLength(1)
    expect(Array.from(sent[0] as string).length).toBeLessThanOrEqual(CREDENTIAL_NAME_LIMIT)
    expect(sent[0]).toContain('…')
  })
})
