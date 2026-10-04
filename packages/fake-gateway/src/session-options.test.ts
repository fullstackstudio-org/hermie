/**
 * The options of one session the web client switches — reasoning effort, model, fast mode — and the
 * context reading it draws its meter from.
 *
 * `config.set` is session-scoped: it changes what that session's `info` and `session.usage` say, and it
 * publishes `session.info`, so every page learns the new state from the event. A model the gateway calls
 * expensive writes NOTHING until the second call carries `confirm_expensive_model` (`_set_model`). And the
 * usage a finished turn carries must hold the window's size beside the token counts, as `_get_usage`
 * writes it: a client that takes the turn's usage as the session's reading would otherwise lose the meter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

interface Event {
  type: string
  session_id?: string
  payload: Record<string, unknown>
}

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, (value: Record<string, unknown>) => void>()
const events: Event[] = []

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise(resolve => {
    pending.set(id, resolve)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function until(what: string, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error(`timed out waiting for ${what}`)
}

/** Resume the researcher's chat: its runtime session id. */
async function resume(): Promise<string> {
  const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
  const resumed = await call('session.resume', { session_id: stored, profile: 'researcher' })

  return String(resumed.session_id)
}

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
  events.length = 0
  nextId = 0
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Record<string, unknown>

      if (typeof frame.id === 'number' && pending.has(frame.id)) {
        pending.get(frame.id)?.((frame.result ?? {}) as Record<string, unknown>)
        pending.delete(frame.id)
      } else if (frame.method === 'event') {
        const params = frame.params as Record<string, unknown>

        events.push({
          type: String(params.type ?? ''),
          ...(typeof params.session_id === 'string' ? { session_id: params.session_id } : {}),
          payload: (params.payload ?? {}) as Record<string, unknown>
        })
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterEach(async () => {
  socket.close()
  pending.clear()
  await gateway.close()
})

describe('config.set reasoning, model and fast, scoped to the session', () => {
  it('starts on medium reasoning and the example model, and a switch shows in info and in a session.info event', async () => {
    const session = await resume()
    const before = (await call('config.get', { key: 'reasoning', session_id: session })) as { value?: string }

    // Nothing is stored until someone sets it: the session's info is what carries the default.
    expect(before.value).toBe('')

    const set = (await call('config.set', {
      key: 'reasoning',
      value: 'xhigh',
      session_id: session,
      profile: 'researcher',
      scope: 'session'
    })) as { info?: Record<string, unknown> }

    expect(set.info).toMatchObject({ reasoning_effort: 'xhigh' })
    expect(events.filter(event => event.type === 'session.info').at(-1)?.payload).toMatchObject({
      reasoning_effort: 'xhigh'
    })
    expect(((await call('config.get', { key: 'reasoning', session_id: session })) as { value?: string }).value).toBe(
      'xhigh'
    )
  })

  it('switches the model and lets the usage carry it', async () => {
    const session = await resume()
    const set = (await call('config.set', {
      key: 'model',
      value: 'second-provider/reasoner-2',
      session_id: session
    })) as { info?: Record<string, unknown>; confirm_required?: boolean }

    expect(set.confirm_required).toBeUndefined()
    expect(set.info).toMatchObject({ model: 'second-provider/reasoner-2' })
    expect((await call('session.usage', { session_id: session })).model).toBe('second-provider/reasoner-2')
  })

  it('asks before an expensive model, writes nothing for the asking, and switches on the confirmed call', async () => {
    const session = await resume()
    const asked = (await call('config.set', {
      key: 'model',
      value: 'example-provider/expensive-model',
      session_id: session
    })) as Record<string, unknown>

    expect(asked).toMatchObject({ confirm_required: true })
    expect(String(asked.confirm_message)).toContain('expensive')
    expect(asked.info).toBeUndefined()
    // Nothing moved: the session is still on the model it was on, and no event said otherwise.
    expect((await call('session.usage', { session_id: session })).model).toBe('example-provider/example-model')
    expect(events.some(event => event.type === 'session.info')).toBe(false)

    const confirmed = (await call('config.set', {
      key: 'model',
      value: 'example-provider/expensive-model',
      session_id: session,
      confirm_expensive_model: true
    })) as { info?: Record<string, unknown>; confirm_required?: boolean }

    expect(confirmed.confirm_required).toBeUndefined()
    expect(confirmed.info).toMatchObject({ model: 'example-provider/expensive-model' })
  })

  it('offers the inventory in the gateway’s own shape: providers with plain model ids', async () => {
    const options = (await call('model.options')) as { providers: { slug: string; models: string[] }[] }

    expect(options.providers.length).toBeGreaterThanOrEqual(3)
    expect(options.providers.flatMap(provider => provider.models).length).toBeGreaterThan(8)
    expect(options.providers[0]?.models.every(model => !model.includes('/'))).toBe(true)
  })

  it('stores fast mode in the gateway’s words and reports it as a boolean', async () => {
    const session = await resume()
    const on = (await call('config.set', { key: 'fast', value: 'fast', session_id: session })) as {
      info?: Record<string, unknown>
    }

    expect(on.info).toMatchObject({ fast: true })

    const off = (await call('config.set', { key: 'fast', value: 'normal', session_id: session })) as {
      info?: Record<string, unknown>
    }

    expect(off.info).toMatchObject({ fast: false })
  })
})

describe('the context reading after a turn', () => {
  it('rides on the finished turn’s usage, beside its token counts, and agrees with session.usage', async () => {
    const session = await resume()
    const before = await call('session.usage', { session_id: session })

    await call('prompt.submit', { session_id: session, profile: 'researcher', text: 'and a short one' })
    await until('the turn to finish', () => events.some(event => event.type === 'message.complete'))

    const usage = events.find(event => event.type === 'message.complete')?.payload.usage as Record<string, unknown>
    const after = await call('session.usage', { session_id: session })

    // The window's size is there, so the meter does not lose it when the turn ends.
    expect(usage.context_max).toBe(before.context_max)
    expect(usage.context_used).toBe(after.context_used)
    expect(Number(usage.context_used)).toBeGreaterThan(Number(before.context_used))
    // And the turn's own counts are what they were.
    expect(usage).toMatchObject({ input: 12, output: 34, total: 46 })
  })
})
