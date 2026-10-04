/**
 * How the page asks for the files a bot shared (`contract/outbox/`): the address (the attachment's own url, joined
 * onto the gateway's base, with the chat's profile), the fetch that carries the reader's credential where an
 * element cannot (held in memory no further than the cap, whether or not the gateway announced a size), and the
 * type an element is given the bytes under.
 */
import { describe, expect, it, vi } from 'vitest'

import { sharedFile } from '../../test-support/outbox-fixtures'
import { blobFor, createOutboxFiles, OutboxError, outboxHref } from './outbox-files'

const BASE = 'https://gateway.test'
const file = sharedFile('audio', 'tts_20261004_225730_989324.mp3')

describe('outboxHref', () => {
  it('joins the url onto the gateway and adds the profile, like every per-profile route', () => {
    expect(outboxHref(file, BASE, 'researcher')).toBe(`${BASE}${file.url}?profile=researcher`)
  })

  it('stays under the base path of a gateway behind a prefix', () => {
    expect(outboxHref(file, `${BASE}/hermes/`, 'default')).toBe(`${BASE}/hermes${file.url}?profile=default`)
  })

  it('percent-encodes the profile and leaves the name encoded as the gateway wrote it', () => {
    const spaced = sharedFile('file', 'Q3 report.html')

    expect(outboxHref(spaced, BASE, 'a b')).toBe(`${BASE}${spaced.url}?profile=a%20b`)
    expect(spaced.url.endsWith('/Q3%20report.html')).toBe(true)
  })

  it('asks for the dashboard’s own profile when the chat names none', () => {
    expect(outboxHref(file, BASE)).toBe(`${BASE}${file.url}`)
  })

  it.each([
    ['another host', 'https://evil.test/api/files/outbox/x/y.mp3'],
    ['a protocol-relative address', '//evil.test/api/files/outbox/x/y.mp3'],
    ['a javascript: address', 'javascript:alert(1)'],
    ['a data: address', 'data:text/html,<script>alert(1)</script>'],
    ['a path that climbs', '/api/files/outbox/x/../../../etc/passwd'],
    ['a path with a backslash', '/api/files/outbox/x\\y.mp3'],
    ['credentials in the address', 'https://user:pass@gateway.test/api/files/outbox/x/y.mp3']
  ])('refuses %s', (_what, url) => {
    expect(outboxHref({ url }, BASE, 'default')).toBeNull()
  })

  it('has nothing to resolve a path against without a gateway', () => {
    expect(outboxHref(file, undefined, 'default')).toBeNull()
  })
})

const answer = (status: number, body = 'bytes', headers: Record<string, string> = {}) =>
  vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(status === 204 ? null : body, { status, headers })
  )

describe('createOutboxFiles', () => {
  const make = (fetchImpl: ReturnType<typeof answer>, gated = false) =>
    createOutboxFiles({
      headers: () => Promise.resolve<Record<string, string>>(gated ? {} : { 'x-hermes-session-token': 'tok' }),
      gated,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

  it('loads an address as it is only with the cookie session', () => {
    expect(make(answer(200), true).direct).toBe(true)
    expect(make(answer(200), false).direct).toBe(false)
  })

  it('asks with the reader’s credential, for this origin only, and follows no redirect', async () => {
    const fetchImpl = answer(200, 'hello')
    const bytes = await make(fetchImpl).fetch(`${BASE}/x`)

    expect(await bytes.text()).toBe('hello')
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/x`, {
      method: 'GET',
      headers: { 'x-hermes-session-token': 'tok' },
      credentials: 'same-origin',
      redirect: 'manual'
    })
  })

  it('does not put the token on the address', async () => {
    const fetchImpl = answer(200)

    await make(fetchImpl).fetch(`${BASE}/x?profile=default`)

    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('token')
  })

  it.each([
    [404, 'missing'],
    [401, 'refused'],
    [416, 'refused'],
    [500, 'refused']
  ])('names a %i answer %s', async (status, reason) => {
    await expect(make(answer(status)).fetch(`${BASE}/x`)).rejects.toMatchObject({ name: 'OutboxError', reason })
  })

  it('refuses a redirect instead of following it with the credential', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }))

    await expect(make(redirect as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`)).rejects.toMatchObject({
      reason: 'refused'
    })
  })

  it('says it could not reach the gateway when the request does not complete', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('network down')
    })

    await expect(make(down as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`)).rejects.toMatchObject({
      reason: 'unreachable'
    })
  })

  it('does not read a file past the limit it was given when the gateway announces its size', async () => {
    const big = answer(200, 'x', { 'content-length': '5000' })

    await expect(make(big).fetch(`${BASE}/x`, { maxBytes: 1000 })).rejects.toMatchObject({ reason: 'too-large' })
    await expect(make(big).fetch(`${BASE}/x`, { maxBytes: 10_000 })).resolves.toMatchObject({ size: 1 })
  })

  /** A body that streams `chunks` of `size` bytes and records how many it was asked for (no Content-Length). */
  const streaming = (chunks: number, size: number) => {
    const pulled = { count: 0, cancelled: false }
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.count >= chunks) {
          controller.close()

          return
        }

        pulled.count += 1
        controller.enqueue(new Uint8Array(size))
      },
      cancel() {
        pulled.cancelled = true
      }
    })

    return { pulled, fetchImpl: vi.fn(async () => new Response(body, { status: 200 })) }
  }

  it('stops reading a file with no Content-Length once it is past the limit, and reads no more', async () => {
    const { pulled, fetchImpl } = streaming(1000, 1000)

    await expect(
      make(fetchImpl as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`, { maxBytes: 2500 })
    ).rejects.toMatchObject({ name: 'OutboxError', reason: 'too-large' })
    // Three chunks make 3000 bytes: past the cap at the third, so far fewer than the thousand on offer were pulled.
    expect(pulled.count).toBeLessThan(10)
    expect(pulled.cancelled).toBe(true)
  })

  it('stops a body that is larger than the Content-Length it announced', async () => {
    const { fetchImpl } = streaming(100, 100)
    const lying = vi.fn(async () => {
      const response = await fetchImpl()

      return new Response(response.body, { status: 200, headers: { 'content-length': '10' } })
    })

    await expect(
      make(lying as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`, { maxBytes: 1000 })
    ).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('holds a file with no Content-Length that is within the limit, whole and with the type it came with', async () => {
    const { fetchImpl } = streaming(4, 250)
    const typed = vi.fn(async () => {
      const response = await fetchImpl()

      return new Response(response.body, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const bytes = await make(typed as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`, { maxBytes: 1000 })

    expect(bytes.size).toBe(1000)
    expect(bytes.type).toBe('image/png')
  })

  it('reports a body that breaks off as unreachable', async () => {
    const broken = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new TypeError('connection reset'))
            }
          }),
          { status: 200 }
        )
    )

    await expect(
      make(broken as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`, { maxBytes: 1000 })
    ).rejects.toMatchObject({ reason: 'unreachable' })
  })

  it('stops when told to', async () => {
    const controller = new AbortController()
    const waits = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'))

          // As a real `fetch` does: an already-aborted signal rejects at once.
          if (init?.signal?.aborted) {
            abort()
          } else {
            init?.signal?.addEventListener('abort', abort)
          }
        })
    )

    const pending = make(waits as unknown as ReturnType<typeof answer>).fetch(`${BASE}/x`, {
      signal: controller.signal
    })

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(OutboxError)
  })
})

describe('blobFor, the type an element is given the bytes under', () => {
  const typed = (type: string) => new Blob(['bytes'], { type })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])(
    'keeps %s for a picture',
    type => {
      expect(blobFor('image', typed(type)).type).toBe(type)
    }
  )

  it('keeps the type of a picture without its parameters and in lower case', () => {
    expect(blobFor('image', typed('Image/PNG; charset=binary')).type).toBe('image/png')
  })

  it.each([
    ['a hostile SVG', 'image/svg+xml'],
    ['an HTML answer', 'text/html'],
    ['an HTML answer with a charset', 'text/html; charset=utf-8'],
    ['plain text', 'text/plain'],
    ['a script', 'application/javascript'],
    ['a video', 'video/mp4'],
    ['a type that only starts like an image', 'image/pngx'],
    ['a type that has the image type inside it', 'text/html;x=image/png'],
    ['no type', '']
  ])('gives a picture opaque bytes when the answer was %s', (_what, type) => {
    expect(blobFor('image', typed(type)).type).toBe('application/octet-stream')
  })

  it.each(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'])('keeps %s for a video', type => {
    expect(blobFor('video', typed(type)).type).toBe(type)
  })

  it.each(['image/png', 'image/svg+xml', 'text/html', 'audio/mpeg', 'application/octet-stream', ''])(
    'gives a video opaque bytes when the answer was %j',
    type => {
      expect(blobFor('video', typed(type)).type).toBe('application/octet-stream')
    }
  )

  it.each(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-m4a'])('keeps %s for a sound', type => {
    expect(blobFor('audio', typed(type)).type).toBe(type)
  })

  it.each(['video/mp4', 'image/svg+xml', 'text/html', 'text/plain', ''])(
    'gives a sound opaque bytes when the answer was %j',
    type => {
      expect(blobFor('audio', typed(type)).type).toBe('application/octet-stream')
    }
  )

  it.each(['pdf', 'file'] as const)('never types a %s as anything but opaque bytes', kind => {
    expect(blobFor(kind, typed('application/pdf')).type).toBe('application/octet-stream')
    expect(blobFor(kind, typed('text/html')).type).toBe('application/octet-stream')
  })

  it('keeps the bytes', () => {
    expect(blobFor('image', typed('image/png')).size).toBe(5)
  })
})
