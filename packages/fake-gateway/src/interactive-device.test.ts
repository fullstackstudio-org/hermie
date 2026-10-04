/**
 * `input.signature`, the device requests and the audio rules of `input.file` over a real WebSocket: what the agent is
 * told of an answer (rounded, cut, cleaned), what a signature's files must be, which `4041` reasons reach the agent as
 * what, the gateway's limits (one open, twelve a window, six for `device.*`) and `no_acting_user`.
 */
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { FamilyLimits, RATE_LIMITED, ALREADY_PENDING, RequestLimiter } from './request-limits'
import { statementSha256 } from './device-requests'
import { INTERACTIVE_METHODS, loadContract } from './interactive'
import { type FakeGateway, startFakeGateway, type FakeGatewayOptions } from './server'

type Obj = Record<string, unknown>

interface Frame {
  id?: unknown
  method?: string
  params?: Obj
  result?: Obj
  error?: { code: number; message: string; data?: Obj }
}

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

const start = async (options: Partial<FakeGatewayOptions> = {}): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ port: 0, ...options })

  gateways.push(gateway)

  return gateway
}

/** A connection that advertised every interactive method; `reply` answers a request frame with a bare response. */
async function client(gateway: FakeGateway) {
  const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
  const frames: Frame[] = []

  sockets.push(socket)
  socket.on('message', raw => {
    for (const line of String(raw).split('\n')) {
      if (line.trim()) {
        frames.push(JSON.parse(line) as Frame)
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  let sequence = 0
  const until = async <T>(find: () => T | undefined): Promise<T> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = find()

      if (found !== undefined) {
        return found
      }

      await new Promise(resolve => setTimeout(resolve, 10))
    }

    throw new Error('timed out waiting for a frame')
  }
  const call = (method: string, params: object = {}) => {
    const id = `rpc-${(sequence += 1)}`

    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))

    return until(() => frames.find(frame => frame.id === id && frame.method === undefined))
  }

  await call('client.capabilities', { server_requests: true })
  await call('client.capabilities', { server_requests: true, confirm: ['plain'], requests: [...INTERACTIVE_METHODS] })

  return {
    frames,
    call,
    requestOf: (id: string) => until(() => frames.find(frame => frame.id === id && frame.method !== undefined)),
    reply: (id: string, body: { result?: unknown; error?: unknown }) =>
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }))
  }
}

const post = (gateway: FakeGateway, path: string, body: Obj) =>
  fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

const raise = (gateway: FakeGateway, method: string, params?: Obj, extra: Obj = {}) =>
  post(gateway, '/__fake/request', { method, ...(params ? { params } : {}), ...extra })

const view = async (gateway: FakeGateway, id: string): Promise<Obj> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as Obj

const settled = async (gateway: FakeGateway, id: string): Promise<Obj> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const now = await view(gateway, id)

    if (now.open === false) {
      return now
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error('still open')
}

const idOf = async (response: Response): Promise<string> => ((await response.json()) as { id: string }).id

const examples = loadContract().examples.methods as Record<string, { answers: { name: string; result: Obj }[] }>
const exampleAnswer = (method: string, name: string): Obj =>
  examples[method]?.answers.find(answer => answer.name === name)?.result as Obj

/** Raise `method`, let the client see it and answer it; what the gateway made of it. */
async function answered(gateway: FakeGateway, method: string, params: Obj | undefined, result: Obj): Promise<Obj> {
  const connection = await client(gateway)
  const id = await idOf(await raise(gateway, method, params))

  await connection.requestOf(id)
  connection.reply(id, { result })

  return settled(gateway, id)
}

describe('the answers of the device requests reach the agent as the gateway reads them', () => {
  it('rounds an approximate location, and says when the person shared less than was asked', async () => {
    const gateway = await start()

    expect(
      await answered(gateway, 'device.location', undefined, exampleAnswer('device.location', 'approximate'))
    ).toMatchObject({
      outcome: 'answered',
      answer: { status: 'answered', lat: 52.37, lon: 4.89, accuracy_m: 1000, at: 1791119300, precision: 'approximate' }
    })

    const lowered = await answered(
      gateway,
      'device.location',
      { precision: 'precise' },
      exampleAnswer('device.location', 'lowered_by_the_person')
    )

    expect(lowered.answer).toMatchObject({ precision: 'approximate', lowered: true, lat: 52.37 })

    const precise = await answered(
      gateway,
      'device.location',
      { precision: 'precise' },
      exampleAnswer('device.location', 'precise')
    )

    expect(precise.answer).toMatchObject({ lat: 52.373123, lon: 4.892201, accuracy_m: 8.5, precision: 'precise' })
    expect(precise.answer).not.toHaveProperty('lowered')
  })

  it('refuses a precise location for an approximate request, and the request stays open', async () => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, 'device.location'))

    await connection.requestOf(id)

    const refused = await connection.call('request.answer', {
      id,
      result: { ...exampleAnswer('device.location', 'precise') }
    })

    expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'precision:too_precise' } })
    expect((await view(gateway, id)).open).toBe(true)
  })

  it('hands the agent the requested contact keys only, cleaned', async () => {
    const gateway = await start()
    const result = await answered(gateway, 'device.contact', undefined, {
      status: 'answered',
      contact: { name: 'Bram‮  de Vries', phones: ['+31 6 12​345678'] }
    })

    expect(result.answer).toEqual({
      status: 'answered',
      contact: { name: 'Bram de Vries', phones: ['+31 6 12345678'] }
    })
  })

  it('refuses a contact key that was not asked for, whatever its value', async () => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, 'device.contact'))

    await connection.requestOf(id)

    const refused = await connection.call('request.answer', {
      id,
      result: { status: 'answered', contact: { name: 'Bram', emails: null } }
    })

    expect(refused.error?.data).toEqual({ reason: 'contact:emails:not_requested' })
  })

  it('says a calendar entry was saved, and for which kind, and nothing else', async () => {
    const gateway = await start()

    expect((await answered(gateway, 'device.calendar', undefined, { status: 'done' })).answer).toEqual({
      status: 'done',
      saved: true,
      kind: 'event'
    })
  })

  it('cleans a scanned value and says whether cleaning changed it', async () => {
    const gateway = await start()
    const plain = await answered(gateway, 'device.scan', undefined, {
      status: 'answered',
      value: 'WIFI:T:WPA;S:home;;',
      symbology: 'qr'
    })
    const hidden = await answered(gateway, 'device.scan', undefined, {
      status: 'answered',
      value: 'https://exa​mple.com/‮txt.exe',
      symbology: 'qr'
    })

    expect(plain.answer).toEqual({ status: 'answered', value: 'WIFI:T:WPA;S:home;;', symbology: 'qr', cleaned: false })
    expect(hidden.answer).toEqual({
      status: 'answered',
      value: 'https://example.com/txt.exe',
      symbology: 'qr',
      cleaned: true
    })
  })

  it('hands a skip over as a skip, for every device request that may be skipped', async () => {
    const gateway = await start()

    for (const method of ['device.location', 'device.contact', 'device.calendar', 'device.scan', 'input.signature']) {
      expect((await answered(gateway, method, undefined, { status: 'skipped' })).answer).toEqual({ status: 'skipped' })
    }
  })

  it('refuses a skip of a request that is not optional', async () => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, 'device.scan', { optional: false }))

    await connection.requestOf(id)

    expect((await connection.call('request.answer', { id, result: { status: 'skipped' } })).error?.data).toEqual({
      reason: 'not_optional'
    })
  })
})

describe('a voice note', () => {
  it('reaches the agent with its transcript cleaned, and refuses a transcript with no recording', async () => {
    const gateway = await start()
    const voice = exampleAnswer('input.file', 'audio_with_transcript')
    const taken = await answered(
      gateway,
      'input.file',
      { accept: 'audio', capture: 'audio' },
      {
        ...voice,
        text: 'Hello​   there\n\n\n\nbye‮'
      }
    )

    expect(taken.answer).toMatchObject({ status: 'answered', text: 'Hello there\n\nbye' })

    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, 'input.file', { accept: 'image', capture: 'photo' }))

    await connection.requestOf(id)
    expect(
      (await connection.call('request.answer', { id, result: { ...voice, text: 'a transcript of a photo' } })).error
        ?.data
    ).toBeDefined()
  })
})

describe('a signature', () => {
  const STATEMENT = 'I have read the agreement and agree to its terms.'
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" stroke="#000"/></svg>')
  const DIR = '/work/uploads/hermie/2026-10-04'
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const upload = async (gateway: FakeGateway, name: string, bytes: Buffer, type: string) => {
    const form = new FormData()

    form.append('path', `${DIR}/${name}`)
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name.replace(/^[0-9a-f]{16}-/, ''))
    expect((await fetch(`${gateway.url}/api/files/upload-stream`, { method: 'POST', body: form })).status).toBe(200)
  }
  const entry = (name: string, mime: string, bytes: Buffer) => ({
    path: `${DIR}/${name}`,
    name: name.replace(/^[0-9a-f]{16}-/, ''),
    mime,
    bytes: bytes.length,
    sha256: sha(bytes)
  })
  const answer = (files: Obj[]) => ({
    status: 'answered',
    files,
    signed_at: 1791119310,
    statement_sha256: statementSha256(STATEMENT)
  })
  const params = {
    statement: STATEMENT,
    signer_name: 'Ada',
    upload: { dir: DIR, max_bytes: 1_048_576, max_total_bytes: 2_097_152, max_files: 2, strip_metadata: false }
  }

  it('tells the agent what was signed, by whom and when it arrived, with both files', async () => {
    const gateway = await start()

    await upload(gateway, '5c1d9e0a7b3f2468-signature.png', PNG, 'image/png')
    await upload(gateway, '9a2b4c6d8e0f1325-signature.svg', SVG, 'image/svg+xml')

    const files = [
      entry('5c1d9e0a7b3f2468-signature.png', 'image/png', PNG),
      entry('9a2b4c6d8e0f1325-signature.svg', 'image/svg+xml', SVG)
    ]
    const taken = await answered(gateway, 'input.signature', params, answer(files))

    expect(taken).toMatchObject({ outcome: 'answered' })
    expect(taken.answer).toMatchObject({
      status: 'answered',
      signed: true,
      statement_sha256: statementSha256(STATEMENT),
      signed_at: 1791119310,
      signer_name: 'Ada',
      files
    })
    expect(typeof (taken.answer as Obj).received_at).toBe('number')
  })

  it('is unavailable for the agent when a file the fake holds is not what its type says', async () => {
    const gateway = await start()

    await upload(gateway, '5c1d9e0a7b3f2468-signature.png', PNG, 'image/png')
    // A script posing as a drawing: the request is taken (the client was told so), the agent is not given the files.
    const script = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

    await upload(gateway, '9a2b4c6d8e0f1325-signature.svg', script, 'image/svg+xml')

    const taken = await answered(
      gateway,
      'input.signature',
      params,
      answer([
        entry('5c1d9e0a7b3f2468-signature.png', 'image/png', PNG),
        entry('9a2b4c6d8e0f1325-signature.svg', 'image/svg+xml', script)
      ])
    )

    expect(taken).toMatchObject({ outcome: 'unavailable', reason: 'bad_upload', problem: 'file:1:type' })
    expect(taken).not.toHaveProperty('answer')
  })

  it('names a size or a hash that does not match what the upload route received', async () => {
    const gateway = await start()

    await upload(gateway, '5c1d9e0a7b3f2468-signature.png', PNG, 'image/png')
    await upload(gateway, '9a2b4c6d8e0f1325-signature.svg', SVG, 'image/svg+xml')

    const files = [
      entry('5c1d9e0a7b3f2468-signature.png', 'image/png', PNG),
      { ...entry('9a2b4c6d8e0f1325-signature.svg', 'image/svg+xml', SVG), sha256: 'a'.repeat(64) }
    ]

    expect(await answered(gateway, 'input.signature', params, answer(files))).toMatchObject({
      outcome: 'unavailable',
      reason: 'bad_upload',
      problem: 'file:1:hash'
    })
  })

  it('refuses the hash of another statement and a PNG saved as an SVG, and the request stays open', async () => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, 'input.signature', params))
    const files = [
      entry('5c1d9e0a7b3f2468-signature.png', 'image/png', PNG),
      entry('9a2b4c6d8e0f1325-signature.svg', 'image/svg+xml', SVG)
    ]

    await connection.requestOf(id)

    const reasonOf = async (result: Obj) =>
      (await connection.call('request.answer', { id, result })).error?.data?.reason

    expect(await reasonOf({ ...answer(files), statement_sha256: statementSha256(`${STATEMENT}\n`) })).toBe(
      'statement:mismatch'
    )
    expect(await reasonOf(answer([files[0] as Obj, { ...(files[1] as Obj), mime: 'image/png' }]))).toBe(
      'files:not_png_and_svg'
    )
    expect(
      await reasonOf(answer([{ ...(files[0] as Obj), path: `${DIR}/5c1d9e0a7b3f2468-signature.svg` }, files[1] as Obj]))
    ).toBe('file:0:extension')
    expect((await view(gateway, id)).open).toBe(true)
  })
})

describe('an error response from the client', () => {
  it.each([
    ['no_microphone', 'cannot_show:no_microphone', 'input.file'],
    ['location_unavailable', 'cannot_show:location_unavailable', 'device.location'],
    ['permission_denied', 'cannot_show:permission_denied', 'device.contact'],
    ['no_camera', 'cannot_show:no_camera', 'device.scan'],
    ['declined', 'cannot_show:declined', 'device.calendar'],
    ['something_new', 'error_response', 'input.signature']
  ])('%s reaches the agent as %s', async (reason, agentReason, method) => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(await raise(gateway, method))

    await connection.requestOf(id)

    const error = { code: 4041, message: 'cannot_show', data: { reason } }

    connection.reply(id, { error })
    expect(await settled(gateway, id)).toMatchObject({ outcome: 'unavailable', error, reason, agentReason })
  })
})

describe('who is asked, and how often', () => {
  it('puts review, signature and device requests to no one when the turn names nobody', async () => {
    const gateway = await start()
    const connection = await client(gateway)

    for (const method of ['review.draft', 'review.diff', 'input.signature', 'device.location', 'device.scan']) {
      const refused = await raise(gateway, method, undefined, { user: null })

      expect(refused.status, method).toBe(409)
      expect(await refused.json()).toMatchObject({ error: 'no_acting_user', outcome: 'unavailable' })
    }

    // Forms and files still go to every capable connection.
    const form = await raise(gateway, 'input.form', undefined, { user: null })

    expect(form.status).toBe(200)
    await connection.requestOf(await idOf(form))
    expect(connection.frames.some(frame => frame.method?.startsWith('device.'))).toBe(false)
  })

  it('opens one request per conversation when the limits are on, and frees the slot when it settles', async () => {
    const gateway = await start({ interactiveLimits: true })
    const connection = await client(gateway)
    const first = await idOf(await raise(gateway, 'input.form'))
    const second = await raise(gateway, 'device.location')

    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: 'already_pending', outcome: 'unavailable' })

    connection.reply(first, { result: { status: 'skipped' } })
    await settled(gateway, first)
    expect((await raise(gateway, 'device.location')).status).toBe(200)
  })

  it('allows six device requests per window and says rate_limited for the seventh, which a reset clears', async () => {
    const gateway = await start({ interactiveLimits: true })
    const connection = await client(gateway)

    for (let n = 0; n < 6; n += 1) {
      const id = await idOf(await raise(gateway, 'device.scan'))

      await connection.requestOf(id)
      connection.reply(id, { result: { status: 'skipped' } })
      await settled(gateway, id)
    }

    const seventh = await raise(gateway, 'device.scan')

    expect(seventh.status).toBe(409)
    expect(await seventh.json()).toMatchObject({ error: 'rate_limited' })
    // `input.*` has a window of its own.
    expect((await raise(gateway, 'input.form')).status).toBe(200)

    expect(await (await post(gateway, '/__fake/request-limits', { reset: true })).json()).toEqual({ enabled: true })
    expect((await raise(gateway, 'device.scan')).status).toBe(200)
    // That one is open now; with the limits off a second can be raised beside it.
    expect((await raise(gateway, 'device.scan')).status).toBe(409)
    expect(await (await post(gateway, '/__fake/request-limits', { enabled: false })).json()).toEqual({ enabled: false })
    expect((await raise(gateway, 'device.scan')).status).toBe(200)
  })

  it('does not charge the window for a request nobody could be asked', async () => {
    const gateway = await start({ interactiveLimits: true })

    for (let n = 0; n < 8; n += 1) {
      const refused = await raise(gateway, 'device.scan')

      expect(await refused.json()).toMatchObject({ error: 'no_capable_client' })
    }

    const connection = await client(gateway)

    expect((await raise(gateway, 'device.scan')).status).toBe(200)
    expect(connection.frames.length).toBeGreaterThan(0)
  })
})

describe('a calendar item raised through the control route', () => {
  it('is built by the gateway: cleaned, and refused with a sentence when it cannot be taken', async () => {
    const gateway = await start()
    const connection = await client(gateway)
    const id = await idOf(
      await raise(gateway, 'device.calendar', {
        item: { title: 'Den‮ tist', start: '2026-10-12T09:30+02:00', url: 'https://example.com/a' }
      })
    )
    const frame = await connection.requestOf(id)

    expect(frame.params?.item).toEqual({
      title: 'Den tist',
      start: '2026-10-12T09:30+02:00',
      url: 'https://example.com/a'
    })

    const refused = await raise(gateway, 'device.calendar', { item: { title: 'x', end: '2026-10-12T09:30+02:00' } })

    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: 'item_refused',
      detail: expect.stringContaining('end needs start')
    })
  })
})

describe('the limiter', () => {
  it('keeps keys apart, slides the window and does not charge a request nobody got', () => {
    const limiter = new RequestLimiter(1, 2, 100)

    expect(limiter.reserve('a', 0)).toBe('')
    expect(limiter.reserve('a', 1)).toBe(ALREADY_PENDING)
    expect(limiter.reserve('b', 1)).toBe('')
    limiter.release('a', 0)
    limiter.release('b', undefined)
    expect(limiter.reserve('a', 2)).toBe('')
    limiter.release('a', 2)
    expect(limiter.reserve('a', 3)).toBe(RATE_LIMITED)
    expect(limiter.reserve('a', 100)).toBe('')
    expect(limiter.reserve('b', 3)).toBe('')
  })

  it('holds one open request across both families', () => {
    const limits = new FamilyLimits()
    const first = limits.reserve(true, 'c', 0)

    expect(first.refused).toBe('')
    expect(limits.reserve(false, 'c', 0).refused).toBe(ALREADY_PENDING)
    first.limiter.release('c', 0)
    expect(limits.reserve(false, 'c', 1).refused).toBe('')
  })
})
