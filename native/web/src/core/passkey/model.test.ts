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
import type { PasskeyClient } from './client'
import { DECLINE, type PasskeyGateway, PasskeyModel, phaseAfter } from './model'

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

function setUp(options: { baseUrl?: string; available?: boolean; pinned?: string; foreign?: string } = {}) {
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
  const failures: { id: string; code: number; data: Record<string, unknown> }[] = []
  const model = new PasskeyModel({
    gateway: hand.gateway,
    client: {} as PasskeyClient,
    webauthn: softWebAuthn(BASE, { available: options.available ?? true }),
    baseUrl: options.baseUrl ?? BASE,
    pins,
    store,
    failWithData: (request, code, _message, data) => void failures.push({ id: request.id, code, data })
  })

  model.start()

  return { ...hand, model, store, failures }
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
