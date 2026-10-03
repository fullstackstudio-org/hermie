/**
 * What the native bot settings screen reads and writes on one profile: the soul, the model pin and
 * the guard in front of it, and a refused write.
 *
 * The shapes are the gateway's own (`methods_profiles.py`): `profiles.describe` answers
 * `soul` and `model: {provider, default}`; `profiles.configure` writes `soul`, and pins a model
 * only when BOTH `model` and `provider` arrive. A guarded model writes nothing until
 * `confirm_expensive_model` is sent, and says so with `confirm_required` and its own words beside
 * the sections that did apply.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

async function withGateway<T>(run: (call: Call, baseUrl: string) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    try {
      return await run(callOn(socket), gateway.url)
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

function callOn(socket: WebSocket): Call {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as {
          id?: string
          result?: Record<string, unknown>
          error?: { code?: number; message?: string }
        }

        if (frame.id !== frameId) {
          return
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

          return
        }

        resolve(frame.result ?? {})
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })
}

describe('profiles.describe and profiles.configure: soul and model', () => {
  it('writes the soul as given and reads it back', async () => {
    await withGateway(async call => {
      expect((await call('profiles.describe', { name: 'researcher' })).soul).toBe('')

      const answer = await call('profiles.configure', { name: 'researcher', soul: '  You are terse.\n' })

      expect(answer).toMatchObject({ ok: true, applied: { soul: true } })
      expect((await call('profiles.describe', { name: 'researcher' })).soul).toBe('  You are terse.\n')
    })
  })

  it('pins a model when both halves arrive, and stores the bare model id', async () => {
    await withGateway(async call => {
      const answer = await call('profiles.configure', {
        name: 'researcher',
        model: 'second-provider/reasoner-2',
        provider: 'second-provider'
      })

      expect(answer).toMatchObject({ ok: true, applied: { model: true } })
      expect((await call('profiles.describe', { name: 'researcher' })).model).toEqual({
        provider: 'second-provider',
        default: 'reasoner-2'
      })
      // The roster row follows.
      const roster = (await call('profiles.list')) as { profiles: { name: string; model: string; provider: string }[] }
      expect(roster.profiles.find(row => row.name === 'researcher')).toMatchObject({
        model: 'reasoner-2',
        provider: 'second-provider'
      })
    })
  })

  it('pins nothing for a model without its provider', async () => {
    await withGateway(async call => {
      const before = (await call('profiles.describe', { name: 'researcher' })).model
      const answer = await call('profiles.configure', { name: 'researcher', model: 'reasoner-2' })

      expect(answer.applied).toEqual({})
      expect((await call('profiles.describe', { name: 'researcher' })).model).toEqual(before)
    })
  })

  it('writes nothing for a guarded model until it is confirmed, and still applies the rest', async () => {
    await withGateway(async call => {
      const before = (await call('profiles.describe', { name: 'researcher' })).model
      const asked = await call('profiles.configure', {
        name: 'researcher',
        description: 'Reads slowly.',
        model: 'example-provider/expensive-model',
        provider: 'example-provider'
      })

      expect(asked).toMatchObject({
        ok: true,
        applied: { description: true },
        confirm_required: true,
        confirm_message: expect.stringContaining('expensive') as unknown
      })
      expect(asked.applied).not.toHaveProperty('model')
      expect((await call('profiles.describe', { name: 'researcher' })).model).toEqual(before)

      const confirmed = await call('profiles.configure', {
        name: 'researcher',
        model: 'example-provider/expensive-model',
        provider: 'example-provider',
        confirm_expensive_model: true
      })

      expect(confirmed).toMatchObject({ ok: true, applied: { model: true } })
      expect(confirmed).not.toHaveProperty('confirm_required')
      expect(((await call('profiles.describe', { name: 'researcher' })).model as { default: string }).default).toBe(
        'expensive-model'
      )
    })
  })
})

describe('/__fake/deny', () => {
  it('refuses a method with the code it was given, and takes the refusal back', async () => {
    await withGateway(async (call, baseUrl) => {
      const post = (body: unknown) =>
        fetch(`${baseUrl}/__fake/deny`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })

      expect((await post({ methods: ['profiles.configure'], code: 4030, message: 'Read-only account.' })).status).toBe(
        200
      )

      await expect(call('profiles.configure', { name: 'researcher', soul: 'x' })).rejects.toMatchObject({
        code: 4030,
        message: 'Read-only account.'
      })
      // Reading is still fine.
      expect((await call('profiles.describe', { name: 'researcher' })).name).toBe('researcher')

      await post({ clear: true })
      expect(await call('profiles.configure', { name: 'researcher', soul: 'x' })).toMatchObject({ ok: true })
    })
  })
})
