/**
 * The file-upload surface of the fake gateway.
 *
 * Upstream has no file-attach RPC, so a file goes over HTTP and the prompt
 * references where it landed. Three things about that are easy to get wrong and
 * are therefore reproduced faithfully rather than simplified: the managed-files
 * route refuses a relative `path` when no root is locked, the 100 MB cap is a
 * 413, and the answer reports the RESOLVED path plus the policy metadata.
 *
 * The last test is the one that matters most. It is the end-to-end shape: upload
 * bytes, submit a prompt naming the path, and read a reply that mentions the
 * file. A client that uploads successfully and then composes the reference text
 * wrongly passes every unit test and still sends the agent nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }>()
const events: { type: string; payload: Record<string, unknown> }[] = []

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** One multipart upload, the shape `uploadFile` in the app builds. */
async function upload(options: {
  path: string
  body?: BlobPart
  filename?: string
  overwrite?: string
}): Promise<Response> {
  const form = new FormData()
  form.append('path', options.path)
  form.append('overwrite', options.overwrite ?? 'true')
  form.append('file', new Blob([options.body ?? 'hello from a test']), options.filename ?? 'notes.txt')

  return fetch(`${gateway.url}/api/files/upload-stream`, { method: 'POST', body: form })
}

/**
 * Resume a bot's canonical chat and answer the RUNTIME session id.
 *
 * The stored ids carry a random suffix per server, so they are read off the
 * roster rather than spelled out — and the runtime id is what events are
 * addressed by, which is not the same string.
 */
async function resumeChat(profile: string): Promise<string> {
  const stored = gateway.state.profiles.find(row => row.name === profile)?.canonical_session?.id

  expect(stored, `no canonical session for ${profile}`).toBeTruthy()

  const resumed = await call('session.resume', { session_id: stored, profile })

  return String(resumed.session_id)
}

/** Wait for the assistant's finished text on a session. */
async function completedText(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const done = events.find(event => event.type === 'message.complete' && event.payload.session_id === sessionId)

    if (done) {
      return String((done.payload.payload as Record<string, unknown>)?.text ?? '')
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error('no message.complete arrived')
}

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
  events.length = 0
  nextId = 0
  socket = new WebSocket(`${gateway.wsUrl}`, ['hermes-gateway-v1'])

  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Record<string, unknown>
      const id = typeof frame.id === 'number' ? frame.id : null

      if (id !== null && pending.has(id)) {
        const waiter = pending.get(id)!
        pending.delete(id)

        if (frame.error) {
          waiter.reject(new Error(JSON.stringify(frame.error)))
        } else {
          waiter.resolve((frame.result ?? {}) as Record<string, unknown>)
        }

        continue
      }

      if (frame.method === 'event') {
        const params = frame.params as Record<string, unknown>
        events.push({ type: String(params?.type ?? ''), payload: params })
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

describe('POST /api/files/upload-stream', () => {
  it('stores the bytes and answers the resolved path with its policy', async () => {
    const response = await upload({ path: '/workspace/uploads/hermie/2026-09-19/abc12345-notes.txt' })

    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>

    expect(body.ok).toBe(true)
    expect(body.path).toBe('/workspace/uploads/hermie/2026-09-19/abc12345-notes.txt')
    expect(body.entry).toMatchObject({ name: 'notes.txt', size: 'hello from a test'.length, is_directory: false })
    // The unlocked managed-files policy: no root, and the caller may point
    // itself anywhere it can read.
    expect(body).toMatchObject({ root: null, locked_root: null, can_change_path: true })
  })

  it('refuses a relative path, which is what the real policy does with no locked root', async () => {
    const response = await upload({ path: 'uploads/hermie/notes.txt' })

    expect(response.status).toBe(400)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ detail: 'Path must be absolute' })
  })

  it('refuses a path that climbs out of wherever it was aimed', async () => {
    const response = await upload({ path: '/workspace/uploads/../../etc/passwd' })

    expect(response.status).toBe(400)
  })

  it('answers 413 past the 100 MB cap', async () => {
    // One byte over. Built as a typed array so the body is bytes rather than a
    // 100 MB JavaScript string.
    const response = await upload({
      path: '/workspace/uploads/huge.bin',
      body: new Uint8Array(100 * 1024 * 1024 + 1)
    })

    expect(response.status).toBe(413)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ detail: 'File is too large' })
  })

  it('honours overwrite: false for a path it already has', async () => {
    const path = '/workspace/uploads/twice.txt'

    expect((await upload({ path })).status).toBe(200)
    expect((await upload({ path, overwrite: 'false' })).status).toBe(409)
    expect((await upload({ path, overwrite: 'true' })).status).toBe(200)
  })
})

describe('the agent reads the file the prompt references', () => {
  it('names the uploaded file back, end to end', async () => {
    const path = '/workspace/uploads/hermie/2026-09-19/deadbeef-report.csv'

    expect((await upload({ path, filename: 'report.csv', body: 'a,b,c' })).status).toBe(200)

    const sessionId = await resumeChat('researcher')

    await call('prompt.submit', {
      session_id: sessionId,
      profile: 'researcher',
      text: `Summarise this please.\n\n@file:${path}`
    })

    const text = await completedText(sessionId)

    expect(text).toContain('report.csv')
    expect(text).toContain(path)
    expect(text).toContain('5 bytes')
  })

  it('says nothing about a path nothing uploaded', async () => {
    const sessionId = await resumeChat('researcher')

    await call('prompt.submit', {
      session_id: sessionId,
      profile: 'researcher',
      text: 'Summarise this please.\n\n@file:/workspace/uploads/never-arrived.csv'
    })

    expect(await completedText(sessionId)).not.toContain('I received')
  })

  it('reads a backtick-wrapped path, which is how a name with a space travels', async () => {
    const path = '/workspace/uploads/hermie/2026-09-19/cafe0001-my notes.txt'

    expect((await upload({ path, filename: 'my notes.txt' })).status).toBe(200)

    const sessionId = await resumeChat('writer')

    await call('prompt.submit', {
      session_id: sessionId,
      profile: 'writer',
      text: `Read this.\n\n@file:\`${path}\``
    })

    expect(await completedText(sessionId)).toContain('my notes.txt')
  })
})

/*
  `image.attach_bytes`, the socket road an image takes, with the refusals
  `tui_gateway/methods_prompt.py` answers: a client that sends an image the
  gateway would refuse has to see the refusal here too, or a test of it passes
  against the fake and fails against the real thing.
*/
describe('image.attach_bytes', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')

  async function attach(params: Record<string, unknown>): Promise<string> {
    const sessionId = await resumeChat('researcher')

    try {
      await call('image.attach_bytes', { session_id: sessionId, profile: 'researcher', ...params })

      return 'attached'
    } catch (error) {
      return (error as Error).message
    }
  }

  it('takes an image by its name, or by its bytes when it has none', async () => {
    expect(await attach({ content_base64: PNG, filename: 'shot.png' })).toBe('attached')
    expect(await attach({ content_base64: `data:image/png;base64,${PNG}` })).toBe('attached')
    expect(gateway.state.attachedImages.map(image => image.bytes)).toEqual([12, 12])
  })

  it('refuses an extension the gateway does not take as an image', async () => {
    expect(await attach({ content_base64: PNG, filename: 'IMG_0001.heic' })).toContain(
      'unsupported image extension: .heic'
    )
  })

  it('refuses a payload that is not base64, and an empty one', async () => {
    expect(await attach({ content_base64: 'not base64!', filename: 'a.png' })).toContain('4017')
    expect(await attach({ content_base64: '', filename: 'a.png' })).toContain('4015')
  })

  it('refuses an image over the 25 MB cap', async () => {
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64')

    expect(await attach({ content_base64: huge, filename: 'huge.png' })).toContain('cap is 25 MB')
  })
})
