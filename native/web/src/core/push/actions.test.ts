/**
 * What a click may do, as a table: a payload and what the gateway says is open,
 * in; open the conversation, or answer one request with one choice, out.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  conversationIdOf,
  LEGACY_PUSH_ACTION_ALLOW,
  PUSH_ACTION_ALLOW,
  PUSH_ACTION_DENY,
  PUSH_LAUNCH_PARAM,
  PUSH_MESSAGE_SOURCE,
  type PendingAnswer,
  pushTapOf,
  resolvePushTap,
  responseOfMessage,
  takeLaunchResponse
} from './actions'

/** The contract's approval example, seen through a hook that knew the runtime session. */
const APPROVAL = {
  v: 1,
  type: 'request',
  bot: 'scout',
  at: 1_790_000_000,
  eventId: 'request:e73f568f3575f6b525d031267d258a0b',
  sessionId: '8a1b2c3d',
  sessionKey: '20261003_101500_a1b2c3',
  sessionKind: 'canonical',
  gatewayKey: 'bf796761db84e312',
  method: 'approval',
  requestId: 'appr-1'
}

const OPEN: PendingAnswer = {
  sessionId: '8a1b2c3d',
  approvals: [{ request_id: 'appr-1', choices: ['once', 'session', 'always', 'deny'] }]
}

const tap = (actionIdentifier: string, data: Record<string, unknown> = APPROVAL) => {
  const read = pushTapOf({ actionIdentifier, data })

  if (!read) {
    throw new Error('expected a tap')
  }

  return read
}

describe('pushTapOf', () => {
  it('reads the contract’s approval', () => {
    expect(tap(PUSH_ACTION_ALLOW)).toEqual({
      bot: 'scout',
      action: 'allow',
      requestId: 'appr-1',
      sessionId: '8a1b2c3d',
      sessionKey: '20261003_101500_a1b2c3',
      sessionKind: 'canonical',
      type: 'request',
      method: 'approval',
      isClear: false
    })
  })

  it('names the conversation of a request by its stored id, of anything else by its session', () => {
    expect(conversationIdOf(tap('default'))).toBe('20261003_101500_a1b2c3')
    expect(conversationIdOf(tap('default', { bot: 'scout', type: 'turn_done', sessionId: 'stored' }))).toBe('stored')
  })

  it('reads nothing without a bot it could open', () => {
    for (const bot of ['', '   ', 'a/b', 'line\nbreak', 'x'.repeat(300), 42]) {
      expect(pushTapOf({ actionIdentifier: 'default', data: { bot } })).toBeNull()
    }
  })

  it('reads a button with nothing to answer as a plain open', () => {
    // No request id, a clarify, a confirmation, a clearing push.
    expect(tap(PUSH_ACTION_ALLOW, { ...APPROVAL, requestId: undefined }).action).toBe('open')
    expect(tap(PUSH_ACTION_ALLOW, { ...APPROVAL, method: 'clarify' }).action).toBe('open')
    expect(tap(PUSH_ACTION_DENY, { ...APPROVAL, method: 'confirm', level: 'plain' }).action).toBe('open')
    expect(tap(PUSH_ACTION_ALLOW, { ...APPROVAL, clear: true }).action).toBe('open')
  })

  it('reads the ids an older worker posted', () => {
    expect(tap(LEGACY_PUSH_ACTION_ALLOW).action).toBe('allow')
    expect(tap('deny').action).toBe('deny')
    expect(tap(PUSH_ACTION_ALLOW, { ...APPROVAL, requestId: undefined, request: 'appr-1' }).requestId).toBe('appr-1')
  })

  it('reads a kind this build does not know as none', () => {
    expect(tap('default', { ...APPROVAL, sessionKind: 'elsewhere' }).sessionKind).toBe('')
  })
})

describe('resolvePushTap', () => {
  it('answers Allow with `once` when the gateway still lists the request in that session', () => {
    expect(resolvePushTap(tap(PUSH_ACTION_ALLOW), OPEN)).toEqual({
      kind: 'respond',
      requestId: 'appr-1',
      choice: 'once'
    })
  })

  it('answers Deny with `deny`', () => {
    expect(resolvePushTap(tap(PUSH_ACTION_DENY), OPEN)).toEqual({
      kind: 'respond',
      requestId: 'appr-1',
      choice: 'deny'
    })
  })

  it('answers a payload that names no runtime session against the chat’s own', () => {
    const { sessionId: _ignored, ...withoutSession } = APPROVAL

    expect(resolvePushTap(tap(PUSH_ACTION_ALLOW, withoutSession), OPEN).kind).toBe('respond')
  })

  it.each([
    ['a plain click', tap('default'), OPEN],
    ['a request no longer open (answered elsewhere)', tap(PUSH_ACTION_ALLOW), { ...OPEN, approvals: [] }],
    [
      'another request open in its place',
      tap(PUSH_ACTION_ALLOW),
      { ...OPEN, approvals: [{ request_id: 'appr-2', choices: ['once', 'deny'] }] }
    ],
    ['the same id in another session', tap(PUSH_ACTION_ALLOW), { ...OPEN, sessionId: 'ffff0000' }],
    ['a chat not attached to any session', tap(PUSH_ACTION_ALLOW), { ...OPEN, sessionId: '' }],
    [
      'a request that does not offer `once`',
      tap(PUSH_ACTION_ALLOW),
      { ...OPEN, approvals: [{ request_id: 'appr-1', choices: ['session', 'always', 'deny'] }] }
    ],
    ['a branch', tap(PUSH_ACTION_ALLOW, { ...APPROVAL, sessionKind: 'branch' }), OPEN],
    ['another conversation', tap(PUSH_ACTION_DENY, { ...APPROVAL, sessionKind: 'other' }), OPEN],
    ['a secure input', tap(PUSH_ACTION_ALLOW, { ...APPROVAL, method: 'secret' }), OPEN]
  ] as const)('opens the conversation and answers nothing for %s', (_label, read, pending) => {
    expect(resolvePushTap(read, pending)).toEqual({ kind: 'open' })
  })
})

describe('the two ways a click arrives', () => {
  it('reads a message the worker posted, and nothing else', () => {
    expect(
      responseOfMessage({
        source: PUSH_MESSAGE_SOURCE,
        response: { actionIdentifier: PUSH_ACTION_ALLOW, data: APPROVAL }
      })
    ).toEqual({ actionIdentifier: PUSH_ACTION_ALLOW, data: APPROVAL })
    expect(responseOfMessage({ source: 'someone-else', response: {} })).toBeNull()
    expect(responseOfMessage('hello')).toBeNull()
  })

  it('takes the launch click out of the address before it is read, once', () => {
    const response = { actionIdentifier: 'default', data: { bot: 'scout' } }
    const location = {
      href: `https://gw.example.test/dashboard-plugins/hermie/app/index.html?${PUSH_LAUNCH_PARAM}=${encodeURIComponent(JSON.stringify(response))}#/`
    }
    const history = {
      state: { keep: true },
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        location.href = new URL(url, location.href).href
      })
    }

    expect(takeLaunchResponse(location, history)).toEqual(response)
    expect(history.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/dashboard-plugins/hermie/app/index.html#/')
    expect(takeLaunchResponse(location, history)).toBeNull()
  })

  it('removes an unreadable launch click too, and acts on nothing', () => {
    const location = { href: `https://gw.example.test/app/index.html?${PUSH_LAUNCH_PARAM}=%7Bnot-json&x=1` }
    const history = { state: null, replaceState: vi.fn() }

    expect(takeLaunchResponse(location, history)).toBeNull()
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/app/index.html?x=1')
  })
})
