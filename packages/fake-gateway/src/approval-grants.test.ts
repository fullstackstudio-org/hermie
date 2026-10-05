/**
 * `approval.grants` / `approval.revoke`, pinned against `tui_gateway/approval_grants.py`,
 * `methods_prompt.py` and `contracts/prompt_voice.py`: a standing list per profile, session grants per live
 * session, opaque ids that go stale quietly, and the refusals the contract names (4006, 4001, 4033, 4064, 4000).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

type RpcError = Error & { code?: number }
type Row = { id: string; kind: string; label: string; tirith?: boolean }
type Grants = {
  mode: string
  permanent: Row[]
  sessions: { session_id: string; session_key: string; yolo: boolean; grants: Row[] }[]
}

const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = `approval-${(nextId += 1)}`
    const onMessage = (data: unknown) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as {
          id?: string
          result?: Record<string, unknown>
          error?: { code?: number; message?: string }
        }

        if (frame.id !== id) {
          continue
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

          return
        }

        resolve(frame.result ?? {})
      }
    }

    socket.on('message', onMessage)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const refusal = async (method: string, params: Record<string, unknown>): Promise<RpcError> => {
  try {
    await call(method, params)
  } catch (error) {
    return error as RpcError
  }

  throw new Error(`${method} was not refused`)
}

const post = async (route: string, body: Record<string, unknown>): Promise<void> => {
  await fetch(`${gateway.url}${route}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
}

const stage = (body: Record<string, unknown>) => post('/__fake/approvals', body)
const grants = async (params: Record<string, unknown> = {}) =>
  (await call('approval.grants', params)) as unknown as Grants

/** A bot's chat: its runtime session id and stored id. */
const chatOf = async (profile: string): Promise<{ id: string; storedId: string }> => {
  const listed = await call('session.list', { profile, title: 'Bot Chat', include_hidden: true })
  const row = (listed.sessions as Record<string, unknown>[])[0] ?? {}
  const resumed = await call('session.resume', { session_id: String(row.id), omit_messages: true })

  return { id: String(resumed.session_id), storedId: String(row.id) }
}

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterAll(async () => {
  socket.close()
  await gateway.close()
})

beforeEach(async () => {
  await stage({ clear: true })
  await post('/__fake/deny', { clear: true })
})

describe('approval.grants', () => {
  it('is empty and manual until something is staged', async () => {
    expect(await grants({ profile: 'researcher' })).toEqual({ mode: 'manual', permanent: [], sessions: [] })
  })

  it('lists each profile’s own standing approvals with opaque ids and a label per row', async () => {
    await stage({
      mode: 'smart',
      permanent: [
        { kind: 'pattern', label: 'recursive delete; force delete', profile: 'researcher' },
        { kind: 'command', label: 'npm test', profile: 'researcher' },
        { kind: 'glob', label: 'git status *', profile: 'writer' }
      ]
    })

    const researcher = await grants({ profile: 'researcher' })
    const writer = await grants({ profile: 'writer' })

    expect(researcher.mode).toBe('smart')
    expect(researcher.permanent.map(row => row.label).sort()).toEqual(['force delete; recursive delete', 'npm test'])
    expect(researcher.permanent.every(row => /^perm:[0-9a-f]{16}$/.test(row.id))).toBe(true)
    expect(writer.permanent).toMatchObject([{ kind: 'glob', label: 'git status *' }])
    expect(writer.permanent[0]?.id).not.toBe(researcher.permanent[0]?.id)
  })

  it('lists the live sessions that hold a grant or YOLO, and only those', async () => {
    const researcher = await chatOf('researcher')
    await chatOf('writer')
    await stage({ session: [{ label: 'recursive delete', profile: 'researcher', tirith: true }] })

    const listed = await grants({ profile: 'researcher' })

    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({
      session_id: researcher.id,
      session_key: researcher.storedId,
      yolo: false
    })
    expect(listed.sessions[0]?.grants).toMatchObject([{ kind: 'pattern', label: 'recursive delete', tirith: true }])
    expect(listed.sessions[0]?.grants[0]?.id).toMatch(/^sess:[0-9a-f]{16}$/)
    expect((await grants({ profile: 'writer' })).sessions).toEqual([])

    const writer = await chatOf('writer')
    await call('config.set', { key: 'yolo', scope: 'session', session_id: writer.id, value: 'on' })

    expect((await grants({ profile: 'writer' })).sessions).toMatchObject([{ grants: [], yolo: true }])

    await call('config.set', { key: 'yolo', scope: 'session', session_id: writer.id, value: 'off' })
  })

  it('keeps the session the caller names even when it holds nothing', async () => {
    const writer = await chatOf('writer')

    expect((await grants({ session_id: writer.id })).sessions).toMatchObject([
      { grants: [], session_id: writer.id, yolo: false }
    ])
  })

  it('answers 4064 for a profile it does not serve and 4001 for a session it does not hold', async () => {
    expect((await refusal('approval.grants', { profile: 'nobody' })).code).toBe(4064)
    expect((await refusal('approval.grants', { session_id: 'no-such-session' })).code).toBe(4001)

    const writer = await chatOf('writer')

    expect((await refusal('approval.grants', { profile: 'researcher', session_id: writer.id })).code).toBe(4001)
  })

  it('refuses a key the contract does not name, and answers -32601 on a gateway without it', async () => {
    expect((await refusal('approval.grants', { everything: true })).code).toBe(4000)

    await stage({ unsupported: true })

    expect((await refusal('approval.grants', {})).code).toBe(-32601)
  })

  it('is refused with 4033 for an agent (staged through /__fake/deny)', async () => {
    await post('/__fake/deny', {
      code: 4033,
      message: 'an agent may not read the standing approvals',
      methods: ['approval.grants']
    })

    expect((await refusal('approval.grants', { profile: 'researcher' })).code).toBe(4033)
  })
})

describe('approval.revoke', () => {
  it('revokes one standing grant by id and leaves the profile’s others and other profiles’ alone', async () => {
    await stage({
      permanent: [
        { label: 'a rule', profile: 'researcher' },
        { label: 'another rule', profile: 'researcher' },
        { label: 'a rule', profile: 'writer' }
      ]
    })

    const [first] = (await grants({ profile: 'researcher' })).permanent

    expect(await call('approval.revoke', { id: first?.id, profile: 'researcher', scope: 'permanent' })).toEqual({
      revoked: 1
    })
    expect((await grants({ profile: 'researcher' })).permanent).toHaveLength(1)
    expect((await grants({ profile: 'writer' })).permanent).toHaveLength(1)
  })

  it('answers revoked 0, not an error, for an id that no longer names a grant', async () => {
    await stage({ permanent: [{ label: 'a rule', profile: 'researcher' }] })

    const [row] = (await grants({ profile: 'researcher' })).permanent
    const revoke = { id: row?.id, profile: 'researcher', scope: 'permanent' }

    expect(await call('approval.revoke', revoke)).toEqual({ revoked: 1 })
    expect(await call('approval.revoke', revoke)).toEqual({ revoked: 0 })
  })

  it('revokes every standing grant of the profile with all', async () => {
    await stage({
      permanent: [
        { label: 'one', profile: 'researcher' },
        { label: 'two', profile: 'researcher' },
        { label: 'one', profile: 'writer' }
      ]
    })

    expect(await call('approval.revoke', { all: true, profile: 'researcher', scope: 'permanent' })).toEqual({
      revoked: 2
    })
    expect((await grants({ profile: 'researcher' })).permanent).toEqual([])
    expect((await grants({ profile: 'writer' })).permanent).toHaveLength(1)
  })

  it('revokes a session grant, or all of the session’s, and not another session’s', async () => {
    const researcher = await chatOf('researcher')
    await chatOf('writer')
    await stage({
      session: [
        { label: 'rule one', profile: 'researcher' },
        { label: 'rule two', profile: 'researcher' },
        { label: 'rule one', profile: 'writer' }
      ]
    })

    const [first] = (await grants({ profile: 'researcher' })).sessions[0]?.grants ?? []

    expect(
      await call('approval.revoke', {
        id: first?.id,
        profile: 'researcher',
        scope: 'session',
        session_id: researcher.id
      })
    ).toEqual({ revoked: 1 })
    expect((await grants({ profile: 'researcher' })).sessions[0]?.grants).toHaveLength(1)
    expect(
      await call('approval.revoke', { all: true, profile: 'researcher', scope: 'session', session_id: researcher.id })
    ).toEqual({ revoked: 1 })
    expect((await grants({ profile: 'writer' })).sessions[0]?.grants).toHaveLength(1)
  })

  it('refuses what the contract refuses', async () => {
    const researcher = await chatOf('researcher')

    expect((await refusal('approval.revoke', { profile: 'researcher', scope: 'permanent' })).code).toBe(4006)
    expect(
      (await refusal('approval.revoke', { all: true, id: 'perm:x', profile: 'researcher', scope: 'permanent' })).code
    ).toBe(4006)
    expect((await refusal('approval.revoke', { all: true, profile: 'researcher', scope: 'everything' })).code).toBe(
      4006
    )
    expect((await refusal('approval.revoke', { all: true, profile: 'researcher', scope: 'session' })).code).toBe(4006)
    expect((await refusal('approval.revoke', { all: true, scope: 'session', session_id: 'gone' })).code).toBe(4001)
    expect((await refusal('approval.revoke', { all: true, profile: 'nobody', scope: 'permanent' })).code).toBe(4064)
    expect((await refusal('approval.revoke', { all: true, extra: 1, scope: 'permanent' })).code).toBe(4000)

    await post('/__fake/deny', { code: 4033, methods: ['approval.revoke'] })

    expect(
      (
        await refusal('approval.revoke', {
          all: true,
          profile: 'researcher',
          scope: 'session',
          session_id: researcher.id
        })
      ).code
    ).toBe(4033)
  })
})
