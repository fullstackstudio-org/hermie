/**
 * How the page asks for the files a bot shared (`contract/outbox/`): the address (the attachment's own url, joined
 * onto the gateway's base, with the chat's profile), the fetch that carries the reader's credential where an
 * element cannot, and the PDF that is opened from bytes the page has checked.
 */
import { describe, expect, it, vi } from 'vitest'

import { sharedFile } from '../../test-support/outbox-fixtures'
import { createOutboxFiles, OutboxError, openPdf, outboxHref } from './outbox-files'

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

describe('openPdf', () => {
  const filesOf = (body: string | null, status = 200) =>
    createOutboxFiles({
      headers: () => Promise.resolve({}),
      gated: true,
      fetchImpl: vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
    })
  const tab = () => ({ opener: {} as unknown, location: { href: '' }, close: vi.fn() })

  it('opens the tab in the press, cuts it off, and sends it to a blob of the PDF once the bytes are one', async () => {
    const target = tab()
    const open = vi.fn(() => target as unknown as Window)
    const make = vi.fn(() => 'blob:https://gateway.test/1')
    const created: unknown[] = []

    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => (created.push(blob), make()),
        revokeObjectURL: vi.fn()
      })
    )

    const result = await openPdf(filesOf('%PDF-1.7 body'), `${BASE}/x`, {
      open: open as unknown as typeof window.open,
      revoke: vi.fn()
    })

    expect(result).toBe('opened')
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(target.opener).toBeNull()
    expect(target.location.href).toBe('blob:https://gateway.test/1')
    expect((created[0] as Blob).type).toBe('application/pdf')
    vi.unstubAllGlobals()
  })

  it('opens nothing when the file is not a PDF, and closes the tab it opened', async () => {
    const target = tab()

    expect(
      await openPdf(filesOf('<html>'), `${BASE}/x`, { open: (() => target) as unknown as typeof window.open })
    ).toBe('not-a-pdf')
    expect(target.close).toHaveBeenCalled()
    expect(target.location.href).toBe('')
  })

  it('says the browser blocked the tab, before it fetches anything', async () => {
    const fetchImpl = vi.fn()
    const files = createOutboxFiles({
      headers: () => Promise.resolve({}),
      gated: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(await openPdf(files, `${BASE}/x`, { open: (() => null) as unknown as typeof window.open })).toBe('blocked')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('closes the tab and passes the failure on when the file is gone', async () => {
    const target = tab()

    await expect(
      openPdf(filesOf('nope', 404), `${BASE}/x`, { open: (() => target) as unknown as typeof window.open })
    ).rejects.toMatchObject({ reason: 'missing' })
    expect(target.close).toHaveBeenCalled()
  })
})
