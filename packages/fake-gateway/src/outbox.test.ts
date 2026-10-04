/**
 * The files a bot shares, as the fake serves them: `contract/outbox/` (the fork's `tui_gateway/outbox.py`).
 *
 * The ranges and the dispositions are the contract's own examples (`contract/outbox/examples.json`, normative);
 * the rest is the rule of the route: the profile asked for, the recorded name, the headers every answer carries,
 * `If-Range` and `If-None-Match`, and where a reply's `attachments` appear (`message.complete`, `session.history`,
 * the REST transcript) and that they name a url the route serves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import examples from '../../../contract/outbox/examples.json'
import { answerOutbox, presentation, quoteName, rangeOf, sampleOf, storeFile, wireOf } from './outbox'
import { OUTBOX_SAMPLES, type OutboxKind } from './outbox-samples'
import { type FakeGateway, startFakeGateway } from './server'

const TOKEN = 's3cret'
const headers = { 'x-hermes-session-token': TOKEN }

describe('rangeOf, by the contract’s examples', () => {
  it.each(examples.ranges.cases)('$range answers $status', ({ range, status, content_range: contentRange }) => {
    const answer = rangeOf(range, examples.ranges.size)

    if (status === 416) {
      expect(answer).toEqual({ kind: 'unsatisfiable' })
    } else if (status === 200) {
      expect(answer).toEqual({ kind: 'whole' })
    } else {
      expect(answer.kind).toBe('partial')

      if (answer.kind === 'partial') {
        expect(`bytes ${answer.start}-${answer.end}/${examples.ranges.size}`).toBe(contentRange)
      }
    }
  })
})

describe('presentation, by the contract’s examples', () => {
  it.each(examples.dispositions)('$kind $mime is $disposition as $content_type', entry => {
    expect(
      presentation(
        { kind: entry.kind as OutboxKind, mime: entry.mime },
        'sec_fetch_dest' in entry ? entry.sec_fetch_dest : undefined
      )
    ).toEqual({
      contentType: entry.content_type,
      disposition: entry.disposition
    })
  })
})

describe('the route', () => {
  let gateway: FakeGateway
  let image: ReturnType<typeof wireOf>

  beforeEach(async () => {
    gateway = await startFakeGateway({ port: 0, auth: 'token', token: TOKEN })
    image = wireOf(storeFile(gateway.state.outboxFiles, 'default', OUTBOX_SAMPLES.image(), 1790000000))
  })

  afterEach(async () => {
    await gateway.close()
  })

  const get = (path: string, extra: Record<string, string> = {}, method = 'GET') =>
    fetch(`${gateway.url}${path}`, { method, headers: { ...headers, ...extra } })

  it('serves the bytes with the headers every answer carries', async () => {
    const response = await get(`${image.url}?profile=default`)
    const body = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toMatch(
      /^inline; filename="sunrise\.png"; filename\*=UTF-8''sunrise\.png$/u
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe(`"${image.sha256}"`)
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(body.length).toBe(image.size)
  })

  it('answers the dashboard’s own profile when none is asked for, and 404 for another', async () => {
    expect((await get(image.url)).status).toBe(200)
    expect((await get(`${image.url}?profile=researcher`)).status).toBe(404)
    expect((await get(`${image.url}?profile=ghost`)).status).toBe(404)
  })

  it('answers 404 for another id, another name, a nested path, and says nothing about which', async () => {
    const other = `/api/files/outbox/${'a'.repeat(32)}/${quoteName(image.name)}`
    const renamed = `/api/files/outbox/${image.id}/other.png`
    const nested = `${image.url}/more`

    for (const path of [other, renamed, nested]) {
      const response = await get(path)

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ detail: 'Not Found' })
      // A 404 is sandboxed and unsniffed like every other answer of the route, and has no file's validators.
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.has('etag')).toBe(false)
      expect(response.headers.has('content-disposition')).toBe(false)
    }
  })

  it('does not take the token on the address: only the header or the cookie', async () => {
    const response = await fetch(`${gateway.url}${image.url}?token=${TOKEN}`)

    expect(response.status).toBe(401)
  })

  it('answers one byte range with 206 and the others as the contract says', async () => {
    const size = image.size
    const partial = await get(image.url, { range: 'bytes=0-9' })

    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 0-9/${size}`)
    expect((await partial.arrayBuffer()).byteLength).toBe(10)

    const suffix = await get(image.url, { range: 'bytes=-4' })

    expect(suffix.headers.get('content-range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`)

    const past = await get(image.url, { range: `bytes=${size}-` })

    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${size}`)
    expect((await get(image.url, { range: 'bytes=0-1,4-5' })).status).toBe(200)
    expect((await get(image.url, { range: 'items=0-9' })).status).toBe(200)
  })

  it('answers If-Range with another validator in full, and If-None-Match with the ETag with 304', async () => {
    const full = await get(image.url, { range: 'bytes=0-9', 'if-range': '"other"' })

    expect(full.status).toBe(200)
    expect((await get(image.url, { range: 'bytes=0-9', 'if-range': `"${image.sha256}"` })).status).toBe(206)
    expect((await get(image.url, { 'if-none-match': `"${image.sha256}"` })).status).toBe(304)
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await get(image.url, {}, 'HEAD')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(image.size))
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it('serves a PDF asked for as a page as a download, and one a script fetched inline', async () => {
    const pdf = wireOf(storeFile(gateway.state.outboxFiles, 'default', OUTBOX_SAMPLES.pdf(), 1790000000))
    const asPage = await get(pdf.url, { 'sec-fetch-dest': 'document' })
    const fetched = await get(pdf.url, { 'sec-fetch-dest': 'empty' })

    expect(asPage.headers.get('content-disposition')).toMatch(/^attachment;/u)
    expect(fetched.headers.get('content-disposition')).toMatch(/^inline;/u)
    expect(fetched.headers.get('content-type')).toBe('application/pdf')
    expect(
      Buffer.from(await fetched.arrayBuffer())
        .subarray(0, 5)
        .toString()
    ).toBe('%PDF-')
  })

  it('serves HTML as an opaque download, under a name that needs encoding', async () => {
    const html = wireOf(storeFile(gateway.state.outboxFiles, 'default', OUTBOX_SAMPLES.html(), 1790000000))

    expect(html.kind).toBe('file')
    expect(html.url).toContain('%3Cdraft%3E')

    const response = await get(html.url)

    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u)
  })

  it('records what was asked and answered', async () => {
    await get(`${image.url}?profile=default`, { range: 'bytes=0-9' })
    await get(`${image.url}?profile=ghost`)

    expect(gateway.state.outboxRequests).toEqual([
      { id: image.id, name: image.name, profile: 'default', method: 'GET', range: 'bytes=0-9', status: 206 },
      { id: image.id, name: image.name, profile: 'ghost', method: 'GET', range: null, status: 404 }
    ])
  })
})

describe('answerOutbox', () => {
  it('is a 404 for a file of another profile even with the right id and name', () => {
    const files = new Map()
    const file = storeFile(files, 'researcher', sampleOf({ name: 'a.txt', mime: 'text/plain', text: 'hello' }), 1)

    expect(
      answerOutbox(files, { method: 'GET', id: file.id, name: 'a.txt', profile: null, defaultProfile: 'default' })
        .status
    ).toBe(404)
    expect(
      answerOutbox(files, {
        method: 'GET',
        id: file.id,
        name: 'a.txt',
        profile: 'researcher',
        defaultProfile: 'default'
      }).status
    ).toBe(200)
  })
})

describe('a reply that shares files', () => {
  let gateway: FakeGateway
  let socket: WebSocket
  let nextId = 0
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  const events: { type: string; payload: Record<string, unknown> }[] = []

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  beforeEach(async () => {
    gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
    events.length = 0
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

          events.push({ type: String(params.type ?? ''), payload: (params.payload ?? {}) as Record<string, unknown> })
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

  it('sends them with message.complete, keeps them on the row, and serves each by its url', async () => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const resumed = await call('session.resume', { session_id: stored, profile: 'researcher' })
    const sessionId = String(resumed.session_id)

    await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text: 'please share files' })

    for (let attempt = 0; attempt < 500 && !events.some(event => event.type === 'message.complete'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const complete = events.find(event => event.type === 'message.complete')
    const attachments = complete?.payload.attachments as ReturnType<typeof wireOf>[]

    expect(attachments.map(entry => entry.kind)).toEqual(['image', 'image', 'video', 'audio', 'pdf', 'file', 'file'])
    expect(String(complete?.payload.text)).toContain('(1 file could not be shared.)')

    // Every one of them is the shape of the contract, and the route serves it for the profile of the chat.
    for (const entry of attachments) {
      expect(Object.keys(entry).sort()).toEqual(['created_at', 'id', 'kind', 'mime', 'name', 'sha256', 'size', 'url'])
      expect(entry.url).toBe(`/api/files/outbox/${entry.id}/${quoteName(entry.name)}`)
      expect(entry.id).toMatch(/^[A-Za-z0-9_-]{32}$/u)

      const response = await fetch(`${gateway.url}${entry.url}?profile=researcher`)

      expect(response.status).toBe(200)
      expect((await response.arrayBuffer()).byteLength).toBe(entry.size)
      expect((await fetch(`${gateway.url}${entry.url}?profile=default`)).status).toBe(404)
    }

    const history = await call('session.history', { session_id: sessionId, profile: 'researcher' })
    const rows = (history.messages ?? []) as { role: string; attachments?: unknown }[]

    expect(rows.at(-1)?.role).toBe('assistant')
    expect(rows.at(-1)?.attachments).toEqual(attachments)
  })
})
