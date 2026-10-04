/**
 * The interactive server requests on the fake gateway, against `contract/requests`.
 *
 * Two halves. The first runs every example of `examples.json` through the validators: a valid answer is
 * taken, an invalid one is refused with exactly its `reason` (the layer `model` ones as `bad_shape`, the
 * layer `validator` ones as the reason they carry), and every field kind's valid and invalid values behave
 * as written. The second is the request's life over a real WebSocket: who is sent it, what a refused answer
 * does, the cap, the clock, what a resume lists, and what the upload route received.
 */
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'
import {
  defaultParams,
  INTERACTIVE_METHODS,
  isUnder,
  loadContract,
  matches,
  matchesParams,
  matchesResult,
  refusalFor,
  resolveLexically,
  stripLineEnds,
  type InteractiveMethod
} from './interactive'
import { MAX_REFUSALS } from './interactive-gate'

type Obj = Record<string, unknown>

const contract = loadContract()
const methods = contract.examples.methods as Record<InteractiveMethod, Obj>

/** Every example frame's params by request id: what its answers are checked against. */
const paramsById = new Map<string, Obj>()

for (const method of INTERACTIVE_METHODS) {
  for (const frame of methods[method]!.frames as Obj[]) {
    paramsById.set(String(frame.id), frame.params as Obj)
  }
}

describe('the schema checker', () => {
  const root: Obj = { $defs: { Id: { type: 'string', pattern: '^[a-z]+$', maxLength: 3 } } }

  it('follows $ref, pattern and code-point lengths', () => {
    expect(matches(root, { $ref: '#/$defs/Id' }, 'abc')).toBe(true)
    expect(matches(root, { $ref: '#/$defs/Id' }, 'abcd')).toBe(false)
    expect(matches(root, { $ref: '#/$defs/Id' }, 'ab1')).toBe(false)
    expect(matches(root, { type: 'string', maxLength: 1 }, '😀')).toBe(true)
  })

  it('tells integers from numbers, and booleans from both', () => {
    expect(matches(root, { type: 'integer' }, 2)).toBe(true)
    expect(matches(root, { type: 'integer' }, 2.5)).toBe(false)
    expect(matches(root, { type: 'number' }, true)).toBe(false)
    expect(matches(root, { type: 'integer', minimum: 1, maximum: 3 }, 4)).toBe(false)
  })

  it('takes oneOf only when exactly one option matches, and anyOf when any does', () => {
    expect(matches(root, { oneOf: [{ type: 'string' }, { type: 'integer' }] }, 1)).toBe(true)
    expect(matches(root, { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1)).toBe(false)
    expect(matches(root, { anyOf: [{ type: 'null' }, { type: 'string' }] }, null)).toBe(true)
  })

  it('refuses extra keys when additionalProperties is false, and checks the ones it is given a schema for', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      required: ['a'],
      additionalProperties: false
    }

    expect(matches(root, schema, { a: 1 })).toBe(true)
    expect(matches(root, schema, { a: 1, b: 2 })).toBe(false)
    expect(matches(root, schema, {})).toBe(false)
    expect(matches(root, { type: 'object', additionalProperties: { type: 'string' } }, { x: 1 })).toBe(false)
    expect(matches(root, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, ['a'])).toBe(true)
    expect(matches(root, { type: 'array', minItems: 1 }, [])).toBe(false)
  })
})

describe('the contract examples', () => {
  for (const method of INTERACTIVE_METHODS) {
    const entry = methods[method]!

    describe(method, () => {
      it('every frame matches the params schema', () => {
        for (const frame of entry.frames as Obj[]) {
          expect(matchesParams(method, frame.params), String(frame.id)).toBe(true)
        }
      })

      it('every invalid frame fails the schema exactly when its layer is `model`', () => {
        for (const invalid of entry.invalid_frames as Obj[]) {
          expect(matchesParams(method, invalid.params), String(invalid.name)).toBe(invalid.layer !== 'model')
        }
      })

      it('takes every valid answer', () => {
        for (const answer of entry.answers as Obj[]) {
          const params = paramsById.get(String(answer.request)) as Obj

          expect(matchesResult(method, answer.result), String(answer.name)).toBe(true)
          expect(refusalFor(method, params, answer.result), String(answer.name)).toBeNull()
        }
      })

      it('refuses every invalid answer with exactly its reason', () => {
        for (const answer of entry.invalid_answers as Obj[]) {
          const params = paramsById.get(String(answer.request)) as Obj

          expect(refusalFor(method, params, answer.result), String(answer.name)).toBe(answer.reason)
          // The layer says where it is caught: `model` fails the schema, `validator` passes it.
          expect(matchesResult(method, answer.result), String(answer.name)).toBe(answer.layer !== 'model')
        }
      })
    })
  }

  it('takes the valid and refuses the invalid value of every form field kind, as the examples say', () => {
    let checked = 0

    for (const example of contract.examples.form_fields as Obj[]) {
      const field = example.field as Obj
      const params = { session_id: 's_example', ...defaultParams('input.form', 0), fields: [field] }
      const answer = (value: unknown) => ({ status: 'answered', values: { [String(field.id)]: value } })

      expect(matchesParams('input.form', params), String(example.name)).toBe(true)

      for (const value of example.valid as unknown[]) {
        expect(
          refusalFor('input.form', params, answer(value)),
          `${String(example.name)}: ${JSON.stringify(value)}`
        ).toBeNull()
        checked += 1
      }

      for (const invalid of example.invalid as Obj[]) {
        expect(
          refusalFor('input.form', params, answer(invalid.value)),
          `${String(example.name)}: ${JSON.stringify(invalid.value)}`
        ).toBe(invalid.reason)
        checked += 1
      }
    }

    expect(checked).toBeGreaterThan(60)
  })
})

describe('the rules the schema cannot say', () => {
  const form = (fields: Obj[], optional = true) => ({ ...defaultParams('input.form', 0), optional, fields })
  const values = (map: Obj) => ({ status: 'answered', values: map })

  it('checks a values key before any field, and the fields in their order', () => {
    const params = form([
      { id: 'a', kind: 'toggle', label: 'A', required: true },
      { id: 'b', kind: 'toggle', label: 'B', required: true }
    ])

    expect(refusalFor('input.form', params, values({ b: 'x', zz: true }))).toBe('field:zz:unknown')
    expect(refusalFor('input.form', params, values({ b: 'x' }))).toBe('field:a:missing')
    expect(refusalFor('input.form', params, values({ a: true, b: 'x' }))).toBe('field:b:type')
  })

  it('counts a multiple choice of [] as no value', () => {
    const field = { id: 'c', kind: 'choice', label: 'C', multiple: true, options: [{ value: 'a', label: 'A' }] }

    expect(refusalFor('input.form', form([field]), values({ c: [] }))).toBeNull()
    expect(refusalFor('input.form', form([{ ...field, required: true }]), values({ c: [] }))).toBe('field:c:missing')
  })

  it('compares amounts as decimals, in the currency’s minor unit', () => {
    const field = { id: 'p', kind: 'amount', label: 'P', currency: 'KWD', min: '0.5' }

    expect(refusalFor('input.form', form([field]), values({ p: '0.500' }))).toBeNull()
    expect(refusalFor('input.form', form([field]), values({ p: '0.499' }))).toBe('field:p:below_min')
    expect(refusalFor('input.form', form([{ ...field, currency: 'EUR' }]), values({ p: '0.500' }))).toBe(
      'field:p:format'
    )
    expect(refusalFor('input.form', form([{ ...field, currency: 'JPY' }]), values({ p: '1' }))).toBeNull()
  })

  it('takes a time of day only as HH:MM and a date only when it exists', () => {
    const fields = [
      { id: 'd', kind: 'date', label: 'D' },
      { id: 't', kind: 'time', label: 'T' }
    ]

    expect(refusalFor('input.form', form(fields), values({ d: '2028-02-29' }))).toBeNull()
    expect(refusalFor('input.form', form(fields), values({ d: '2027-02-29' }))).toBe('field:d:format')
    expect(refusalFor('input.form', form(fields), values({ t: '24:00' }))).toBe('field:t:format')
  })

  it('reads a datetime’s offset in its own zone, across a daylight saving change', () => {
    const fields = [{ id: 'at', kind: 'datetime', label: 'At', tz: 'Europe/Amsterdam' }]

    expect(
      refusalFor('input.form', form(fields), values({ at: '2026-03-29T01:59+01:00[Europe/Amsterdam]' }))
    ).toBeNull()
    expect(
      refusalFor('input.form', form(fields), values({ at: '2026-03-29T03:00+02:00[Europe/Amsterdam]' }))
    ).toBeNull()
    expect(refusalFor('input.form', form(fields), values({ at: '2026-03-29T03:00+01:00[Europe/Amsterdam]' }))).toBe(
      'field:at:offset'
    )
    // A zone given as an offset is not an IANA name.
    expect(
      refusalFor(
        'input.form',
        form([{ id: 'at', kind: 'datetime', label: 'At' }]),
        values({ at: '2026-03-29T03:00+02:00[+02:00]' })
      )
    ).toBe('field:at:zone')
  })

  it('resolves . and .. lexically and keeps a sibling that shares a prefix out', () => {
    expect(resolveLexically('/a/b/../c/./d')).toBe('/a/c/d')
    expect(resolveLexically('/../../x')).toBe('/x')
    expect(isUnder('/up/2026', '/up/2026/f.jpg')).toBe(true)
    expect(isUnder('/up/2026/', '/up/2026/../2026/f.jpg')).toBe(true)
    expect(isUnder('/up/2026', '/up/2026-old/f.jpg')).toBe(false)
    expect(isUnder('/up/2026', '/up/2026')).toBe(false)
  })

  it('adds the files up against the total after each file passed on its own', () => {
    const params = {
      ...defaultParams('input.file', 0),
      multiple: true,
      upload: { dir: '/up', max_bytes: 100, max_total_bytes: 150, max_files: 3, strip_metadata: false }
    }
    const file = (name: string, bytes: number) => ({
      path: `/up/0123456789abcdef-${name}`,
      name,
      mime: 'text/plain',
      bytes,
      sha256: 'a'.repeat(64)
    })

    expect(refusalFor('input.file', params, { status: 'answered', files: [file('a', 100), file('b', 50)] })).toBeNull()
    expect(refusalFor('input.file', params, { status: 'answered', files: [file('a', 100), file('b', 51)] })).toBe(
      'files:too_large'
    )
    expect(refusalFor('input.file', params, { status: 'answered', files: [file('a', 101), file('b', 1)] })).toBe(
      'file:0:too_large'
    )
  })

  it('removes trailing whitespace before looking at a draft, and refuses what cannot be shown as it is', () => {
    const params = { ...defaultParams('review.draft', 0), text: 'Hi,\nBye', editable: false }
    const approved = (text: string) => ({ decision: 'approved', text })

    expect(stripLineEnds('a \t\nb  ')).toBe('a\nb')
    expect(refusalFor('review.draft', params, approved('Hi,  \nBye\n\n'))).toBeNull()
    expect(refusalFor('review.draft', params, approved('Hi,\r\nBye\u3000'))).toBeNull()
    expect(refusalFor('review.draft', params, approved('Hi,\n\nBye'))).toBe('text:edited')
    expect(refusalFor('review.draft', params, approved('Hi,  \nBye'))).toBeNull()
    expect(refusalFor('review.draft', params, approved('Hi, Bye'))).toBe('text:not_verbatim')
    expect(refusalFor('review.draft', params, approved('Hi,​Bye'))).toBe('text:not_verbatim')
    expect(refusalFor('review.draft', params, { decision: 'rejected', comment: 'no' })).toBeNull()
  })

  it('refuses a values key that is not a well-formed field id as bad_shape, and never echoes it', () => {
    const params = form([{ id: 'a', kind: 'toggle', label: 'A' }])

    expect(refusalFor('input.form', params, values({ Name: 'x' }))).toBe('bad_shape')
    expect(refusalFor('input.form', params, values({ 'x-y': 'x' }))).toBe('bad_shape')
    expect(refusalFor('input.form', params, values({ a: true, '1a': 1 }))).toBe('bad_shape')
    expect(refusalFor('input.form', params, values({ b: 'x' }))).toBe('field:b:unknown')
  })

  it('checks what a value is before how far it reaches: structural problems first, range after', () => {
    const range = { id: 'r', kind: 'daterange', label: 'R', min: '2026-10-05', max: '2026-12-31' }

    expect(refusalFor('input.form', form([range]), values({ r: { start: '2026-10-01', end: '2026-09-01' } }))).toBe(
      'field:r:order'
    )
    expect(refusalFor('input.form', form([range]), values({ r: { start: '2026-10-01', end: '2026-10-08' } }))).toBe(
      'field:r:below_min'
    )
  })

  it('refuses a skip only for a request that is not optional', () => {
    expect(
      refusalFor('input.form', form([{ id: 'a', kind: 'toggle', label: 'A' }], false), { status: 'skipped' })
    ).toBe('not_optional')
    expect(refusalFor('input.form', form([{ id: 'a', kind: 'toggle', label: 'A' }]), { status: 'skipped' })).toBeNull()
  })

  it('does not throw on params the contract’s models would never have built', () => {
    expect(refusalFor('input.form', { optional: true }, values({ a: 1 }))).toBe('field:a:unknown')
    expect(refusalFor('input.file', {}, { status: 'answered', files: [] })).toBe('bad_shape')
    expect(refusalFor('review.draft', {}, { decision: 'approved', text: 'ok' })).toBeNull()
  })
})

// ── over the wire ────────────────────────────────────────────────────────────

const gateways: FakeGateway[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate()
  }

  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

interface Frame {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: Obj
  result?: Obj
  error?: { code: number; message: string; data?: Obj }
}

interface Client {
  frames: Frame[]
  call: (method: string, params?: object) => Promise<Frame>
  /** The first server request frame for `method` that arrives. */
  requestOf: (method: string) => Promise<Frame>
  /** The first event of `type` that arrives. */
  eventOf: (type: string) => Promise<Frame>
  /** Reply to a server request with a bare response frame, and wait for whatever comes back. */
  reply: (id: unknown, body: { result?: unknown; error?: unknown }) => void
  advertise: (requests: string[]) => Promise<Frame>
}

const open = async (gateway: FakeGateway): Promise<Client> => {
  const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
  const frames: Frame[] = []
  const waiters = new Set<() => void>()

  sockets.push(socket)
  socket.on('message', raw => {
    for (const line of String(raw).split('\n')) {
      if (line.trim()) {
        frames.push(JSON.parse(line) as Frame)
      }
    }

    for (const waiter of [...waiters]) {
      waiter()
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  const until = <T>(find: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 4000)
      const check = () => {
        const found = find()

        if (found !== undefined) {
          clearTimeout(timer)
          waiters.delete(check)
          resolve(found)
        }
      }

      waiters.add(check)
      check()
    })
  let id = 0
  const call = (method: string, params: object = {}) => {
    const frameId = `rpc-${(id += 1)}`

    socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))

    return until(() => frames.find(frame => frame.id === frameId && frame.method === undefined))
  }

  return {
    frames,
    call,
    requestOf: method => until(() => frames.find(frame => frame.method === method && frame.id !== undefined)),
    eventOf: type => until(() => frames.find(frame => frame.method === 'event' && frame.params?.type === type)),
    reply: (frameId, body) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, ...body })),
    advertise: async requests => {
      await call('client.capabilities', { server_requests: true })

      return call('client.capabilities', { server_requests: true, confirm: ['plain'], requests })
    }
  }
}

const start = async (): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ port: 0 })

  gateways.push(gateway)

  return gateway
}

const raise = async (gateway: FakeGateway, method: string, params?: Obj): Promise<Response> =>
  fetch(`${gateway.url}/__fake/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...(params ? { params } : {}) })
  })

const report = async (gateway: FakeGateway, id: string): Promise<Obj> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as Obj

const ALL = [...INTERACTIVE_METHODS]
const goodForm = {
  status: 'answered',
  values: { name: 'Ada', guests: 2, stay: { start: '2026-11-14', end: '2026-11-16' } }
}
const badForm = {
  status: 'answered',
  values: { name: 'Ada', guests: 0, stay: { start: '2026-11-14', end: '2026-11-16' } }
}

describe('the handshake', () => {
  it('lists the interactive methods among the request kinds the gateway can raise', async () => {
    const gateway = await start()
    const client = await open(gateway)
    const answer = await client.call('client.capabilities', { server_requests: true })

    expect(answer.result?.server_requests).toEqual(expect.arrayContaining(ALL))
    expect(answer.result).not.toHaveProperty('requests')
  })

  it('echoes the methods it accepted, and records them as accepted', async () => {
    const gateway = await start()
    const client = await open(gateway)
    const answer = await client.call('client.capabilities', {
      server_requests: true,
      requests: ['input.form', 'bogus', 'input.form', 7, 'review.draft']
    })

    expect(answer.result?.requests).toEqual(['input.form', 'review.draft'])
    expect(gateway.state.clientCapabilities.at(-1)).toEqual({
      server_requests: true,
      confirm: [],
      requests: ['input.form', 'review.draft']
    })
  })

  it('takes `requests` only together with `server_requests: true`', async () => {
    const gateway = await start()
    const client = await open(gateway)
    const answer = await client.call('client.capabilities', { requests: ALL })

    expect(answer.result?.requests).toEqual([])
    expect((await raise(gateway, 'input.form')).status).toBe(409)
  })

  it('replaces what a connection advertised before', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)
    await client.call('client.capabilities', { server_requests: true, requests: ['review.draft'] })

    expect((await raise(gateway, 'input.form')).status).toBe(409)
    expect((await raise(gateway, 'review.draft')).status).toBe(200)
  })
})

describe('who is sent a request', () => {
  it('answers 409 no_capable_client and sends nothing when no connection advertised the method', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(['input.form'])

    const refused = await raise(gateway, 'review.draft')

    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'no_capable_client', outcome: 'unavailable' })
    expect(client.frames.some(frame => frame.method === 'review.draft')).toBe(false)
    expect([...gateway.state.openServerRequests.keys()]).toEqual([])
  })

  it('sends it to the connections that advertised it and to no other', async () => {
    const gateway = await start()
    const capable = await open(gateway)
    const other = await open(gateway)

    await capable.advertise(['input.form'])
    await other.advertise(['review.draft'])

    const raised = (await (await raise(gateway, 'input.form')).json()) as Obj
    const frame = await capable.requestOf('input.form')

    expect(frame.id).toBe(raised.id)
    expect(frame.params?.session_id).toBe(raised.session_id)
    await other.call('gateway.ping')
    expect(other.frames.some(entry => entry.method === 'input.form')).toBe(false)
  })

  it('raises the contract’s example for the method, with an expiry in the future', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    for (const method of INTERACTIVE_METHODS) {
      await raise(gateway, method)

      const frame = await client.requestOf(method)
      const { session_id: _session, ...params } = frame.params as Obj
      const { expires_at: expiresAt, ...rest } = params
      const { expires_at: _example, ...example } = ((methods[method]!.frames as Obj[])[0] as Obj).params as Obj
      const { session_id: _exampleSession, ...exampleRest } = example

      expect(rest).toEqual(exampleRest)
      expect(expiresAt as number).toBeGreaterThan(Date.now() / 1000)
      expect(matchesParams(method, frame.params)).toBe(true)
    }
  })

  it('lays the caller’s params over the example', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)
    await raise(gateway, 'input.form', { title: 'Mine', optional: false })

    const frame = await client.requestOf('input.form')

    expect(frame.params).toMatchObject({ title: 'Mine', optional: false, v: 1 })
    expect(frame.params?.fields).toBeDefined()
  })

  it('stays permissive for a method it does not know as interactive', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const response = await raise(gateway, 'device.location', { summary: 'where are you' })

    expect(response.status).toBe(200)
    expect((await client.requestOf('device.location')).params).toMatchObject({ summary: 'where are you' })
  })
})

describe('answers', () => {
  it('settles the request on a valid answer sent as the reply frame', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }

    expect(await report(gateway, id)).toMatchObject({ id, method: 'input.form', open: true, refusals: [] })
    await client.requestOf('input.form')
    client.reply(id, { result: goodForm })

    await waitUntil(async () => (await report(gateway, id)).open === false)
    expect(await report(gateway, id)).toMatchObject({
      open: false,
      outcome: 'answered',
      answer: goodForm,
      refusals: []
    })
    expect(gateway.state.serverRequestAnswers.at(-1)).toEqual({ id, method: 'input.form', result: goodForm })
    expect([...gateway.state.openServerRequests.keys()]).toEqual([])
  })

  it('settles it on `request.answer` from a connection that was never sent the frame, and says expired after', async () => {
    const gateway = await start()
    const capable = await open(gateway)
    const bystander = await open(gateway)

    await capable.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }
    const taken = await bystander.call('request.answer', { id, result: goodForm })
    const again = await bystander.call('request.answer', { id, result: goodForm })

    expect(taken.result).toEqual({ status: 'ok' })
    expect(again.result).toEqual({ status: 'expired' })
    expect((await report(gateway, id)).answer).toEqual(goodForm)
  })

  it('refuses with 4034 and the reason, and the request stays open', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }
    const refused = await client.call('request.answer', { id, result: badForm })

    expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'field:guests:below_min' } })
    expect(await report(gateway, id)).toMatchObject({ open: true, refusals: ['field:guests:below_min'] })
    expect((await client.call('request.answer', { id, result: { status: 'answered' } })).error?.data?.reason).toBe(
      'bad_shape'
    )
    expect((await client.call('request.answer', { id, result: goodForm })).result).toEqual({ status: 'ok' })
    expect(await report(gateway, id)).toMatchObject({ open: false, refusals: ['field:guests:below_min', 'bad_shape'] })
  })

  it('answers a refused reply frame with the same refusal on a frame of its own', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form', { optional: false })).json()) as { id: string }

    await client.requestOf('input.form')
    client.reply(id, { result: { status: 'skipped' } })

    const refusal = await new Promise<Frame>((resolve, reject) => {
      const timer = setInterval(() => {
        const found = client.frames.find(frame => frame.id === id && frame.error)

        if (found) {
          clearInterval(timer)
          resolve(found)
        }
      }, 5)

      setTimeout(() => reject(new Error('no refusal')), 3000)
    })

    expect(refusal.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'not_optional' } })
    expect((await report(gateway, id)).open).toBe(true)
  })

  it('takes a draft’s text without its trailing whitespace and says whether it was edited', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'review.draft', { text: 'Hi,\nBye', editable: true })).json()) as {
      id: string
    }

    await client.call('request.answer', { id, result: { decision: 'approved', text: 'Hi,  \nBye!' } })
    expect((await report(gateway, id)).answer).toEqual({ decision: 'approved', text: 'Hi,\nBye!', edited: true })
  })

  it('withdraws the request at the tenth refusal and names the cap instead of the problem', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }

    for (let attempt = 1; attempt < MAX_REFUSALS; attempt += 1) {
      const refused = await client.call('request.answer', { id, result: badForm })

      expect(refused.error?.data?.reason).toBe('field:guests:below_min')
      expect((await report(gateway, id)).open).toBe(true)
    }

    const last = await client.call('request.answer', { id, result: badForm })

    expect(last.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'too_many_attempts' } })

    const cancel = await client.eventOf('request.cancel')

    expect(cancel.params?.payload).toEqual({ id, method: 'input.form', reason: 'too_many_attempts' })

    const view = await report(gateway, id)

    expect(view).toMatchObject({ open: false, outcome: 'too_many_attempts', reason: 'too_many_attempts' })
    expect(view.refusals).toHaveLength(MAX_REFUSALS)
    // Even a good answer is not an answer any more.
    expect((await client.call('request.answer', { id, result: goodForm })).result).toEqual({ status: 'expired' })
    expect([...gateway.state.openServerRequests.keys()]).toEqual([])
  })
})

describe('an error response', () => {
  it('settles the request: the agent is told it is unavailable, not answered', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.file')).json()) as { id: string }
    const error = { code: 4041, message: 'cannot_show', data: { reason: 'no_camera' } }

    await client.requestOf('input.file')
    client.reply(id, { error })
    await waitUntil(async () => (await report(gateway, id)).open === false)

    expect(await report(gateway, id)).toMatchObject({ open: false, outcome: 'unavailable', error, reason: 'no_camera' })
    expect(await report(gateway, id)).not.toHaveProperty('answer')
    expect(gateway.state.serverRequestAnswers.at(-1)).toEqual({ id, method: 'input.file', error })
    expect((await client.call('request.answer', { id, result: { status: 'skipped' } })).result).toEqual({
      status: 'expired'
    })
  })

  it('resolves `settled` for a caller holding the gateway object', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const raised = gateway.raiseInteractive({ method: 'review.draft' })

    if (raised.kind !== 'raised') {
      throw new Error(`not raised: ${raised.kind}`)
    }

    await client.requestOf('review.draft')
    client.reply(raised.id, { error: { code: 4041, message: 'cannot_show', data: { reason: 'shutting_down' } } })

    expect(await raised.settled).toMatchObject({ outcome: 'unavailable', reason: 'shutting_down' })
  })
})

describe('the clock', () => {
  it('withdraws the request with `request.cancel timeout` at expires_at, and an answer after is expired', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (
      await raise(gateway, 'input.form', { expires_at: Math.floor(Date.now() / 1000) + 1 })
    ).json()) as { id: string }

    expect((await report(gateway, id)).open).toBe(true)

    const cancel = await client.eventOf('request.cancel')

    expect(cancel.params?.payload).toEqual({ id, method: 'input.form', reason: 'timeout' })
    expect(await report(gateway, id)).toMatchObject({ open: false, outcome: 'timeout', reason: 'timeout' })
    expect((await client.call('request.answer', { id, result: goodForm })).result).toEqual({ status: 'expired' })
  })

  it('stops waiting at once on `POST /__fake/request/<id>/expire`', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'review.draft')).json()) as { id: string }
    const ended = await fetch(`${gateway.url}/__fake/request/${id}/expire`, { method: 'POST' })

    expect(await ended.json()).toMatchObject({ open: false, outcome: 'timeout' })
    expect((await client.eventOf('request.cancel')).params?.payload).toMatchObject({ id, reason: 'timeout' })
  })

  it('is withdrawn with every other open request by `POST /__fake/withdraw-requests`', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }

    await fetch(`${gateway.url}/__fake/withdraw-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stale' })
    })

    expect(await report(gateway, id)).toMatchObject({ open: false, outcome: 'withdrawn', reason: 'stale' })
  })

  it('answers 404 for a request it never raised', async () => {
    const gateway = await start()

    expect((await fetch(`${gateway.url}/__fake/request/srq-999`)).status).toBe(404)
    expect((await fetch(`${gateway.url}/__fake/request/srq-999/expire`, { method: 'POST' })).status).toBe(404)
  })
})

describe('what a resume lists', () => {
  const storedId = (gateway: FakeGateway) =>
    gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id

  it('lists an open request to the connections that advertised it, and to no other', async () => {
    const gateway = await start()
    const capable = await open(gateway)
    const plain = await open(gateway)
    const forms = await open(gateway)

    await capable.advertise(ALL)
    await forms.advertise(['review.draft'])

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }
    const resume = (client: Client) =>
      client.call('session.resume', { session_id: storedId(gateway), profile: 'researcher' })
    const listed = (await resume(capable)).result?.open_requests as Obj[]

    expect(listed.map(entry => [entry.id, entry.method])).toEqual([[id, 'input.form']])
    expect((listed[0]?.params as Obj).title).toBe('Hotel booking details')
    expect((await resume(plain)).result).not.toHaveProperty('open_requests')
    expect((await resume(forms)).result).not.toHaveProperty('open_requests')

    const since = await capable.call('session.events.since', {
      session_id: (await resume(capable)).result?.session_id,
      last_seen: 0
    })

    expect((since.result?.open_requests as Obj[]).map(entry => entry.id)).toEqual([id])
  })

  it('stops listing it once it settled', async () => {
    const gateway = await start()
    const client = await open(gateway)

    await client.advertise(ALL)

    const { id } = (await (await raise(gateway, 'input.form')).json()) as { id: string }

    await client.call('request.answer', { id, result: goodForm })

    const resumed = await client.call('session.resume', { session_id: storedId(gateway), profile: 'researcher' })

    expect(resumed.result).not.toHaveProperty('open_requests')
  })
})

describe('the upload route', () => {
  it('lists what it received, with the size and SHA-256 an input.file answer quotes', async () => {
    const gateway = await start()
    const bytes = 'a receipt, more or less'
    const upload = (path: string, body: string, filename: string, type: string) => {
      const form = new FormData()

      form.append('path', path)
      form.append('file', new Blob([body], { type }), filename)

      return fetch(`${gateway.url}/api/files/upload-stream`, { method: 'POST', body: form })
    }

    expect(((await (await fetch(`${gateway.url}/__fake/files`)).json()) as Obj).files).toEqual([])
    expect((await upload('/work/up/3f9c2a7b1d4e8f60-receipt.txt', bytes, 'receipt.txt', 'text/plain')).status).toBe(200)
    expect(
      (await upload('/work/up/a07e5d21c4b98f13-b.bin', 'ÿ\u0000x', 'b.bin', 'application/octet-stream')).status
    ).toBe(200)

    const { files } = (await (await fetch(`${gateway.url}/__fake/files`)).json()) as { files: Obj[] }

    expect(files[0]).toEqual({
      path: '/work/up/3f9c2a7b1d4e8f60-receipt.txt',
      name: 'receipt.txt',
      mime: 'text/plain',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    expect(files.map(file => file.path)).toEqual([
      '/work/up/3f9c2a7b1d4e8f60-receipt.txt',
      '/work/up/a07e5d21c4b98f13-b.bin'
    ])
    expect(files[1]).toMatchObject({
      bytes: Buffer.byteLength('ÿ\u0000x'),
      sha256: createHash('sha256').update('ÿ\u0000x').digest('hex')
    })
  })
})

/** Poll until `done` holds; the answer frame travels on its own and nothing resolves when it lands. */
async function waitUntil(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await done()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error('timed out')
}
